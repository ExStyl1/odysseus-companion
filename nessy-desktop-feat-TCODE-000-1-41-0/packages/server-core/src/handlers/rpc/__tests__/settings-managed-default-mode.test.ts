/**
 * P2.489, host half — `SETTINGS_GET` sends the managed tier of the
 * default-permission-mode chain, and `SETTINGS_UPDATE` still refuses it.
 *
 * The renderer arm landed first (`238e5002d`) and said so in its own words: the
 * rule `resolveWorkspaceDefaultModeDisplay` was built and consumed, and
 * `WorkspaceSettings.managedDefaultPermissionMode` was declared and read by
 * nothing, so `managed` was `false` on every install and the annotation was
 * inert rather than wrong. This file is the other half — the writer — and it
 * pins the three properties that arm depends on:
 *
 *  1. the field is SENT, carrying whatever the session manager's live managed
 *     policy says;
 *  2. an unmanaged install sends `undefined` — the fail-open direction, because
 *     the renderer reads absence as UNMANAGED and disabling a working control
 *     on every policy-free install is the failure that matters here;
 *  3. the field is READ-ONLY: `SETTINGS_UPDATE` refuses it by name.
 *
 * The reader is the OPTIONAL `ISessionManager.managedDefaultPermissionMode`, so
 * a partial embedder is a fourth case and it is covered too: no method at all
 * must behave exactly like no policy.
 *
 * In-process, on the fixture shape `settings-retention.test.ts` established —
 * the root `bunfig.toml` preload points `NESSY_CONFIG_DIR` at a private temp
 * directory, so nothing here touches a real config.
 */

import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { PERMISSION_MODE_ORDER, type PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

const WORKSPACE_ID = 'ws-managed-default-mode'

/**
 * `managed` is the answer the (optional) session-manager method gives.
 * `'absent'` stands the method down entirely — the partial-embedder case.
 */
function handlers(managed: PermissionMode | undefined | 'absent'): Map<string, HandlerFn> {
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const deps = {
    sessionManager: managed === 'absent'
      ? {}
      : { managedDefaultPermissionMode: () => managed },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
    workspaceService: {
      resolve(id: string) {
        return {
          id,
          name: 'Managed default mode',
          rootPath: '/tmp/managed-default-mode',
          // The workspace's OWN value, deliberately different from every managed
          // value below: the defect this row closes is the control showing this
          // while sessions start in the managed one.
          config: { name: 'Managed default mode', defaults: { permissionMode: 'acceptEdits' } },
        }
      },
    },
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  return registered
}

const ctx = { clientId: 'client-a', workspaceId: WORKSPACE_ID, webContentsId: null }

async function read(managed: PermissionMode | undefined | 'absent') {
  const handler = handlers(managed).get(RPC_CHANNELS.workspace.SETTINGS_GET)
  expect(handler, 'SETTINGS_GET is not registered').toBeDefined()
  return await handler!(ctx, WORKSPACE_ID) as {
    permissionMode?: PermissionMode
    effectiveDefaultPermissionMode?: PermissionMode
    managedDefaultPermissionMode?: PermissionMode
  }
}

describe('P2.489 host half · SETTINGS_GET carries the managed default mode', () => {
  it('sends the managed mode alongside the workspace value, not instead of it', async () => {
    const settings = await read('plan')
    expect(settings.managedDefaultPermissionMode).toBe('plan')
    // Both tiers cross. The page needs the workspace value to keep rendering the
    // control's stored selection while the note explains that it is outranked;
    // blending them here would leave it unable to say which tier decided.
    expect(settings.permissionMode).toBe('acceptEdits')
  })

  it('carries every mode a policy can name, unchanged', async () => {
    for (const mode of PERMISSION_MODE_ORDER) {
      expect((await read(mode)).managedDefaultPermissionMode).toBe(mode)
    }
  })

  /**
   * The fail-open case, and the direction is the whole point: absence means
   * UNMANAGED. A host that answered "managed" on ignorance would disable the
   * control on every install that deploys no policy at all — which is most of
   * them — so both no-policy shapes must be indistinguishable from each other.
   */
  it('an unmanaged policy and a partial embedder both send nothing', async () => {
    for (const managed of [undefined, 'absent'] as const) {
      const settings = await read(managed)
      expect(settings.managedDefaultPermissionMode).toBeUndefined()
      // …and the P4.8 line beside it is untouched, so the pre-P2.489 behaviour
      // is byte-for-byte what an unmanaged install still gets.
      expect(settings.effectiveDefaultPermissionMode).toBeDefined()
      expect(settings.permissionMode).toBe('acceptEdits')
    }
  })

  it('refuses a write: the field is read-only on the wire', async () => {
    const update = handlers('plan').get(RPC_CHANNELS.workspace.SETTINGS_UPDATE)
    expect(update).toBeDefined()
    await expect(update!(ctx, WORKSPACE_ID, 'managedDefaultPermissionMode', 'default'))
      .rejects.toThrow(/Invalid workspace setting key/)
  })
})
