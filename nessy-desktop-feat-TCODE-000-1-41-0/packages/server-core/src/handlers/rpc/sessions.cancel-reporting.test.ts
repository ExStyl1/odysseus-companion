/**
 * D1.377, the HOST half — a Stop the host could not deliver is reported, never
 * ignored.
 *
 * Both renderer Stop call sites used to end in
 * `window.electronAPI.cancelProcessing(...).catch(error => console.error(…))`
 * (`ChatDisplay.handleStop`, `AppShell`'s Esc-Esc action), so a rejected cancel
 * left the button looking like it had worked, the turn running, and nothing
 * anywhere a user or a support read could find. That is the shape RS-81 arm A
 * measured, and it is why D1.376's one-line renderer defect could hide for two
 * waves.
 *
 * The renderer now surfaces the rejection; this is the host's own record of the
 * same event, on the ONE seam every Stop passes through — the composer button,
 * Esc-Esc and the CLI alike. The rejection still travels to the caller, because
 * a handler that swallowed it would trade a silent failure for a silent success,
 * which is worse.
 */
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import { registerSessionsHandlers } from './sessions'

function harness(cancelProcessing: (...args: unknown[]) => Promise<void>) {
  const handlers = new Map<string, HandlerFn>()
  const warnings: unknown[][] = []

  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  const deps: HandlerDeps = {
    sessionManager: {
      waitForInit: async () => {},
      getSessions: () => [],
      cancelProcessing,
    } as unknown as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info() {}, error() {}, debug() {},
        warn(...args: unknown[]) { warnings.push(args) },
      },
      imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
    } as unknown as HandlerDeps['platform'],
    oauthFlowStore: {
      store() {}, getByState: () => null, remove() {}, cleanup() {}, dispose() {}, size: 0,
    } as unknown as HandlerDeps['oauthFlowStore'],
  }

  registerSessionsHandlers(server, deps)

  const ctx: RequestContext = { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null }
  return {
    warnings,
    cancel: (sessionId: string, silent?: boolean) =>
      handlers.get(RPC_CHANNELS.sessions.CANCEL)!(ctx, sessionId, silent),
  }
}

describe('a Stop the host could not deliver', () => {
  it('is logged at warn AND still reported to the caller', async () => {
    const rig = harness(async () => { throw new Error('backend is gone') })

    await expect(rig.cancel('session-1', false)).rejects.toThrow('backend is gone')

    expect(rig.warnings).toHaveLength(1)
    const [message, error] = rig.warnings[0]!
    expect(String(message)).toContain('Stop could not be delivered')
    // The session is named, because a support read starts from a session id and
    // a warn that says only "a stop failed" cannot be joined to anything.
    expect(String(message)).toContain('session-1')
    expect((error as Error).message).toBe('backend is gone')
  })

  it('THE CONTROL — a Stop that works logs nothing', async () => {
    // Green before this row and after it: without it, an assertion that a warn
    // exists could be satisfied by a handler that warns on every cancel, which
    // would bury the one line this row exists to make findable.
    const rig = harness(async () => undefined)

    await rig.cancel('session-1', false)

    expect(rig.warnings).toEqual([])
  })

  it('a SILENT cancel is reported the same way', async () => {
    // The redirect path reaches the same handler, and a redirect that cannot
    // abort the turn loses the user's message just as a Stop loses their stop.
    const rig = harness(async () => { throw new Error('backend is gone') })

    await expect(rig.cancel('session-1', true)).rejects.toThrow('backend is gone')
    expect(rig.warnings).toHaveLength(1)
  })
})
