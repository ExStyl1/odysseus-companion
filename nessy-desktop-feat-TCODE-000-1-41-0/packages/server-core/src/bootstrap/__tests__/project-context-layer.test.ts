/**
 * UA5.5 — the project context layer's WIRING: the session's `projectId` travels from the `ManagedSession` into the
 * turn's `CapabilityContext` (`SessionManager.createCapabilityTurn`), and the capability input provider
 * (`createCapabilityResolutionInputProviderV2`) adds the ONE `instruction` record for it, which the real resolver and
 * `toAgentRuntime` carry in `promptLayers` — the list `BaseAgent`'s pinned block reads for Pi, Claude and codex alike.
 * The layer's own contract (formatter, ledger digest, tamper re-render, the three-runtime delivery) is pinned in
 * `packages/shared/src/projects/__tests__/project-entity-layer.test.ts`.
 *
 * Edit timing is MEASURED here (spec §12: "Whether an edit reaches the next turn or only a new session is
 * measured"): a project edit re-mirrors `context.md`, the next resolve carries the new bytes' hash, and the capability
 * generation — which the pinned block is keyed to — moves, so the next turn re-sends the block. Context is therefore
 * not pinned per session, and upstream's drift notice is not ported.
 *
 * Real files, the real input builder and the real resolver; the ledger key is injected (never the machine's store).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolver,
  type EffectiveCapabilitySnapshot,
} from '@nessy-agent/shared/capabilities/resolver'
import { toAgentRuntime } from '@nessy-agent/shared/capabilities/views'
import type { PluginStoreV2 } from '@nessy-agent/shared/plugins'
import { createProject, setProjectConfigWrittenHook, updateProject } from '@nessy-agent/shared/projects'
import {
  PROJECT_CONTEXT_LOGICAL_NAME,
  getProjectContextPath,
  installProjectContextMirror,
  projectContextMirrorIdle,
  renderProjectContext,
} from '@nessy-agent/shared/projects/project-context'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform } from '../../sessions/SessionManager'
import { createTestCapabilityResolver, createTestSessionManager } from '../../sessions/__tests__/test-session-manager'
import { createCapabilityResolutionInputProviderV2, type CapabilityInputsV2Deps } from '../storage-runtime'

setSessionPlatform(createHeadlessPlatform())

const WORKSPACE_ID = 'ws_ua55'
let root: string
let workspaceRoot: string
let keyProvider: HostApprovalsKeyProvider

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-context-layer-'))
  workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  const key = randomBytes(32)
  keyProvider = { getKey: async () => key }
  installProjectContextMirror({ keyProvider: () => keyProvider, log: () => undefined })
})

afterEach(async () => {
  await projectContextMirrorIdle()
  setProjectConfigWrittenHook(null)
  rmSync(root, { recursive: true, force: true })
})

function deps(over: Partial<CapabilityInputsV2Deps> = {}): CapabilityInputsV2Deps {
  return {
    resolveWorkspaceRootPath: () => workspaceRoot,
    nativeSourcesEnv: {
      // P2.455 / P2.461 — `[]` is "no administrator tier", so this rig cannot read the machine's real roots.
      adminSkillsDirs: [],
      configDir: join(root, 'config'),
      homeAgentsSkillsDir: join(root, 'agents', 'skills'),
    },
    resolveSessionMemoryFilePath: (workspaceId: string, sessionId: string) =>
      join(root, 'sessions', workspaceId, sessionId, 'data', 'MEMORY.md'),
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
    safeModeEnv: {},
    projectContextKeyProvider: keyProvider,
    ...over,
  }
}

function context(over: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    workspaceId: WORKSPACE_ID,
    sessionId: 'session-a',
    provider: 'pi',
    projectTrustState: 'none',
    projectTrustRevision: '',
    ...over,
  }
}

const isProjectLayer = (key: string): boolean => key.endsWith(`::${PROJECT_CONTEXT_LOGICAL_NAME}`)

async function resolveView(ctx: CapabilityContext, over: Partial<CapabilityInputsV2Deps> = {}) {
  const resolver = createCapabilityResolver({ inputs: createCapabilityResolutionInputProviderV2(deps(over)) })
  const snapshot = await resolver.resolve(ctx)
  const view = toAgentRuntime(snapshot)
  resolver.releaseSnapshot(snapshot.leaseId)
  return { generation: snapshot.generation, layers: view.promptLayers.filter(layer => isProjectLayer(layer.key)) }
}

async function project(name: string, details?: string) {
  const config = createProject(workspaceRoot, { name, ...(details ? { details } : {}) })
  await projectContextMirrorIdle()
  return config
}

describe('UA5.5 · the input provider binds the session project\'s context.md as one instruction layer', () => {
  it('POSITIVE: a bound session gets exactly one project layer, over the host-written render, on every runtime', async () => {
    const config = await project('Acme', 'Use Bun.')
    for (const provider of ['pi', 'anthropic', 'codex-runtime'] as const) {
      const { layers } = await resolveView(context({ provider, projectId: config.id }))
      expect(layers).toHaveLength(1)
      const resource = layers[0]!.resource as { absolutePath: string }
      expect(resource.absolutePath).toBe(getProjectContextPath(workspaceRoot, config.slug))
      expect(readFileSync(resource.absolutePath, 'utf-8')).toBe(renderProjectContext(workspaceRoot, config))
    }
  })

  it('NEGATIVE: no projectId (no project, or a browse resolve) → no project layer', async () => {
    await project('Acme')
    expect((await resolveView(context())).layers).toEqual([])
    expect((await resolveView(context({ provider: undefined, sessionId: undefined }))).layers).toEqual([])
  })

  it('NEGATIVE: under safe mode the layer is not added, as no native instruction file is', async () => {
    const config = await project('Acme')
    expect((await resolveView(context({ projectId: config.id }), { safeModeEnv: { NESSY_SAFE_MODE: '1' } })).layers).toEqual([])
  })

  it('NEGATIVE: an id this workspace does not hold costs the layer, not the turn', async () => {
    await project('Acme')
    expect((await resolveView(context({ projectId: 'proj_deadbeef' }))).layers).toEqual([])
  })

  it('MEASURE (edit timing): an edit reaches the NEXT resolve — new bytes, new hash, new capability generation', async () => {
    const config = await project('Acme', 'first')
    const before = await resolveView(context({ projectId: config.id }))
    updateProject(workspaceRoot, config.slug, { details: 'second' })
    const after = await resolveView(context({ projectId: config.id }))
    expect(after.layers[0]!.resource.contentHash).not.toBe(before.layers[0]!.resource.contentHash)
    expect(after.generation).not.toBe(before.generation)
    expect(readFileSync((after.layers[0]!.resource as { absolutePath: string }).absolutePath, 'utf-8')).toContain('second')
  })

  it('BOUNDARY (rebind): after the session moves to another project, the next resolve carries that project\'s layer', async () => {
    const a = await project('Alpha', 'alpha details')
    const b = await project('Beta', 'beta details')
    const first = await resolveView(context({ projectId: a.id }))
    const second = await resolveView(context({ projectId: b.id }))
    expect((first.layers[0]!.resource as { absolutePath: string }).absolutePath).toBe(getProjectContextPath(workspaceRoot, a.slug))
    expect((second.layers[0]!.resource as { absolutePath: string }).absolutePath).toBe(getProjectContextPath(workspaceRoot, b.slug))
    expect(second.generation).not.toBe(first.generation)
  })
})

describe('UA5.5 · SessionManager.createCapabilityTurn carries the session\'s projectId into the turn context', () => {
  async function capturedContext(projectId?: string): Promise<CapabilityContext> {
    const inner = createTestCapabilityResolver()
    let seen: CapabilityContext | undefined
    const resolver: CapabilityResolver = {
      ...inner,
      resolve: async (ctx: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
        seen = ctx
        return inner.resolve(ctx)
      },
    }
    const manager = createTestSessionManager({ resolver })
    const managed = createManagedSession({ id: 'session-a', ...(projectId ? { projectId } : {}) }, {
      id: WORKSPACE_ID,
      name: 'Workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true })
    managed.activeProvider = 'pi'
    const internals = manager as unknown as {
      createCapabilityTurn(managed: unknown): Promise<unknown>
      cleanup(): void
    }
    try {
      await internals.createCapabilityTurn(managed)
    } finally {
      internals.cleanup()
    }
    return seen!
  }

  it('POSITIVE: a project-bound session resolves with its projectId', async () => {
    expect((await capturedContext('proj_0123abcd')).projectId).toBe('proj_0123abcd')
  })

  it('NEGATIVE: a session with no project resolves with none', async () => {
    expect('projectId' in (await capturedContext())).toBe(false)
  })
})
