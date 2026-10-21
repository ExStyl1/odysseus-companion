/**
 * F1.1000 — the `sessions.CREATE` door took `options.permissionMode` off the wire raw. F1.800 closed the same gap at
 * `sessionCommand` `setPermissionMode`; the create door was the second one. A raw spelling was stored as the session's
 * mode: `ask` (codex has no row for it and failed every turn), a junk string, and — the safety half — `execute` or
 * `allow-all`, which name `bypassPermissions` but slipped past both create-time checks that compare against the
 * canonical name: the managed `disabledPermissionModes` ladder and the root/sudo refusal.
 *
 * Driven through the REAL registered handler into the REAL `SessionManager.createSession`.
 */
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { isBypassPermittedForProcess } from '@nessy-agent/shared/agent/pi-harness/bypass-root-guard'
import type { HandlerDeps } from '../../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'
import { CLIENT_SHOW_IN_FOLDER } from '../../../transport/capabilities'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager'
import { registerSessionsHandlers } from '../sessions'

type Manager = ReturnType<typeof createTestSessionManager>

async function withHarness(
  opts: { local: boolean; manager?: Manager },
  body: (create: (options: Record<string, unknown>) => Promise<{ id: string; permissionMode?: string }>, manager: Manager) => Promise<void>,
) {
  const manager = opts.manager ?? createTestSessionManager()
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() {},
    hasClientCapability(_clientId, capability) { return opts.local && capability === CLIENT_SHOW_IN_FOLDER },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    sessionManager: manager,
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSessionsHandlers(server, deps)
  const context: RequestContext = { clientId: 'client-f11000', workspaceId: 'ws-f11000', webContentsId: null }
  const handler = handlers.get(RPC_CHANNELS.sessions.CREATE)!
  const create = (options: Record<string, unknown>) =>
    Promise.resolve().then(() => handler(context, 'ws-f11000', options)) as Promise<{ id: string; permissionMode?: string }>
  try {
    await body(create, manager)
  } finally {
    await manager.cleanup()
  }
}

describe('F1.1000 — sessions.CREATE resolves the permission-mode spelling at the wire door', () => {
  it('a legacy alias is stored as the mode it names (`ask` → `default`)', async () => {
    await withHarness({ local: true }, async (create, manager) => {
      const session = await create({ permissionMode: 'ask' })
      expect(session.permissionMode).toBe('default')
      expect(manager.getSessions('ws-f11000').find(s => s.id === session.id)?.permissionMode).toBe('default')
    })
  })

  // F1.1050 (DN-272) — the retired Explore mode is read as Plan at this door forever, and never stored as explore.
  it('F1.1050: a wire `explore` (and its older `safe`) creates a Plan session, never an explore one', async () => {
    await withHarness({ local: true }, async (create, manager) => {
      for (const spelling of ['explore', 'safe', 'Explore']) {
        const session = await create({ permissionMode: spelling })
        expect(session.permissionMode).toBe('plan')
        expect(manager.getSessions('ws-f11000').find(s => s.id === session.id)?.permissionMode).toBe('plan')
      }
    })
  })

  it('a string that names no mode is refused and no session is created', async () => {
    await withHarness({ local: true }, async (create, manager) => {
      await expect(create({ permissionMode: 'not-a-mode' })).rejects.toThrow('Invalid permission mode: not-a-mode')
      expect(manager.getSessions('ws-f11000')).toEqual([])
    })
  })

  it('a managed policy that disables bypass holds against its legacy spelling (`execute` walks the ladder to `auto`)', async () => {
    // Before the fix `execute` was not in `disabledPermissionModes` (which holds canonical names), so the ladder
    // returned it untouched and the session was created in a mode the administrator had turned off.
    const manager = createTestSessionManager({
      managedPiPolicy: { ...DEFAULT_MANAGED_PI_POLICY, disabledPermissionModes: ['bypassPermissions'] },
    })
    await withHarness({ local: true, manager }, async (create) => {
      const session = await create({ permissionMode: 'execute' })
      expect(session.permissionMode).toBe('auto')
    })
  })

  it('CONTROL: a canonical mode and an absent mode pass through unchanged', async () => {
    await withHarness({ local: true }, async (create) => {
      expect((await create({ permissionMode: 'acceptEdits' })).permissionMode).toBe('acceptEdits')
      expect((await create({})).permissionMode).toBeDefined()
    })
  })

  // RESIDUE, pinned so it is visible rather than silent (F1.1000, owner decision pending): the F8 remote ceiling is
  // NOT applied at this door. `apps/cli` classifies as REMOTE (it advertises no `client:showItemInFolder`) and its
  // documented `--dangerously-skip-permissions` creates the session in bypass through here — the carve-out
  // `docs/architecture/transport-locality.md` records. Closing the door is a product posture; when the owner decides,
  // this test flips.
  it.skipIf(!isBypassPermittedForProcess())('RESIDUE: a remote create in bypassPermissions is not refused here (the CLI rides on it)', async () => {
    await withHarness({ local: false }, async (create) => {
      expect((await create({ permissionMode: 'allow-all' })).permissionMode).toBe('bypassPermissions')
    })
  })
})
