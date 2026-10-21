/**
 * R29b Task 3 — the LIVE half of "per-session memory reaches the fork".
 *
 * `sub-agents.md:1041` makes a fork's system prompt "Same as main session".
 * Session memory is keyed by session id, and a fork's child session is a fresh
 * id with an empty MEMORY.md, so a fork's prompt was the parent's minus that
 * block.
 *
 * A correction to the plan and to R29a's close-out, which both located this at
 * `getSystemPrompt` → `loadMemoryPromptBlock`: that block is gated on
 * `capabilityContextPinned`, which is TRUE on every normal Pi turn, so the path
 * they named is dead in production. On the live path session memory is a
 * capability-inventory record built here from `CapabilityContext`, which is why
 * the fork's parent id has to reach `toWorkspacePolicyContext` as well.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import type { CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import type { PluginStoreV2 } from '@nessy-agent/shared/plugins'
import { buildCapabilityResolutionInputsV2, type CapabilityInputsV2Deps } from '../storage-runtime'

let root: string
let workspaceRoot: string
let requested: Array<{ workspaceId: string; sessionId: string }>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'storage-runtime-fork-memory-'))
  workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  requested = []
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function deps(): CapabilityInputsV2Deps {
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
    resolveSessionMemoryFilePath: (workspaceId: string, sessionId: string) => {
      requested.push({ workspaceId, sessionId })
      return join(root, 'sessions', workspaceId, sessionId, 'data', 'MEMORY.md')
    },
    pluginStore: {
      readInstalledRegistry: async () => ({ schemaVersion: 2, updatedAt: 1, active: {}, plugins: [] }),
      cachePathFor: () => join(root, 'cache'),
      acquireInstanceLease: () => () => {},
    } as unknown as PluginStoreV2,
    policyStore: new CapabilityPolicyStore({
      globalPath: join(root, 'config', 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    }),
    trustStore: { resolve: () => 'trusted' } as unknown as CapabilityInputsV2Deps['trustStore'],
    credentialBackend: {
      bind: () => { throw new Error('unexpected credential bind') },
      getRuntimeCredentialStatus: () => ({ state: 'missing', revision: 0 }),
    } as CapabilityInputsV2Deps['credentialBackend'],
  }
}

function context(over: Partial<CapabilityContext>): CapabilityContext {
  return {
    workspaceId: 'ws_a',
    sessionId: 'child-session',
    provider: 'pi',
    projectTrustState: 'none',
    projectTrustRevision: '',
    ...over,
  }
}

describe('session memory is resolved for the fork parent and for nobody else', () => {
  it("reads the PARENT's session memory for a fork", async () => {
    await buildCapabilityResolutionInputsV2(context({ memorySessionId: 'parent-session' }), deps())
    expect(requested).toEqual([{ workspaceId: 'ws_a', sessionId: 'parent-session' }])
  })

  it("reads the child's OWN session memory for a named subagent", async () => {
    // A named subagent never gets `memorySessionId`: it starts from its own
    // definition (`:1036`) and stays outside the parent's session scope.
    await buildCapabilityResolutionInputsV2(context({}), deps())
    expect(requested).toEqual([{ workspaceId: 'ws_a', sessionId: 'child-session' }])
  })

  it('resolves nothing for a session-less browse context', async () => {
    await buildCapabilityResolutionInputsV2(context({ sessionId: undefined, provider: undefined }), deps())
    expect(requested).toEqual([])
  })
})
