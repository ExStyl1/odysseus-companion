import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ConfigWatcher } from '@nessy-agent/shared/config'
import { resolveBackendContext } from '@nessy-agent/shared/agent/backend'
import { loadWorkspaceConfig } from '@nessy-agent/shared/workspaces'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'
import { buildRestartRequiredSignature } from './runtime-config.ts'

// Regression coverage for the stale-Pi-subprocess bug where toggling
// `supportsImages` on a custom-endpoint model wrote to disk but never reached
// the live agent.
//
// Two failure modes are guarded here:
//   1. `getOrCreateAgent` deferred refresh whenever `managed.isProcessing` was
//      true, but `sendMessage` flips that flag *before* calling
//      `getOrCreateAgent` — which made the refresh branch dead code on the
//      send path. The new gate uses only `agent.isProcessing()`.
//   2. Saving a connection had no notification path to active sessions, so
//      capability changes only propagated lazily after the next send.
//      `refreshConnectionRuntime` now pushes updates from the SAVE handler.

interface AgentStub {
  isProcessing: () => boolean
  updateRuntimeConfig: jest.Mock
  setAutomationSystem: (value: unknown) => void
  setCapabilityTurnRuntime: (value: unknown) => void
  drainAutomationEvents: () => Promise<void>
  endLifecycle: () => Promise<void>
  forceAbort: (reason: unknown) => void
  dispose: () => void
  disposeForRestart?: () => Promise<void>
}

type RuntimeManagedSession = {
  agent: AgentStub | null
  isProcessing: boolean
  messageQueue: Array<{ message: string; messageId?: string }>
  pendingPluginRuntimeRefreshReason?: string
}

function createAgentStub(opts: {
  isProcessing?: boolean
  refreshSucceeds?: boolean
  refreshDelayMs?: number
} = {}): AgentStub {
  const delay = opts.refreshDelayMs ?? 0
  const result = opts.refreshSucceeds ?? true
  return {
    isProcessing: () => opts.isProcessing ?? false,
    updateRuntimeConfig: jest.fn().mockImplementation(async () => {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      return result
    }),
    setAutomationSystem: () => {},
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {},
    endLifecycle: async () => {},
    forceAbort: () => {},
    dispose: () => { /* no-op for tests */ },
  }
}

