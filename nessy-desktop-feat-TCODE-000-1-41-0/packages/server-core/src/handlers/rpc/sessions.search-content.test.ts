import { afterAll, describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import * as serverCoreServices from '@nessy-agent/server-core/services'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'

// W5 stage c: SEARCH_CONTENT must search the GLOBAL v2 session storage
// (SESSIONS_DIR/<workspaceId>), never `{workspaceRoot}/sessions`.

const WORKSPACE_ID = 'ws-search-probe'
const WORKSPACE_ROOT = '/tmp/ws-search-probe-root'

const searchCalls: Array<{ query: string; dir: string }> = []

/**
 * The services stub SPREADS the real barrel and `afterAll` puts it back from a
 * snapshot taken BEFORE the mock — never from the live namespace, which
 * `mock.module` mutates in place.
 *
 * This is the "Order-dependent mock leak" the known-failing register recorded on
 * 2026-07-30, closed here (D1.442). A hand-listed member set REPLACES the
 * namespace rather than overriding one member of it, so for every later file in
 * the process `@nessy-agent/server-core/services` carried exactly one export and
 * bun refused the link of anything importing another. Measured 2026-09-20 under
 * the test lock: `sessions.shell-command.test.ts` (7 pass),
 * `sessions.shell-context-fold.test.ts` (4 pass) and `system.open-url.test.ts`
 * (7 pass) are each 0 fail ALONE, and the four together are 0 pass / 5 fail / 3
 * errors — `Export named 'resizeImageForAPI' not found`, twice, and
 * `Export named 'isUsableGitBashPath' not found`. It cost the whole
 * `packages/server-core/src/handlers/rpc` chunk of the CI test job: the child
 * exited 1 with ZERO failing tests and three files that never ran.
 */
const realServices = { ...serverCoreServices }

mock.module('@nessy-agent/server-core/services', () => ({
  ...realServices,
  searchSessions: async (query: string, sessionsDir: string) => {
    searchCalls.push({ query, dir: sessionsDir })
    return [
      { sessionId: 'visible-session', matches: [] },
      { sessionId: 'hidden-session', matches: [] },
    ]
  },
}))

afterAll(() => {
  mock.module('@nessy-agent/server-core/services', () => realServices)
})

async function createHarness() {
  const handlers = new Map<string, HandlerFn>()

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  const deps: HandlerDeps = {
    sessionManager: {
      waitForInit: async () => {},
      getSessions: () => [
        { id: 'visible-session', hidden: false },
        { id: 'hidden-session', hidden: true },
      ],
    } as unknown as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
    } as unknown as HandlerDeps['platform'],
    oauthFlowStore: {
      store() {}, getByState: () => null, remove() {}, cleanup() {}, dispose() {}, size: 0,
    } as unknown as HandlerDeps['oauthFlowStore'],
    workspaceService: {
      resolve(workspaceId: string) {
        if (workspaceId !== WORKSPACE_ID) throw new Error('Workspace is not registered')
        return { workspaceRootPath: WORKSPACE_ROOT }
      },
    } as unknown as HandlerDeps['workspaceService'],
  }

  const { registerSessionsHandlers } = await import('./sessions')
  registerSessionsHandlers(server, deps)

  const ctx: RequestContext = { clientId: 'client-1', workspaceId: WORKSPACE_ID, webContentsId: null }
  return { handlers, ctx }
}

describe('sessions.SEARCH_CONTENT (global v2 storage)', () => {
  it('searches SESSIONS_DIR/<workspaceId> and never the workspace root path', async () => {
    const { handlers, ctx } = await createHarness()
    const handler = handlers.get(RPC_CHANNELS.sessions.SEARCH_CONTENT)!
    expect(handler).toBeDefined()

    const results = await handler(ctx, WORKSPACE_ID, 'needle') as Array<{ sessionId: string }>

    expect(searchCalls).toHaveLength(1)
    expect(searchCalls[0]!.query).toBe('needle')
    expect(searchCalls[0]!.dir).toBe(join(SESSIONS_DIR, WORKSPACE_ID))
    expect(searchCalls[0]!.dir.startsWith(WORKSPACE_ROOT)).toBe(false)

    // Hidden sessions are filtered from results
    expect(results.map(r => r.sessionId)).toEqual(['visible-session'])
  })

  it('returns [] for an unknown workspace', async () => {
    const { handlers, ctx } = await createHarness()
    const handler = handlers.get(RPC_CHANNELS.sessions.SEARCH_CONTENT)!
    const results = await handler(ctx, 'no-such-workspace', 'needle')
    expect(results).toEqual([])
  })
})
