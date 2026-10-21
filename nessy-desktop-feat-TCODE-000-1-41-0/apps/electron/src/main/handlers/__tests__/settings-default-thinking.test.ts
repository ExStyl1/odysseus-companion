import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '../../../shared/types'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

type HandlerFn = (ctx: { clientId: string }, ...args: any[]) => Promise<any> | any

const getDefaultThinkingLevelMock = mock(() => 'think')
const setDefaultThinkingLevelMock = mock((_level: string) => true)

/**
 * D1.440 — the SPREAD and the RESTORE, and this file is where the cost of not
 * having them was measured.
 *
 * `mock.module` replaces the module for the whole PROCESS and, without a
 * restore, permanently. The stub below listed members, so for every later file
 * in the batch `loadConfigDefaults()` answered an object with no `defaults`
 * key — which is verbatim the first completed CI run's failure in twenty other
 * files, `TypeError: undefined is not an object (evaluating
 * 'loadConfigDefaults().defaults.browserToolEnabled')` at `config/storage.ts`
 * through `prerequisite-manager.ts`'s `toolMatcher`. Fifty-one of that run's
 * sixty-six failures were this one stub; every one of those files passes alone.
 *
 * The snapshot is taken BEFORE the mock on purpose: `mock.module` mutates the
 * namespace object in place, so a restore that reads the module afterwards
 * hands the MOCK back, silently, for every later file (AGENTS.md §Traps).
 *
 * The named entries below stay. They are now a deliberate SUBSET over a real
 * module rather than the whole of it, so an import the handler grows no longer
 * breaks this file — which it did twice, `c4905d937` costing ten days of a
 * `SyntaxError: Export named 'loadConfigDefaults' not found`.
 */
const realSharedConfig = { ...(await import('@nessy-agent/shared/config')) }

afterAll(() => {
  mock.module('@nessy-agent/shared/config', () => realSharedConfig)
})

mock.module('@nessy-agent/shared/config', () => ({
  ...realSharedConfig,
  getPreferencesPath: () => '/tmp/preferences.json',
  getSessionDraft: () => null,
  setSessionDraft: () => {},
  deleteSessionDraft: () => {},
  getAllSessionDrafts: () => ({}),
  getWorkspaceByNameOrId: () => null,
  getDefaultThinkingLevel: getDefaultThinkingLevelMock,
  setDefaultThinkingLevel: setDefaultThinkingLevelMock,
  // The handler module under test imports the output-style pair from the same
  // barrel; without them the whole module fails to link and every case in this
  // file dies with a SyntaxError before it can assert anything. This getter
  // pair is not what the file pins — the thinking-level pair above is.
  getOutputStyleId: () => 'default',
  setOutputStyleId: (_styleId: string) => true,
  // P6.870, 2026-09-10 — the SAME mechanism a second time, and this one had
  // been dead for ten days. `c4905d937` (2026-08-31) added `loadConfigDefaults`
  // to `rpc/settings.ts`'s barrel import, and from that commit every case in
  // this file failed with `SyntaxError: Export named 'loadConfigDefaults' not
  // found` — reproduced ALONE at HEAD as 0 pass / 3 fail, so it is neither
  // contention nor a batch-order artefact. It was not in the known-failing
  // register.
  //
  // The durable defect is the stub SHAPE, not the missing name: a `mock.module`
  // that lists members instead of spreading the real module goes stale on any
  // import the module under test adds, silently and permanently
  // (AGENTS.md §Traps). Only `workspaceDefaults.permissionMode` is read
  // (`rpc/settings.ts` reads it once, for the effective default), so the value
  // is the smallest one that links.
  loadConfigDefaults: () => ({ workspaceDefaults: { permissionMode: 'auto' } }),
}))

describe('settings default thinking RPC handlers', () => {
  const handlers = new Map<string, HandlerFn>()

  beforeEach(async () => {
    handlers.clear()
    getDefaultThinkingLevelMock.mockClear()
    setDefaultThinkingLevelMock.mockClear()

    const server: RpcServer = {
      handle(channel, handler) {
        handlers.set(channel, handler as HandlerFn)
      },
      push() {},
      async invokeClient() {
        return null
      },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    }

    const deps: HandlerDeps = {
      sessionManager: {} as HandlerDeps['sessionManager'],
      platform: {
        appRootPath: '',
        resourcesPath: '',
        isPackaged: false,
        appVersion: '0.0.0-test',
        isDebugMode: true,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        imageProcessor: {
          getMetadata: async () => null,
          process: async () => Buffer.from(''),
        },
      },
      oauthFlowStore: {
        store: () => {},
        getByState: () => null,
        remove: () => {},
        cleanup: () => {},
        dispose: () => {},
        get size() { return 0 },
      } as unknown as HandlerDeps['oauthFlowStore'],
    }

    const { registerSettingsHandlers } = await import('@nessy-agent/server-core/handlers/rpc/settings')
    registerSettingsHandlers(server, deps)
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  it('returns persisted default thinking level', async () => {
    const getHandler = handlers.get(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL)
    expect(getHandler).toBeTruthy()

    const result = await getHandler!({ clientId: 'client-1' })
    expect(result).toBe('think')
    expect(getDefaultThinkingLevelMock).toHaveBeenCalledTimes(1)
  })

  it('persists valid thinking level values', async () => {
    const setHandler = handlers.get(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL)
    expect(setHandler).toBeTruthy()

    const result = await setHandler!({ clientId: 'client-1' }, 'max')
    expect(result).toEqual({ success: true })
    expect(setDefaultThinkingLevelMock).toHaveBeenCalledWith('max')
    expect(setDefaultThinkingLevelMock).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid thinking level values before persistence', async () => {
    const setHandler = handlers.get(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL)
    expect(setHandler).toBeTruthy()

    await expect(setHandler!({ clientId: 'client-1' }, 'ultra')).rejects.toThrow('Invalid thinking level')
    expect(setDefaultThinkingLevelMock).not.toHaveBeenCalled()
  })
})