function injectSession(
  sm: SessionManager,
  id: string,
  workspaceRoot: string,
  llmConnection: string,
  agent: AgentStub | null,
  opts: { backendRuntimeSignature?: string; backendRestartSignature?: string; isProcessing?: boolean } = {},
) {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id, name: id, llmConnection },
    workspace as never,
    { messagesLoaded: true },
  ) as unknown as { agent: AgentStub | null; backendRuntimeSignature?: string; backendRestartSignature?: string; isProcessing: boolean; llmConnection?: string }
  managed.agent = agent
  // Force a stale runtime signature so the helper's comparison always reaches
  // the refresh branch — the signature it computes from real disk config will
  // never equal this sentinel.
  managed.backendRuntimeSignature = opts.backendRuntimeSignature ?? '__stale_runtime_signature_for_test__'
  // Pre-compute the restart signature against the same resolution the helper
  // will use, so by default tests route through the in-place refresh path.
  // Tests that want the restart-required path pass an explicit sentinel.
  if (opts.backendRestartSignature !== undefined) {
    managed.backendRestartSignature = opts.backendRestartSignature
  } else {
    const workspaceConfig = loadWorkspaceConfig(workspaceRoot)
    const ctx = resolveBackendContext({
      sessionConnectionSlug: llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
    })
    managed.backendRestartSignature = buildRestartRequiredSignature({
      connection: ctx.connection,
      provider: ctx.provider,
      authType: ctx.authType,
      resolvedModel: ctx.resolvedModel,
    })
  }
  managed.isProcessing = opts.isProcessing ?? false
  managed.llmConnection = llmConnection
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${(managed as unknown as { workspace: { id: string } }).workspace.id}:${id}`, managed)
  return managed
}

describe('refreshConnectionRuntime', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-refresh-'))
    sm = createTestSessionManager()
  })

  afterEach(() => {
    sm.cleanup()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('pushes updateRuntimeConfig to sessions on the matching connection slug', async () => {
    const matchingAgent = createAgentStub()
    const otherAgent = createAgentStub()
    injectSession(sm, 'matching', tmpRoot, 'slug-A', matchingAgent)
    injectSession(sm, 'other', tmpRoot, 'slug-B', otherAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(matchingAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(otherAgent.updateRuntimeConfig).not.toHaveBeenCalled()
  })

  it('skips sessions whose agent is mid-stream (defers, does not yank)', async () => {
    const busyAgent = createAgentStub({ isProcessing: true })
    injectSession(sm, 'busy', tmpRoot, 'slug-A', busyAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(busyAgent.updateRuntimeConfig).not.toHaveBeenCalled()
  })

  it('does not defer just because managed.isProcessing is true (Fix 1 regression)', async () => {
    // sendMessage flips managed.isProcessing=true *before* calling
    // getOrCreateAgent → tryRefreshAgentRuntime. The pre-fix gate
    // `managed.isProcessing || agent.isProcessing()` was therefore always true
    // on the send path, making the refresh branch dead code. The fix narrows
    // the gate to `agent.isProcessing()` only — which is what actually means
    // "an in-flight stream we shouldn't yank."
    const idleAgent = createAgentStub({ isProcessing: false })
    injectSession(sm, 'sending', tmpRoot, 'slug-A', idleAgent, { isProcessing: true })

    await sm.refreshConnectionRuntime('slug-A')

    expect(idleAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when there is no agent yet (cold session)', async () => {
    injectSession(sm, 'cold', tmpRoot, 'slug-A', null)

    await expect(sm.refreshConnectionRuntime('slug-A')).resolves.toBeUndefined()
  })

  it('disposes the runtime when in-place refresh fails so the next send rebuilds it', async () => {
    const failingAgent = createAgentStub({ refreshSucceeds: false })
    const managed = injectSession(sm, 'failing', tmpRoot, 'slug-A', failingAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(failingAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })

  it('skips in-place refresh and forces recreation when a restart-required field changed', async () => {
    // `update_runtime_config` cannot propagate `piAuthProvider`, slug,
    // providerType, or authType cleanly. When any of those drift, the helper
    // must dispose the runtime instead of marking it refreshed (which would
    // record the new signature against a stale subprocess).
    const agent = createAgentStub()
    const managed = injectSession(sm, 'auth-changed', tmpRoot, 'slug-A', agent, {
      backendRestartSignature: '__stale_restart_signature__',
    })

    await sm.refreshConnectionRuntime('slug-A')

    expect(agent.updateRuntimeConfig).not.toHaveBeenCalled()
    expect(managed.agent).toBeNull()
  })

  it('serializes concurrent refresh requests via the per-session mutex', async () => {
    // SAVE handler is fire-and-forget (Finding 1) so its refresh can be
    // mid-flight when sendMessage triggers another via getOrCreateAgent.
    // Without a mutex, both fire updateRuntimeConfig and the subprocess can
    // race a chat against the still-pending update.
    //
    // The first call holds the lock long enough for the second to see it,
    // wait, and re-evaluate from the post-refresh state — at which point the
    // signature matches and the second call is a no-op.
    const agent = createAgentStub({ refreshDelayMs: 50 })
    injectSession(sm, 'concurrent', tmpRoot, 'slug-A', agent)

    const [first, second] = await Promise.all([
      sm.refreshConnectionRuntime('slug-A'),
      sm.refreshConnectionRuntime('slug-A'),
    ])

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    // Only one updateRuntimeConfig — the second call awaited the first via
    // the mutex, then saw matching signatures and bailed.
    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
  })

  it('records customModels with the per-model supportsImages flag in the IPC payload', async () => {
    // End-to-end shape check: when the session's connection resolves to a
    // pi_compat connection with explicit per-model `supportsImages`, the
    // helper must forward that field on `customModels` so the Pi subprocess
    // can re-register the model with `input: ['text', 'image']`.
    const agent = createAgentStub()
    const managed = injectSession(sm, 'shape-check', tmpRoot, 'slug-A', agent)

    await (sm as unknown as {
      runAgentRuntimeRefresh: (
        managed: unknown,
        backendContext: unknown,
        runtimeSignature: string,
        restartSignature: string,
        restartRequired: boolean,
        reason: string,
      ) => Promise<void>
    }).runAgentRuntimeRefresh(
      managed,
      {
        connection: {
          slug: 'slug-A',
          name: 'Vision endpoint',
          providerType: 'pi_compat',
          authType: 'api_key_with_endpoint',
          createdAt: Date.now(),
          baseUrl: 'http://localhost:8085',
          piAuthProvider: 'openai',
          customEndpoint: { api: 'openai-completions' },
          models: [
            { id: 'vision-model', supportsImages: true },
          ],
        },
        provider: 'pi',
        authType: 'api_key_with_endpoint',
        resolvedModel: 'vision-model',
        capabilities: {},
      },
      '__runtime_signature_after_shape_check__',
      '__restart_signature_after_shape_check__',
      false,
      'shape check',
    )

    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    const payload = agent.updateRuntimeConfig.mock.calls[0]?.[0]
    expect(payload).toBeDefined()
    // P2.404 — the discriminating field is asserted UNCONDITIONALLY, and the
    // envelope check is written out field by field rather than as
    // `toMatchObject` + `expect.any`. Both halves are deliberate.
    //
    // What stood here was `if (payload.runtime?.customModels) { for (…) { if
    // (typeof m === 'object') { if ('supportsImages' in m) { expect(…) } } } }` —
    // the only assertion in a case named for the flag, nested inside a condition
    // testing for that same flag. Remove `supportsImages` from this test's input
    // and the mapper collapses the entry to the bare string `'vision-model'`
    // (`SessionManager.runAgentRuntimeRefresh` returns `model.id` when neither
    // `contextWindow` nor `supportsImages` is set), every `expect` is skipped,
    // and the case passes while asserting nothing about the thing it is named
    // for. An assertion inside its own condition cannot fail.
    //
    // The measurement that made this worse than the report: those assertions
    // never ran AT ALL, flag present or not. On bun 1.3.14
    // `expect(x).toMatchObject({ k: expect.any(T) })` OVERWRITES the matched
    // properties of the RECEIVED object with the matcher instances, so the
    // `toMatchObject({ model: expect.any(String), runtime: expect.any(Object) })`
    // that used to sit here left `payload.runtime` as `{}` and the outer `if`
    // was already false on the happy path. Positive control on the same rig: the
    // identical assertion with a LITERAL expected value does not mutate. So the
    // first input mutant moved nothing — a dead control — and the `expect()`
    // count is what showed it: 3 for this case both with and without the flag,
    // where a live assertion would have moved it.
    expect(typeof payload.model).toBe('string')
    expect(payload.runtime).toBeDefined()
    // The runtime envelope mirrors what `pi-agent.ts:requestRuntimeConfigUpdate`
    // unpacks — `customModels` must carry the per-model `supportsImages`, and an
    // entry that lost the flag would arrive as a string instead of this object.
    expect(payload.runtime.customModels).toEqual([{ id: 'vision-model', supportsImages: true }])
  })

  it('DA1.22 — the live refresh carries the catalogue samplingParams, and drops an empty one', async () => {
    // The row's whole point: `backend/internal/drivers/pi.ts` threads
    // `samplingParams` through the CONSTRUCTION mapper, and THIS file carries the
    // live-refresh twin whose own comment says "both name a capability or
    // neither does". Without the twin an operator editing a declaration
    // mid-session silently loses the params a construction-time session had, and
    // nothing fails.
    //
    // Two models in ONE call, which is what makes the second one a control
    // rather than a second test: same payload, same mapper, and only the shape
    // of `samplingParams` differs. The empty object must collapse the entry to
    // the bare id, because an empty object reads downstream as "the catalogue
    // recommended something".
    const agent = createAgentStub()
    const managed = injectSession(sm, 'sampling-params-check', tmpRoot, 'slug-A', agent)

    await (sm as unknown as {
      runAgentRuntimeRefresh: (
        managed: unknown,
        backendContext: unknown,
        runtimeSignature: string,
        restartSignature: string,
        restartRequired: boolean,
        reason: string,
      ) => Promise<void>
    }).runAgentRuntimeRefresh(
      managed,
      {
        connection: {
          slug: 'slug-A',
          name: 'Sampling endpoint',
          providerType: 'pi_compat',
          authType: 'api_key_with_endpoint',
          createdAt: Date.now(),
          baseUrl: 'http://localhost:8085',
          piAuthProvider: 'openai',
          customEndpoint: { api: 'openai-completions' },
          models: [
            { id: 'tuned-model', samplingParams: { temperature: 0.2, top_p: 0.9 } },
            { id: 'bare-model', samplingParams: {} },
          ],
        },
        provider: 'pi',
        authType: 'api_key_with_endpoint',
        resolvedModel: 'tuned-model',
        capabilities: {},
      },
      '__runtime_signature_after_sampling_check__',
      '__restart_signature_after_sampling_check__',
      false,
      'sampling params check',
    )

    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    const payload = agent.updateRuntimeConfig.mock.calls[0]?.[0]
    expect(payload).toBeDefined()
    // Asserted UNCONDITIONALLY and as a LITERAL, for P2.404's reason recorded in
    // the case above: an assertion nested inside a condition that tests for the
    // field cannot fail, and `toMatchObject` with an asymmetric matcher would
    // overwrite `payload.runtime` on this bun.
    expect(payload.runtime.customModels).toEqual([
      { id: 'tuned-model', samplingParams: { temperature: 0.2, top_p: 0.9 } },
      'bare-model',
    ])
  })

  describe('UB12.11 — the live refresh carries the re-resolved mini model', () => {
    // The build-time expression (`getMiniModel(connection) ?? connection.defaultModel`)
    // is the one the refresh must repeat: a gateway catalogue that rotated the id
    // behind `fast` reaches a live Pi session only through this envelope.
    type RefreshConnection = Record<string, unknown>
    async function refreshPayload(id: string, connection: RefreshConnection, resolvedModel: string) {
      const agent = createAgentStub()
      const managed = injectSession(sm, id, tmpRoot, 'slug-A', agent)
      await (sm as unknown as {
        runAgentRuntimeRefresh: (
          managed: unknown,
          backendContext: unknown,
          runtimeSignature: string,
          restartSignature: string,
          restartRequired: boolean,
          reason: string,
        ) => Promise<void>
      }).runAgentRuntimeRefresh(
        managed,
        { connection, provider: 'pi', authType: 'api_key_with_endpoint', resolvedModel, capabilities: {} },
        `__runtime_signature_${id}__`,
        `__restart_signature_${id}__`,
        false,
        id,
      )
      expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
      return agent.updateRuntimeConfig.mock.calls[0]?.[0]
    }
    const endpoint = {
      slug: 'slug-A',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      createdAt: 1,
      baseUrl: 'http://localhost:8085',
      piAuthProvider: 'openai',
      customEndpoint: { api: 'openai-completions' },
    }

    it('POSITIVE: after the gateway rotates `fast`, the update names the new fast id, not the coder model', async () => {
      const payload = await refreshPayload('ub1211-gateway', {
        ...endpoint,
        name: 'Gateway-shaped catalogue',
        defaultModel: 'tgpt/coder-current',
        models: [
          { id: 'tgpt/coder-current', name: 'Coder', shortName: 'coder' },
          { id: 'tgpt/fast-current', name: 'Fast', shortName: 'fast' },
        ],
      }, 'tgpt/coder-current')
      expect(payload.miniModel).toBe('tgpt/fast-current')
    })

    it('NEGATIVE: a non-gateway connection keeps its own utility model (the explicit choice, not the session model)', async () => {
      const payload = await refreshPayload('ub1211-byo', {
        ...endpoint,
        name: 'BYO endpoint',
        defaultModel: 'local-big',
        miniModel: 'local-small',
        models: [{ id: 'local-big', name: 'Big' }, { id: 'local-small', name: 'Small' }],
      }, 'local-big')
      expect(payload.miniModel).toBe('local-small')
    })
  })

  describe('UB12.38 — a Utility-model-only SAVE reaches the live session', () => {
    // The SAVE handler's path end to end on the host: the connection is stored
    // on disk (the isolated config dir), the first refresh records the live
    // session's signatures, the edit goes through `updateLlmConnection` exactly
    // as `llmConnections.SAVE` writes it, and `refreshConnectionRuntime` is the
    // handler's own push. Before the fix the signature hashed no mini model, so
    // the second refresh returned at "nothing drifted" and the live runtime kept
    // the old Utility model until a respawn. What happens after the update
    // reaches a Pi agent is UB12.11's pins (`pi-runtime-update-mini-model.test.ts`,
    // `mini-model-rotation-real-server.test.ts`: the next title runs on that id).
    const SLUG = 'ub1238-byo'
    let restoreConfig: () => void = () => {}

    beforeEach(async () => {
      const storage = await import('@nessy-agent/shared/config/storage')
      const configPath = storage.getConfigPath()
      const previous = existsSync(configPath) ? storage.loadStoredConfig() : null
      const base = previous ?? ({
        storageLayoutVersion: 2,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
      } as unknown as NonNullable<typeof previous>)
      storage.saveConfig({
        ...base,
        llmConnections: [
          ...(base.llmConnections ?? []).filter(c => c.slug !== SLUG),
          {
            slug: SLUG,
            name: 'UB12.38 BYO endpoint',
            providerType: 'pi_compat',
            authType: 'api_key_with_endpoint',
            createdAt: 1,
            baseUrl: 'http://localhost:8085/v1',
            piAuthProvider: 'openai',
            customEndpoint: { api: 'openai-completions' },
            defaultModel: 'local-big',
            miniModel: 'local-small',
            models: ['local-big', 'local-small', 'local-tiny'],
          },
        ],
      })
      restoreConfig = () => {
        if (previous) storage.saveConfig(previous)
        else if (existsSync(configPath)) rmSync(configPath)
      }
    })

    afterEach(() => restoreConfig())

    /** A live Pi-shaped session on SLUG whose signatures are recorded from the stored connection. */
    async function liveSession(id: string) {
      const agent = createAgentStub()
      injectSession(sm, id, tmpRoot, SLUG, agent, { backendRuntimeSignature: '' })
      await sm.refreshConnectionRuntime(SLUG)
      expect(agent.updateRuntimeConfig).not.toHaveBeenCalled()
      return agent
    }

    it('POSITIVE: editing only the Utility model pushes the new id to the live runtime', async () => {
      const { updateLlmConnection } = await import('@nessy-agent/shared/config/storage')
      const agent = await liveSession('ub1238-utility-edit')

      expect(updateLlmConnection(SLUG, { miniModel: 'local-tiny' })).toBe(true)
      await sm.refreshConnectionRuntime(SLUG)

      expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
      expect(agent.updateRuntimeConfig.mock.calls[0]?.[0]?.miniModel).toBe('local-tiny')
    })

    it('NEGATIVE: a metadata-only save (lastUsedAt) pushes nothing', async () => {
      const { updateLlmConnection } = await import('@nessy-agent/shared/config/storage')
      const agent = await liveSession('ub1238-metadata-edit')

      expect(updateLlmConnection(SLUG, { lastUsedAt: Date.now() + 60_000 })).toBe(true)
      await sm.refreshConnectionRuntime(SLUG)

      expect(agent.updateRuntimeConfig).not.toHaveBeenCalled()
    })
  })

  it('flushes deferred plugin runtime invalidation before replaying a queued turn', async () => {
    const agent = createAgentStub()
    const disposeForRestart = jest.fn(async () => {})
    agent.disposeForRestart = disposeForRestart
    const managed = injectSession(sm, 'plugin-active', tmpRoot, 'slug-A', agent, { isProcessing: true }) as unknown as RuntimeManagedSession
    managed.messageQueue.push({ message: 'queued follow-up', messageId: 'queued-1' })

    let replaySawFreshRuntime = false
    ;(sm as unknown as { processNextQueuedMessage: (sessionId: string) => void }).processNextQueuedMessage = () => {
      replaySawFreshRuntime = managed.agent === null
    }

    await (sm as unknown as { invalidateAllPluginRuntimes: (reason: string) => Promise<void> })
      .invalidateAllPluginRuntimes('plugin store change')

    expect(disposeForRestart).not.toHaveBeenCalled()
    expect(managed.pendingPluginRuntimeRefreshReason).toBe('plugin store change')

    await (sm as unknown as { onProcessingStopped: (sessionId: string, reason: 'complete') => Promise<void> })
      .onProcessingStopped('plugin-active', 'complete')

    expect(disposeForRestart).toHaveBeenCalledTimes(1)
    expect(managed.pendingPluginRuntimeRefreshReason).toBeUndefined()
    expect(replaySawFreshRuntime).toBe(true)
  })

  it('invalidates all live runtimes when user/global hooks change', async () => {
    const workspaceA = mkdtempSync(join(tmpRoot, 'workspace-a-'))
    const workspaceB = mkdtempSync(join(tmpRoot, 'workspace-b-'))
    sm.setupConfigWatcher(workspaceA, 'ws-a')
    sm.setupConfigWatcher(workspaceB, 'ws-b')

    const agentA = createAgentStub()
    const agentB = createAgentStub()
    const disposeA = jest.fn(async () => {})
    const disposeB = jest.fn(async () => {})
    agentA.disposeForRestart = disposeA
    agentB.disposeForRestart = disposeB
    const managedA = injectSession(sm, 'global-hooks-a', workspaceA, 'slug-A', agentA) as unknown as RuntimeManagedSession
    const managedB = injectSession(sm, 'global-hooks-b', workspaceB, 'slug-A', agentB) as unknown as RuntimeManagedSession

    getWatcher(sm, 'ws-a').notifyGlobalConfigFileChange('hooks.json')
    await wait(150)

    expect(disposeA).toHaveBeenCalledTimes(1)
    expect(disposeB).toHaveBeenCalledTimes(1)
    expect(managedA.agent).toBeNull()
    expect(managedB.agent).toBeNull()
  })

  it('invalidates only workspace runtimes for workspace hooks changes and defers while processing', async () => {
    const workspaceA = mkdtempSync(join(tmpRoot, 'workspace-a-'))
    const workspaceB = mkdtempSync(join(tmpRoot, 'workspace-b-'))
    sm.setupConfigWatcher(workspaceA, 'ws-a')
    sm.setupConfigWatcher(workspaceB, 'ws-b')

    const activeAgent = createAgentStub()
    const otherAgent = createAgentStub()
    const disposeActive = jest.fn(async () => {})
    const disposeOther = jest.fn(async () => {})
    activeAgent.disposeForRestart = disposeActive
    otherAgent.disposeForRestart = disposeOther
    const active = injectSession(sm, 'workspace-hooks-active', workspaceA, 'slug-A', activeAgent, { isProcessing: true }) as unknown as RuntimeManagedSession
    const other = injectSession(sm, 'workspace-hooks-other', workspaceB, 'slug-A', otherAgent) as unknown as RuntimeManagedSession
    active.messageQueue.push({ message: 'queued follow-up', messageId: 'queued-1' })

    let replaySawFreshRuntime = false
    ;(sm as unknown as { processNextQueuedMessage: (sessionId: string) => void }).processNextQueuedMessage = () => {
      replaySawFreshRuntime = active.agent === null
    }

    getWatcher(sm, 'ws-a').notifyFileChange('hooks.json')
    await wait(150)

    expect(disposeActive).not.toHaveBeenCalled()
    expect(active.pendingPluginRuntimeRefreshReason).toBe('workspace automations/hooks config change')
    expect(disposeOther).not.toHaveBeenCalled()
    expect(other.agent).toBe(otherAgent)

    await (sm as unknown as { onProcessingStopped: (sessionId: string, reason: 'complete') => Promise<void> })
      .onProcessingStopped('workspace-hooks-active', 'complete')

    expect(disposeActive).toHaveBeenCalledTimes(1)
    expect(active.pendingPluginRuntimeRefreshReason).toBeUndefined()
    expect(replaySawFreshRuntime).toBe(true)
  })

  it('refreshes plugin runtime by stable workspace id + project key, not path (W8c)', async () => {
    // W8c matcher cutover: refreshPluginRuntime keys off the immutable workspace
    // id and the resolved ProjectKey, never a user rootPath / working-directory
    // string (defect D2). A same-workspace sibling with a different project key
    // and a same-project-key session in another workspace are both skipped.
    const projectKeyA = `p_${'a'.repeat(32)}`
    const projectKeyB = `p_${'b'.repeat(32)}`

    const projectAgent = createAgentStub()
    const siblingAgent = createAgentStub()
    const otherWorkspaceAgent = createAgentStub()
    const disposeProject = jest.fn(async () => {})
    const disposeSibling = jest.fn(async () => {})
    const disposeOtherWorkspace = jest.fn(async () => {})
    projectAgent.disposeForRestart = disposeProject
    siblingAgent.disposeForRestart = disposeSibling
    otherWorkspaceAgent.disposeForRestart = disposeOtherWorkspace

    type MatcherManaged = RuntimeManagedSession & { workspace: { id: string }; projectKey?: string }
    const project = injectSession(sm, 'plugin-project', join(tmpRoot, 'ws-a'), 'slug-A', projectAgent) as unknown as MatcherManaged
    const sibling = injectSession(sm, 'plugin-sibling', join(tmpRoot, 'ws-a'), 'slug-A', siblingAgent) as unknown as MatcherManaged
    const otherWorkspace = injectSession(sm, 'plugin-other-workspace', join(tmpRoot, 'ws-b'), 'slug-A', otherWorkspaceAgent) as unknown as MatcherManaged
    project.workspace.id = 'ws_a'
    project.projectKey = projectKeyA
    sibling.workspace.id = 'ws_a'
    sibling.projectKey = projectKeyB
    otherWorkspace.workspace.id = 'ws_b'
    otherWorkspace.projectKey = projectKeyA

    await sm.refreshPluginRuntime('ws_a', projectKeyA, 'marketplace refresh')

    expect(disposeProject).toHaveBeenCalledTimes(1)
    expect(project.agent).toBeNull()
    // Same workspace, different project key → not refreshed.
    expect(disposeSibling).not.toHaveBeenCalled()
    expect(sibling.agent).toBe(siblingAgent)
    // Same project key, different workspace → not refreshed.
    expect(disposeOtherWorkspace).not.toHaveBeenCalled()
    expect(otherWorkspace.agent).toBe(otherWorkspaceAgent)
  })

  it('refreshes every session in a workspace when no project key is given (W8c)', async () => {
    const agentA = createAgentStub()
    const agentB = createAgentStub()
    const disposeA = jest.fn(async () => {})
    const disposeB = jest.fn(async () => {})
    agentA.disposeForRestart = disposeA
    agentB.disposeForRestart = disposeB

    type MatcherManaged = RuntimeManagedSession & { workspace: { id: string }; projectKey?: string }
    const a = injectSession(sm, 'ws-wide-a', join(tmpRoot, 'ws-a'), 'slug-A', agentA) as unknown as MatcherManaged
    const b = injectSession(sm, 'ws-wide-b', join(tmpRoot, 'ws-a'), 'slug-A', agentB) as unknown as MatcherManaged
    a.workspace.id = 'ws_a'
    a.projectKey = `p_${'c'.repeat(32)}`
    b.workspace.id = 'ws_a'
    b.projectKey = `p_${'d'.repeat(32)}`

    await sm.refreshPluginRuntime('ws_a', undefined, 'plugin uninstall')

    expect(disposeA).toHaveBeenCalledTimes(1)
    expect(disposeB).toHaveBeenCalledTimes(1)
  })

  /**
   * P2.107 — the refresh REPORTS what it did, per session.
   *
   * `refreshPluginRuntime` returned `void`, so the only thing a caller could do
   * to tell the user whether their plugin was live was re-derive the answer from
   * session state — and the renderer's derivation mirrored only the FIRST
   * operand of the gate this method reads
   * (`managed.isProcessing || managed.agent.isProcessing()`).
   *
   * The three counts are three genuinely different outcomes, and the middle one
   * is the only one that owes the user an affordance:
   *  - `applied`   — refreshed between turns; the plugin is live;
   *  - `deferred`  — a turn was in flight; parked until the turn boundary;
   *  - `untouched` — no runtime existed, so nothing stale is held and the next
   *                  turn builds from the mutated state.
   *
   * P6.412 added a FOURTH, `reloaded` — the runtime absorbed the change in
   * place, so the session survived. None of these stubs publishes
   * `reloadPlugins`, which is codex's and Pi's real situation, so it is `0`
   * here and the other three counts are byte-for-byte what they were.
   *
   * The BACKEND-only busy session is the case the renderer could not see at all:
   * `managed.isProcessing` is false while `agent.isProcessing()` is true.
   */
  it('reports applied/deferred/untouched per session', async () => {
    type MatcherManaged = RuntimeManagedSession & { workspace: { id: string }; projectKey?: string; isProcessing?: boolean }

    const idleAgent = createAgentStub()
    const hostBusyAgent = createAgentStub()
    const backendBusyAgent = createAgentStub()
    backendBusyAgent.isProcessing = () => true

    const idle = injectSession(sm, 'refresh-idle', join(tmpRoot, 'ws-v'), 'slug-V', idleAgent) as unknown as MatcherManaged
    const hostBusy = injectSession(sm, 'refresh-host-busy', join(tmpRoot, 'ws-v'), 'slug-V', hostBusyAgent) as unknown as MatcherManaged
    const backendBusy = injectSession(sm, 'refresh-backend-busy', join(tmpRoot, 'ws-v'), 'slug-V', backendBusyAgent) as unknown as MatcherManaged
    const cold = injectSession(sm, 'refresh-cold', join(tmpRoot, 'ws-v'), 'slug-V', createAgentStub()) as unknown as MatcherManaged
    for (const session of [idle, hostBusy, backendBusy, cold]) session.workspace.id = 'ws_verdict'
    hostBusy.isProcessing = true
    cold.agent = null

    const summary = await sm.refreshPluginRuntime('ws_verdict', undefined, 'marketplace install')

    expect(summary).toEqual({ applied: 1, deferred: 2, untouched: 1, reloaded: 0 })
    // The verdict is not a bookkeeping side-channel: the deferrals really were
    // parked, and the applied one really was torn down.
    expect(idle.agent).toBeNull()
    expect(hostBusy.pendingPluginRuntimeRefreshReason).toBe('marketplace install')
    expect(backendBusy.pendingPluginRuntimeRefreshReason).toBe('marketplace install')
    expect(cold.pendingPluginRuntimeRefreshReason).toBeUndefined()
  })

  it('serializes concurrent plugin mutations for the same session', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let firstStarted!: () => void
    const started = new Promise<void>(resolve => { firstStarted = resolve })
    const agent = createAgentStub()
    const dispose = jest.fn(async () => {
      firstStarted()
      await firstGate
    })
    agent.disposeForRestart = dispose
    const managed = injectSession(sm, 'same-session-mutations', tmpRoot, 'slug-A', agent)

    const first = sm.refreshPluginRuntime('ws_test', undefined, 'plugin update')
    await started
    const second = sm.refreshPluginRuntime('ws_test', undefined, 'plugin uninstall')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(dispose).toHaveBeenCalledTimes(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })
})

function getWatcher(sm: SessionManager, workspaceId: string): ConfigWatcher {
  // Watcher map is keyed by immutable workspace ID (W6 Step 7).
  const watcher = (sm as unknown as { configWatchers: Map<string, ConfigWatcher> }).configWatchers.get(workspaceId)
  if (!watcher) {
    throw new Error(`Missing watcher for ${workspaceId}`)
  }
  return watcher
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
