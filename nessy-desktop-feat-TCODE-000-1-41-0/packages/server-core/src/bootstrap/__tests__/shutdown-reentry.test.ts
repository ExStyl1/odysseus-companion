/**
 * D1.231 — a signalled headless run left its supervised background shells
 * behind, on BOTH signals, and the cause is a re-entered shutdown.
 *
 * D1.211 measured the leak credential-free and localised it to a two-second
 * window: the last line a signalled server prints is `INFO Shutting down...`
 * and `Cleaning up resources...` never follows, so the drain is not FAILING —
 * it is not being REACHED. `Shutting down...` is `bootstrapServer`'s `stop()`,
 * whose next act is a 2 000 ms client-notification sleep; `cleanupSessionManager`
 * is on the far side of it, and it is the only path to the supervisor's drain.
 *
 * The mechanism, measured 2026-09-17 on a child carrying this exact shape, two
 * arms differing only in how many signals were delivered:
 *
 *   one SIGTERM    shutdown → stop → drain 2 000 ms → DRAIN COMPLETE → exit 0
 *   two SIGTERMs   shutdown → stop → (2nd shutdown → stop returns) → exit 0
 *                  … and DRAIN COMPLETE never printed
 *
 * `stop()` guarded on a boolean and RETURNED to a second caller, so that caller
 * ran its own next statement — in both hosts `process.exit(0)` — inside the
 * first call's window. The row's discriminator follows: at `e8204347e` a
 * SIGNALLED CLI run called `cleanup()` twice (the signal handler's and the main
 * path's, each reaching `proc.kill('SIGTERM')`, ~100 ms apart) where an
 * un-signalled one called it once.
 *
 * This case is the in-process form of arm B: two callers, one drain, and the
 * assertion is that the SECOND one waited for it.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import {
  clearManagedDeliveryCache,
  resetManagedDeliverySession,
} from '@nessy-agent/shared/config/managed-delivery'
import type { StorageHostLease, VerifiedStorageLayoutV2 } from '@nessy-agent/shared/workspaces'
import type { PlatformServices } from '../../runtime/platform'
import type { WsRpcServer } from '../../transport/server'
import { bootstrapServer, type HeadlessStorageBootstrap } from '../headless-start'

const TOKEN = '0123456789abcdef0123456789abcdef'
const LAYOUT: VerifiedStorageLayoutV2 = { storageLayoutVersion: 2, verificationId: 'verified' }

function platform(): PlatformServices {
  return {
    appRootPath: '/test',
    resourcesPath: '/test',
    isPackaged: false,
    appVersion: 'test',
    imageProcessor: {
      getMetadata: async () => null,
      process: async () => Buffer.alloc(0),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    isDebugMode: false,
  } as unknown as PlatformServices
}

/**
 * Unlike the neighbouring suites, this `push` does NOT throw. They throw to
 * skip the 2 000 ms drain; here the drain window IS the defect, so it has to be
 * open when the second caller arrives.
 */
function rpcServer(): WsRpcServer {
  return {
    protocol: 'ws',
    port: 9124,
    listen: async () => {},
    close: () => {},
    push: () => {},
    getConnectedClientCount: () => 0,
  } as unknown as WsRpcServer
}

function options(record: { cleanedAt: number | null }) {
  const hostLease: StorageHostLease = { assertHeld: () => {} }
  const storageBootstrap: HeadlessStorageBootstrap = {
    acquireHostLease: () => hostLease,
    releaseHostLease: () => {},
    ensureStorageLayout: async () => ({ status: 'ready', layout: LAYOUT }),
  }
  return {
    serverToken: TOKEN,
    platformFactory: () => platform(),
    storageBootstrap,
    bundledAssetsRoot: '/test',
    applyPlatformToSubsystems: () => {},
    configArtifactsInitializer: () => {},
    globalConfigInitializer: () => {},
    initModelRefreshService: () => ({ startAll: () => {}, stopAll: () => {} }),
    createSessionManager: async () => ({ id: 'session-manager' }),
    rpcServerFactory: () => rpcServer(),
    bindRpcServer: () => {},
    createHandlerDeps: () => ({}),
    registerAllRpcHandlers: () => {},
    setSessionEventSink: () => {},
    initializeSessionManager: async () => {},
    // The supervisor's background-shell drain hangs off this call in the real
    // host (`SessionManager.cleanup()`), which is why the row is about reaping.
    cleanupSessionManager: async () => { record.cleanedAt = Date.now() },
  }
}

afterEach(() => {
  resetManagedDeliverySession()
  clearManagedDeliveryCache()
})

describe('D1.231 — a second stop() awaits the first instead of racing past it', () => {
  it('the second caller does not return until the session manager has been cleaned up', async () => {
    const record: { cleanedAt: number | null } = { cleanedAt: null }
    const instance = await bootstrapServer(options(record))

    const startedAt = Date.now()
    const first = instance.stop()
    const second = instance.stop()

    // NON-VACUITY, asserted before anything is awaited: the drain really is on
    // the far side of an async window. If cleanup ran synchronously the case
    // below would pass without measuring anything.
    expect(record.cleanedAt).toBeNull()

    await second
    // THE ROW. In both hosts the next statement after `await instance.stop()`
    // is `process.exit(0)`; before this fix that ran here, with the first call
    // still inside its 2 000 ms notification sleep.
    expect(record.cleanedAt).not.toBeNull()
    // And it waited for the real window rather than for a resolved promise.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500)

    await first
  }, 30_000)

  it('the control — one caller drains exactly once', async () => {
    // The other half: the guard must still collapse N calls onto ONE drain, so
    // a fix that simply removed it would fail here.
    const record: { cleanedAt: number | null } = { cleanedAt: null }
    let cleanups = 0
    const opts = options(record)
    const instance = await bootstrapServer({
      ...opts,
      cleanupSessionManager: async () => { cleanups++; record.cleanedAt = Date.now() },
    })

    await instance.stop()
    await instance.stop()
    await instance.stop()

    expect(cleanups).toBe(1)
    expect(record.cleanedAt).not.toBeNull()
  }, 30_000)
})
