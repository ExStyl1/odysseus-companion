/**
 * F1.800 — the `sessionCommand` `setPermissionMode` door takes a mode string off
 * the wire, and nothing checked it: `ask` (a pre-migration spelling that
 * `PERMISSION_MODE_ALIASES` maps to `default`) was stored raw, and a codex
 * session in that "mode" then failed every turn reading its approval policy
 * (release sitting SIT-r). The door now resolves the spelling through
 * `parsePermissionMode` and refuses a string that names no mode.
 *
 * Driven through the real registered handler, with the session manager faked
 * down to the one method this case calls.
 */
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerDeps } from '../../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'
import { CLIENT_SHOW_IN_FOLDER } from '../../../transport/capabilities'
import { registerSessionsHandlers } from '../sessions'

function createHarness(local: boolean) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() {},
    hasClientCapability(_clientId, capability) { return local && capability === CLIENT_SHOW_IN_FOLDER },
    findClientsWithCapability() { return [] },
  }
  const calls: Array<{ sessionId: string; mode: string; workspaceId?: string }> = []
  const deps = {
    sessionManager: {
      waitForInit: async () => {},
      getSessions: () => [],
      setSessionPermissionMode: (sessionId: string, mode: string, workspaceId?: string) => {
        calls.push({ sessionId, mode, workspaceId })
      },
    },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSessionsHandlers(server, deps)
  const context: RequestContext = { clientId: 'client-f1800', workspaceId: 'ws-f1800', webContentsId: null }
  const handler = handlers.get(RPC_CHANNELS.sessions.COMMAND)!
  const setMode = (mode: string) => Promise.resolve().then(() => handler(context, 'session-f1800', { type: 'setPermissionMode', mode }))
  return { setMode, calls }
}

describe('F1.800 — setPermissionMode resolves the spelling at the wire door', () => {
  it('a legacy alias is stored as the mode it names (`ask` → `default`)', async () => {
    const h = createHarness(true)
    await h.setMode('ask')
    expect(h.calls).toEqual([{ sessionId: 'session-f1800', mode: 'default', workspaceId: 'ws-f1800' }])
  })

  it('a string that names no mode is refused and never reaches the session', async () => {
    const h = createHarness(true)
    await expect(h.setMode('not-a-mode')).rejects.toThrow('Invalid permission mode: not-a-mode')
    expect(h.calls).toEqual([])
  })

  it('the remote ceiling judges the RESOLVED mode: a remote `allow-all` is refused as bypassPermissions', async () => {
    // Before the fix `allow-all` ranked -1 in PERMISSION_MODE_ORDER, so it passed the ceiling as an unknown string.
    const h = createHarness(false)
    await expect(h.setMode('allow-all')).rejects.toThrow('Permission mode "bypassPermissions" cannot be set from a remote device')
    expect(h.calls).toEqual([])
  })
})
