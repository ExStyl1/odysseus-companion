/**
 * DA1.73 — the authority this process HANDS the browser is one the transport
 * that receives it will accept.
 *
 * ## The gap, and why it is not simply "set the variable"
 *
 * DA3.14 turned on a port-keyed Host allowlist for a loopback bind, with
 * `NESSY_RPC_ALLOWED_UPGRADE_HOSTS` as the escape. But the webui does not
 * hard-code its WebSocket authority: `webui/http-server.ts`'s
 * `resolveWebSocketUrl` answers `/api/config` with `publicWsUrl` when
 * `NESSY_WEBUI_WS_URL` is set. So behind a reverse proxy on a loopback bind the
 * browser is told to connect to a public name BY THIS PROCESS and is then
 * refused when it presents it — and whether it is refused at all depends on the
 * proxy's own config, which is the worst kind of intermittent. The operator's
 * remedy was a second variable they had to know existed.
 *
 * `packages/server/src/index.ts` owns both halves and now passes the webui's own
 * authority down; this file pins the RECEIVING half, which is the one that can
 * silently drop it.
 *
 * ## What is asserted, and the control
 *
 * The union, both directions, and its deduplication — because the env variable
 * stays the general escape (a proxy whose authority differs from the webui's)
 * and a fix that replaced one with the other would take an operator's existing
 * deployment away. The control is the ordinary install: no variable, no option,
 * an EMPTY list — without it every assertion here is satisfied by a bootstrap
 * that allows everything.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { PlatformServices } from '../../runtime/platform'
import type { WsRpcServer } from '../../transport/server'
import type { StorageHostLease, VerifiedStorageLayoutV2 } from '@nessy-agent/shared/workspaces'
import { bootstrapServer } from '../headless-start'

const TOKEN = '0123456789abcdef0123456789abcdef'
const ENV_NAME = 'NESSY_RPC_ALLOWED_UPGRADE_HOSTS'

function platform(): PlatformServices {
  return {
    appRootPath: '/test',
    resourcesPath: '/test',
    isPackaged: false,
    appVersion: 'test',
    imageProcessor: { getMetadata: async () => null, process: async () => Buffer.alloc(0) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    isDebugMode: false,
  }
}

const LAYOUT: VerifiedStorageLayoutV2 = { storageLayoutVersion: 2, verificationId: 'verified-layout' }

async function capturedUpgradeHosts(extraAllowedUpgradeHosts?: readonly string[]): Promise<readonly string[]> {
  let seen: readonly string[] = ['NOT-CALLED']
  const instance = await bootstrapServer({
    serverToken: TOKEN,
    platformFactory: platform,
    storageBootstrap: {
      acquireHostLease: () => ({ assertHeld: () => {} }) as StorageHostLease,
      releaseHostLease: () => {},
      ensureStorageLayout: async () => ({ status: 'ready', layout: LAYOUT }),
    } as never,
    bundledAssetsRoot: '/test',
    ...(extraAllowedUpgradeHosts ? { extraAllowedUpgradeHosts } : {}),
    applyPlatformToSubsystems: () => {},
    configArtifactsInitializer: () => {},
    globalConfigInitializer: () => {},
    initModelRefreshService: () => ({ startAll: () => {}, stopAll: () => {} }),
    createSessionManager: async () => ({ id: 'session-manager' }),
    rpcServerFactory: (options: { extraAllowedUpgradeHosts?: readonly string[] }) => {
      seen = options.extraAllowedUpgradeHosts ?? []
      return {
        protocol: 'ws',
        port: 9123,
        listen: async () => {},
        close: () => {},
        push: (channel: string) => { if (channel === 'server:shuttingDown') throw new Error('skip drain') },
        getConnectedClientCount: () => 0,
      } as unknown as WsRpcServer
    },
    bindRpcServer: () => {},
    createHandlerDeps: () => ({}),
    registerAllRpcHandlers: () => {},
    setSessionEventSink: () => {},
    initializeSessionManager: async () => {},
    cleanupSessionManager: async () => {},
  } as never)
  await (instance as { stop: () => Promise<void> } | undefined)?.stop?.()
  return seen
}

/**
 * AWAITED inside the `try`, which is the whole reason this helper is async: a
 * synchronous `finally` around an async body restores the environment BEFORE
 * the bootstrap reads it, and the case then fails claiming the env list was
 * ignored. It cost one red here.
 */
async function withEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env[ENV_NAME]
  // `delete` before assigning, on both paths: AGENTS.md's measured bun trap.
  delete process.env[ENV_NAME]
  if (value !== undefined) process.env[ENV_NAME] = value
  try {
    return await run()
  } finally {
    delete process.env[ENV_NAME]
    if (before !== undefined) process.env[ENV_NAME] = before
  }
}

afterEach(() => { delete process.env[ENV_NAME] })

describe('DA1.73 · the webui authority reaches the upgrade allowlist', () => {
  it('THE CONTROL: an ordinary install declares nothing and allows nothing extra', async () => {
    expect(await withEnv(undefined, () => capturedUpgradeHosts())).toEqual([])
  })

  it('the caller\'s authority arrives on its own', async () => {
    expect(await withEnv(undefined, () => capturedUpgradeHosts(['agent.corp.example'])))
      .toEqual(['agent.corp.example'])
  })

  it('UNIONS with the env escape rather than replacing it, and dedupes', async () => {
    // The env variable stays the general escape — a proxy whose authority
    // differs from the webui's — so replacing it would take a working
    // deployment away. The repeated name proves the dedupe.
    const hosts = await withEnv('proxy.corp.example, agent.corp.example', () =>
      capturedUpgradeHosts(['agent.corp.example']))
    expect([...hosts].sort()).toEqual(['agent.corp.example', 'proxy.corp.example'])
  })

  it('drops an empty or whitespace entry from EITHER side', async () => {
    // A trailing comma, or a caller passing an unset value as `''`, must not
    // widen the allowlist by a name nothing can present.
    const hosts = await withEnv('proxy.corp.example,,  ', () => capturedUpgradeHosts(['', '   ']))
    expect(hosts).toEqual(['proxy.corp.example'])
  })
})
