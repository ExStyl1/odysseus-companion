import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { WorkspaceQuiescenceCoordinator } from '../../../../../packages/server-core/src/workspaces/workspace-quiescence.ts'

const workspaceRootPath = '/tmp/ws-rollback'
const workspace = {
  id: 'ws-1',
  name: 'Workspace',
  rootPath: workspaceRootPath,
}

let idCounter = 0
const storedById = new Map<string, any>()
const deletedIds: string[] = []
const validatedProjectPaths: string[] = []
const boundProjectSessions: string[] = []
let mockedProvider: 'anthropic' | 'pi' = 'anthropic'

// Partial-mock baseline: import real modules via file paths (avoids recursive mock imports)
const actualSharedAgentModule = await import('../../../../../packages/shared/src/agent/index.ts')
const actualSharedAgentBackendModule = await import('../../../../../packages/shared/src/agent/backend/index.ts')
const actualSharedWorkspacesModule = await import('../../../../../packages/shared/src/workspaces/index.ts')
const actualSharedConfigModule = await import('../../../../../packages/shared/src/config/index.ts')

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    dock: { setIcon: () => {}, setBadge: () => {} },
    setBadgeCount: () => {},
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({}),
  },
  Notification: class {
    static isSupported() { return false }
    on() {}
    show() {}
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

mock.module('@nessy-agent/shared/config', () => ({
  ...actualSharedConfigModule,
  getWorkspaceByNameOrId: (id: string) => (id === workspace.id ? workspace : null),
  getWorkspaces: () => [workspace],
  // The two overridden keys sit on top of the REAL fallback object rather than
  // replacing it (W9-bq, 2026-09-10). Hand-listing the shape is what let
  // `defaults` go missing entirely: `6e0ef8cf5` added a reader of
  // `loadConfigDefaults().defaults.neverPersistSessions`, and this double
  // answered an object with no `defaults` key at all, so three cases failed
  // with `undefined is not an object` in place of the assertion they were
  // written for. `FALLBACK_CONFIG_DEFAULTS` is a module-level CONSTANT (no
  // config-dir read, so it stays safe in an isolated suite) and it is the same
  // object the production fallback path returns, so a key added to the seam
  // arrives here without anyone editing this file.
  loadConfigDefaults: () => ({
    ...actualSharedConfigModule.FALLBACK_CONFIG_DEFAULTS,
    workspaceDefaults: {
      permissionMode: 'ask',
      thinkingLevel: 'medium',
    },
  }),
  getLlmConnection: () => null,
  getDefaultLlmConnection: () => null,
  resolveAuthEnvVars: () => ({}),
  getToolIconsDir: () => '/tmp/tool-icons',
  getMiniModel: () => 'claude-haiku-4-5-20251001',
  getDefaultThinkingLevel: () => 'medium',
  ConfigWatcher: class ConfigWatcher {
    constructor(..._args: unknown[]) {}
    start() {}
    stop() {}
  },
  MODEL_REGISTRY: [],
  // Targeted stubs: prevent SyntaxError in tests that import these from the barrel
  DEFAULT_MODEL: 'claude-sonnet-4-20250514',
  DEFAULT_THEME: { mode: 'system' },
  getDefaultModelsForConnection: () => ({ default: 'claude-sonnet-4-20250514', mini: 'claude-haiku-4-5-20251001' }),
  getDefaultModelForConnection: () => 'claude-sonnet-4-20250514',
  defaultMidStreamBehavior: () => 'queue',
  setGitBashPath: () => {},
  clearGitBashPath: () => {},
  setActiveWorkspace: () => {},
  getSummarizationModel: () => 'claude-haiku-4-5-20251001',
  ensureConfigDir: () => {},
  ensureConfigDefaults: () => {},
  addWorkspace: async () => null,
  getAllSessionDrafts: () => [],
  getGitBashPath: () => null,
  // Handler-required stubs: prevent SyntaxError in handler modules loaded by registration test
  getPreferencesPath: () => '/tmp/preferences.json',
  getSessionDraft: () => null,
  setSessionDraft: async () => {},
  deleteSessionDraft: async () => {},
  getLlmConnections: () => [],
  addLlmConnection: async () => null,
  updateLlmConnection: async () => null,
  deleteLlmConnection: async () => {},
  setDefaultLlmConnection: async () => {},
  touchLlmConnection: async () => {},
  isCompatProvider: () => false,
  isAnthropicProvider: () => true,
  modelSupportsImages: () => true,
}))

mock.module('@nessy-agent/shared/workspaces', () => ({
  ...actualSharedWorkspacesModule,
  loadWorkspaceConfig: () => ({
    defaults: {
      permissionMode: 'ask',
      thinkingLevel: 'medium',
      defaultLlmConnection: undefined,
    },
  }),
}))

mock.module('@nessy-agent/shared/agent', () => ({
  ...actualSharedAgentModule,
  setPermissionMode: () => {},
  getPermissionModeDiagnostics: () => ({ mode: 'ask', source: 'test' }),
  unregisterSessionScopedToolCallbacks: () => {},
  mergeSessionScopedToolCallbacks: () => {},
  hydratePreviousPermissionMode: () => {},
  initializeModeState: () => {},
  cleanupModeState: () => {},
  getPermissionMode: () => 'ask',
  registerSessionScopedToolCallbacks: () => {},
  cleanupSessionScopedTools: () => {},
  getSessionScopedTools: () => [],
  normalizeCanonicalBrowserToolName: (name: string) => name,
}))

mock.module('@nessy-agent/shared/agent/backend', () => ({
  ...actualSharedAgentBackendModule,
  resolveSessionConnection: () => null,
  createBackendFromConnection: () => {
    throw new Error('not used in this test')
  },
  resolveBackendContext: () => ({
    provider: mockedProvider,
    resolvedModel: mockedProvider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'pi/gpt-5',
    connection: { providerType: mockedProvider === 'anthropic' ? 'anthropic' : 'pi' },
  }),
  createBackendFromResolvedContext: () => {
    throw new Error('not used in this test')
  },
  cleanupSourceRuntimeArtifacts: async () => {},
  providerTypeToAgentProvider: () => 'anthropic',
  fetchBackendModels: async () => ({ models: [] }),
  initializeBackendHostRuntime: () => {},
  resolveBackendHostTooling: () => ({
    sourceCredentialManager: null,
    sourceServerBuilder: null,
    sourcePoolFactory: null,
    sourcePoolServerFactory: null,
  }),
  testBackendConnection: async () => ({ success: false, error: 'stub' }),
  validateStoredBackendConnection: async () => ({ success: false, error: 'stub' }),
}))

mock.module('@nessy-agent/shared/sources', () => ({
  loadWorkspaceSources: () => [],
  loadAllSources: () => [],
  getSourcesBySlugs: () => [],
  isSourceUsable: () => true,
  getSourcesNeedingAuth: () => [],
  getSourceCredentialManager: () => ({
    getCredentialStatus: async () => ({ status: 'ready' }),
  }),
  getSourceServerBuilder: () => ({ buildServers: async () => ({ mcpServers: {}, apiServers: {} }) }),
  isApiOAuthProvider: () => false,
  SERVER_BUILD_ERRORS: {},
  TokenRefreshManager: class TokenRefreshManager {
    constructor(_mgr: unknown, _opts: unknown) {}
  },
  createTokenGetter: () => async () => null,
  // Targeted stubs: prevent SyntaxError in tests that import these from the barrel
  loadSource: () => null,
  API_OAUTH_PROVIDERS: [],
}))

mock.module('@nessy-agent/shared/automations', () => ({
  AutomationSystem: class AutomationSystem {
    constructor(..._args: unknown[]) {}
    setInitialSessionMetadata() {}
    reloadConfig() { return { errors: [], automationCount: 0 } }
    emitLabelConfigChange = async () => {}
  },
  validateAutomationsConfig: () => ({ valid: true, errors: [], config: { automations: {} } }),
  validateAutomationsContent: () => ({ valid: true, errors: [], warnings: [] }),
  validateAutomations: () => ({ valid: true, errors: [], warnings: [] }),
  AUTOMATIONS_CONFIG_FILE: 'automations.json',
  AUTOMATIONS_HISTORY_FILE: 'automations.history.jsonl',
}))

mock.module('@nessy-agent/shared/sessions', () => ({
  listSessions: () => [],
  loadSession: (_root: string, id: string) => storedById.get(id) ?? null,
  saveSession: async (session: any) => {
    storedById.set(session.id, session)
  },
  createSession: async (_root: string, opts: any) => {
    const id = `child-${++idCounter}`
    const now = Date.now()
    const session = {
      id,
      name: opts?.name ?? null,
      messages: [],
      permissionMode: opts?.permissionMode ?? 'ask',
      workingDirectory: opts?.workingDirectory,
      hidden: !!opts?.hidden,
      labels: [],
      isFlagged: false,
      sessionStatus: opts?.sessionStatus,
      createdAt: now,
      lastUsedAt: now,
      workspaceId: workspace.id,
    }
    storedById.set(id, session)
    return session
  },
  deleteSession: async (_root: string, id: string) => {
    deletedIds.push(id)
    storedById.delete(id)
  },
  updateSessionMetadata: async () => {},
  canUpdateSdkCwd: () => false,
  setPendingPlanExecution: async () => {},
  markCompactionComplete: async () => {},
  clearPendingPlanExecution: async () => {},
  getPendingPlanExecution: async () => null,
  getSessionAttachmentsPath: () => '/tmp/attachments',
  getOrCreateLatestSession: async () => null,
  // `createSession` clears the delete fence on the happy path
  // (`SessionManager.ts`), so a stub carrying only `flush` throws there. Same
  // class as the agent doubles below: a host seam that grew while this file was
  // unreachable from `bun test`.
  //
  // THIRD member of that seam, and the THIRD time this double has gone short of
  // it (W9-bq, 2026-09-10, at the wave gate). `6e0ef8cf5` gave `SessionManager`
  // a `sessionPersistenceQueue.onWriteFailure(...)` subscription in its own
  // CONSTRUCTOR, so a double without it fails every case in this file at
  // construction — `0 pass / 4 fail`, `'sessionPersistenceQueue.onWriteFailure'
  // is undefined`. It returns an UNSUBSCRIBE function, which the constructor
  // stores, so a stub returning `undefined` would move the failure to teardown
  // rather than remove it. `test:isolated` is the only runner that sees this
  // file, and it is not in `bun test`'s denominator — which is why the seam
  // grows unnoticed here and nowhere else.
  sessionPersistenceQueue: {
    flush: async () => {},
    clearDeleteFence: () => {},
    onWriteFailure: () => () => {},
  },
  pickSessionFields: (s: any) => {
    // Must match the v2 SESSION_PERSISTENT_FIELDS to prevent contamination of persistence
    // tests. Workspace identity is the immutable `workspaceId` (no managed paths); lineage
    // is the composite `branchFrom` (no `branchFromSessionPath`).
    const fields = [
      'id','workspaceId','sdkSessionId','sdkCwd',
      'createdAt','lastUsedAt','lastMessageAt',
      'name','isFlagged','sessionStatus','labels','hidden',
      'lastReadMessageId','hasUnread',
      'enabledSourceSlugs','permissionMode','previousPermissionMode','workingDirectory',
      'model','llmConnection','connectionLocked','thinkingLevel',
      'sharedUrl','sharedId','pendingPlanExecution',
      'isArchived','archivedAt',
      'branchFrom',
      'transferredSessionSummary','transferredSessionSummaryApplied','triggeredBy',
    ]
    const result: Record<string, unknown> = {}
    for (const f of fields) if (f in s) result[f] = (s as Record<string, unknown>)[f]
    return result
  },
  validateSessionId: () => true,
}))

const { SessionManager } = await import('@nessy-agent/server-core/sessions')

function createManager(): InstanceType<typeof SessionManager> {
  const projectHandles = new Map<string, any>()
  const sessionHandles = new Map<string, string>()
  const sessionStore = {
    ensureWorkspaceDir: () => workspaceRootPath,
    getSessionPath: ({ sessionId }: { sessionId: string }) => `${workspaceRootPath}/${sessionId}`,
    getSessionFilePath: ({ sessionId }: { sessionId: string }) => `${workspaceRootPath}/${sessionId}/session.jsonl`,
    create: async (_workspaceId: string, opts: any = {}) => {
      const id = `child-${++idCounter}`
      const now = Date.now()
      const session = {
        id,
        workspaceId: workspace.id,
        name: opts.name ?? null,
        messages: [],
        permissionMode: opts.permissionMode ?? 'ask',
        workingDirectory: opts.workingDirectory,
        hidden: !!opts.hidden,
        labels: [],
        isFlagged: false,
        sessionStatus: opts.sessionStatus,
        createdAt: now,
        lastUsedAt: now,
      }
      storedById.set(id, session)
      return session
    },
    load: ({ sessionId }: { sessionId: string }) => storedById.get(sessionId) ?? null,
    list: () => [],
    delete: ({ sessionId }: { sessionId: string }) => {
      deletedIds.push(sessionId)
      return storedById.delete(sessionId)
    },
  }
  const resolver = {
    resolve: async (context: any) => ({
      context,
      generation: 'test-generation',
      leaseId: 'test-lease',
      entries: [],
      installedPlugins: [],
      diagnostics: [],
    }),
    releaseSnapshot: () => {},
    invalidate: () => {},
    isLeaseActive: () => true,
    referencedInstances: () => new Set<string>(),
    leaseCount: () => 0,
  }
  const projectHandleService = {
    validateProjectDirectory: async (workspaceId: string, candidatePath: string) => {
      validatedProjectPaths.push(candidatePath)
      const id = `project-handle-${projectHandles.size + 1}`
      const record = {
        id,
        workspaceId,
        displayPath: candidatePath,
        canonicalPath: candidatePath,
        projectKey: `project:${candidatePath}`,
        identityFingerprint: `fingerprint:${candidatePath}`,
        trustState: 'trusted',
        trustDecision: 'trusted',
        trustRevision: 'trust-r1',
        persistence: 'persistent',
        expiresAt: Date.now() + 60_000,
      }
      projectHandles.set(id, record)
      return record
    },
    resolveHandle: async (ref: { workspaceId: string; projectHandleId?: string; sessionId?: string }) => {
      const handleId = ref.projectHandleId ?? (ref.sessionId ? sessionHandles.get(`${ref.workspaceId}:${ref.sessionId}`) : undefined)
      return handleId ? projectHandles.get(handleId) ?? null : null
    },
    bindSession: (workspaceId: string, sessionId: string, handleId: string) => {
      sessionHandles.set(`${workspaceId}:${sessionId}`, handleId)
      boundProjectSessions.push(sessionId)
    },
    unbindSession: (workspaceId: string, sessionId: string) => {
      sessionHandles.delete(`${workspaceId}:${sessionId}`)
    },
  }
  return new SessionManager(sessionStore as any, {
    resolver: resolver as any,
    workspaceService: {
      resolve: () => ({
        id: workspace.id,
        workspaceRootPath,
        sessionRootPath: `${workspaceRootPath}/sessions`,
        config: { id: workspace.id, name: workspace.name, createdAt: 1, updatedAt: 1 },
        lastAccessedAt: 1,
      }),
      listResolved: () => [],
    } as any,
    projectHandleService: projectHandleService as any,
    recentProjectStore: {} as any,
    workspaceQuiescence: new WorkspaceQuiescenceCoordinator(),
    resolveCredential: () => ({ ready: false, revision: 0 }),
    dpSessionBroker: {
      probe: async () => ({ state: 'needs-login', version: null, outdated: false }),
      subscribe: () => () => undefined,
    },
    subscribeInvalidation: () => () => {},
  })
}

describe('session branch rollback on preflight failure', () => {
  beforeEach(() => {
    mockedProvider = 'anthropic'
    idCounter = 0
    storedById.clear()
    deletedIds.length = 0
    validatedProjectPaths.length = 0
    boundProjectSessions.length = 0

    storedById.set('source-1', {
      id: 'source-1',
      workspaceId: workspace.id,
      llmConnection: undefined,
      model: 'claude-sonnet-4-20250514',
      sdkSessionId: 'sdk-parent',
      messages: [
        { id: 'm1', type: 'user', content: 'hello', timestamp: Date.now() - 10 },
        { id: 'm2', type: 'assistant', content: 'hi', timestamp: Date.now() - 5 },
      ],
      createdAt: Date.now() - 20,
      lastUsedAt: Date.now() - 5,
    })
  })

  it('deletes newly created child session when ensureBranchReady throws', async () => {
    const manager = createManager()

    let destroyCalled = false
    let poolStopCalled = false

    ;(manager as any).ensureMessagesLoaded = async (_managed: any) => {}
    ;(manager as any).getOrCreateAgent = async (managed: any) => {
      managed.poolServer = { stop: () => { poolStopCalled = true } }
      managed.agent = {
        supportsBranching: true,
        ensureBranchReady: async () => {
          throw new Error('preflight boom')
        },
        setCapabilityTurnRuntime: () => {},
        // P3.354, 2026-09-04. `SessionManager` grew two calls on this exact
        // path after these three doubles were written — `setAutomationSystem`
        // in `withCapabilityRuntime`'s `finally` and `drainAutomationEvents`
        // in `disposeManagedAgentRuntime`'s drain — and all three doubles went
        // short of it, so the rollback threw a TypeError and the branch error
        // the case asserts was replaced by the double's own defect. Nothing
        // caught it because `.isolated.ts` is not a filename `bun test`
        // discovers, so this file ran only through the second loop of
        // `bun run test`, which CI did not call. Both are real methods on
        // `BaseAgent`; production was never affected. Keep every host call in
        // all three doubles, not just the one a given case reaches: the drain
        // loop exits on an unchanged `agentAutomationEventTail`, so a no-op is
        // faithful, and a double short of the seam is what this row is about.
        setAutomationSystem: () => {},
        drainAutomationEvents: async () => {},
        // `disposeManagedAgentRuntime` calls `dispose()`, which on `BaseAgent`
        // is an alias for `destroy()` — the double mirrors that alias rather
        // than declaring only the name the assertion below is written around.
        dispose: () => {
          destroyCalled = true
        },
        destroy: () => {
          destroyCalled = true
        },
      }
      return managed.agent
    }

    await expect(
      manager.createSession('ws-1', {
        branchFromSessionId: 'source-1',
        branchFromMessageId: 'm1',
      } as any)
    ).rejects.toThrow('Could not create branch: preflight boom')

    expect(deletedIds).toEqual(['child-1'])
    expect(storedById.has('child-1')).toBe(false)
    expect((manager as any).sessions.has('child-1')).toBe(false)
    expect(destroyCalled).toBe(true)
    expect(poolStopCalled).toBe(true)
  })

  it('fails branch creation when parent claude sdk session id is missing', async () => {
    const source = storedById.get('source-1')
    source.sdkSessionId = undefined
    storedById.set('source-1', source)

    const manager = createManager()

    await expect(
      manager.createSession('ws-1', {
        branchFromSessionId: 'source-1',
        branchFromMessageId: 'm1',
      } as any)
    ).rejects.toThrow('parent session SDK context is not initialized')

    expect(deletedIds).toEqual([])
    expect(storedById.has('child-1')).toBe(false)
  })

  it('runs backend preflight for pi branches and rolls back on failure', async () => {
    mockedProvider = 'pi'

    const manager = createManager()
    let getOrCreateAgentCalled = false

    ;(manager as any).ensureMessagesLoaded = async (_managed: any) => {}
    ;(manager as any).getOrCreateAgent = async (managed: any) => {
      getOrCreateAgentCalled = true
      managed.poolServer = { stop: () => {} }
      managed.agent = {
        supportsBranching: true,
        ensureBranchReady: async () => {
          throw new Error('pi preflight boom')
        },
        setCapabilityTurnRuntime: () => {},
        setAutomationSystem: () => {},
        drainAutomationEvents: async () => {},
        dispose: () => {},
        destroy: () => {},
      }
      return managed.agent
    }

    await expect(
      manager.createSession('ws-1', {
        branchFromSessionId: 'source-1',
        branchFromMessageId: 'm1',
      } as any)
    ).rejects.toThrow('Could not create branch: pi preflight boom')

    expect(getOrCreateAgentCalled).toBe(true)
    expect(deletedIds).toEqual(['child-1'])
    expect(storedById.has('child-1')).toBe(false)
  })

  it('revalidates and inherits the parent project without a renderer path', async () => {
    const source = storedById.get('source-1')
    source.workingDirectory = '/tmp/external-project'
    storedById.set('source-1', source)

    const manager = createManager()
    ;(manager as any).ensureMessagesLoaded = async (_managed: any) => {}
    ;(manager as any).getOrCreateAgent = async (managed: any) => {
      managed.agent = {
        supportsBranching: true,
        ensureBranchReady: async () => {},
        setCapabilityTurnRuntime: () => {},
        setAutomationSystem: () => {},
        drainAutomationEvents: async () => {},
        dispose: () => {},
        destroy: () => {},
      }
      return managed.agent
    }

    const child = await manager.createSession('ws-1', {
      branchFromSessionId: 'source-1',
      branchFromMessageId: 'm1',
    } as any)

    expect(child.workingDirectory).toBe('/tmp/external-project')
    expect(validatedProjectPaths).toEqual([
      '/tmp/external-project',
      '/tmp/external-project',
    ])
    expect(boundProjectSessions).toContain(child.id)
  })
})
