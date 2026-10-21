import { describe, expect, it, spyOn } from 'bun:test'
import { OAuthFlowStore } from '@nessy-agent/shared/auth'
import type { StorageHostLease, StorageReadinessResult, VerifiedStorageLayoutV2 } from '@nessy-agent/shared/workspaces'
import type { PlatformServices } from '../../runtime/platform'
import type { WsRpcServer } from '../../transport/server'
import {
  bootstrapServer,
  HeadlessStorageReadinessError,
  type HeadlessStorageBootstrap,
} from '../headless-start'

const TOKEN = '0123456789abcdef0123456789abcdef'

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
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    isDebugMode: false,
  }
}

function lease(events: string[]): StorageHostLease {
  return {
    assertHeld: () => events.push('lease:assert'),
  }
}

function rpcServer(events: string[]): WsRpcServer {
  return {
    protocol: 'ws',
    port: 9123,
    listen: async () => { events.push('rpc:listen') },
    close: () => { events.push('rpc:close') },
    push: (channel: string) => {
      if (channel === 'server:shuttingDown') throw new Error('skip drain')
    },
    getConnectedClientCount: () => 0,
  } as unknown as WsRpcServer
}

function baseOptions(
  events: string[],
  storageBootstrap: HeadlessStorageBootstrap,
  layoutSeen: { session?: VerifiedStorageLayoutV2; deps?: VerifiedStorageLayoutV2 },
) {
  return {
    serverToken: TOKEN,
    platformFactory: platform,
    storageBootstrap,
    bundledAssetsRoot: '/test',
    applyPlatformToSubsystems: () => { events.push('platform:apply') },
    configArtifactsInitializer: () => { events.push('config:artifacts') },
    globalConfigInitializer: () => { events.push('config:load') },
    initModelRefreshService: () => {
      events.push('models:create')
      return {
        startAll: () => { events.push('models:start') },
        stopAll: () => { events.push('models:stop') },
      }
    },
    createSessionManager: async (storageLayout: VerifiedStorageLayoutV2) => {
      layoutSeen.session = storageLayout
      events.push('session:create:start')
      await Promise.resolve()
      events.push('session:create:end')
      return { id: 'session-manager' }
    },
    rpcServerFactory: () => {
      events.push('rpc:create')
      return rpcServer(events)
    },
    bindRpcServer: () => { events.push('rpc:bind') },
    createHandlerDeps: ({ storageLayout }: { storageLayout: VerifiedStorageLayoutV2 }) => {
      layoutSeen.deps = storageLayout
      events.push('rpc:deps')
      return {}
    },
    registerAllRpcHandlers: () => { events.push('rpc:register') },
    setSessionEventSink: () => { events.push('session:sink') },
    initializeSessionManager: async () => { events.push('session:initialize') },
    cleanupSessionManager: async () => { events.push('session:cleanup') },
  }
}

describe('headless storage readiness order', () => {
  it('awaits readiness and the exact layout before every normal consumer', async () => {
    const events: string[] = []
    const hostLease = lease(events)
    const layout: VerifiedStorageLayoutV2 = {
      storageLayoutVersion: 2,
      verificationId: 'verified-layout',
    }
    let finishReadiness!: () => void
    const readinessBarrier = new Promise<void>((resolve) => { finishReadiness = resolve })
    const storageBootstrap: HeadlessStorageBootstrap = {
      acquireHostLease: () => {
        events.push('lease:acquire')
        return hostLease
      },
      releaseHostLease: () => { events.push('lease:release') },
      ensureStorageLayout: async () => {
        events.push('readiness:start')
        await readinessBarrier
        events.push('readiness:end')
        return { status: 'ready', layout }
      },
    }
    const layoutSeen: { session?: VerifiedStorageLayoutV2; deps?: VerifiedStorageLayoutV2 } = {}

    const started = bootstrapServer(baseOptions(events, storageBootstrap, layoutSeen))
    await Promise.resolve()
    expect(events).toEqual(['lease:acquire', 'readiness:start'])

    finishReadiness()
    const instance = await started

    expect(layoutSeen.session).toBe(layout)
    expect(layoutSeen.deps).toBe(layout)
    expect(events).toEqual([
      'lease:acquire',
      'readiness:start',
      'readiness:end',
      'lease:assert',
      'platform:apply',
      'config:artifacts',
      'config:load',
      'models:create',
      'session:create:start',
      'session:create:end',
      'rpc:create',
      'rpc:bind',
      'rpc:deps',
      'rpc:register',
      'session:sink',
      'session:initialize',
      'models:start',
      'rpc:listen',
    ])

    await instance.stop()
    expect(events.at(-1)).toBe('lease:release')
  })

  it('releases the lease and exposes no normal consumer when readiness blocks', async () => {
    const events: string[] = []
    const hostLease = lease(events)
    const blocked: StorageReadinessResult = {
      status: 'blocked',
      code: 'corrupt-v2',
      diagnosticPath: '/safe/diagnostic',
    }
    const storageBootstrap: HeadlessStorageBootstrap = {
      acquireHostLease: () => {
        events.push('lease:acquire')
        return hostLease
      },
      releaseHostLease: () => { events.push('lease:release') },
      ensureStorageLayout: async () => {
        events.push('readiness:blocked')
        return blocked
      },
    }
    const layoutSeen: { session?: VerifiedStorageLayoutV2; deps?: VerifiedStorageLayoutV2 } = {}

    let error: unknown
    try {
      await bootstrapServer(baseOptions(events, storageBootstrap, layoutSeen))
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(HeadlessStorageReadinessError)
    expect(error).toMatchObject({
      code: 'corrupt-v2',
      diagnosticPath: '/safe/diagnostic',
      message: 'Storage readiness blocked: corrupt-v2',
    })
    expect(events).toEqual(['lease:acquire', 'readiness:blocked', 'lease:release'])
    expect(layoutSeen).toEqual({})
  })

  it('accepts an already verified Electron layout without acquiring a headless lease', async () => {
    const events: string[] = []
    const layout: VerifiedStorageLayoutV2 = {
      storageLayoutVersion: 2,
      verificationId: 'electron-layout',
    }
    const storageBootstrap: HeadlessStorageBootstrap = {
      acquireHostLease: () => { throw new Error('must not acquire') },
      releaseHostLease: () => { throw new Error('must not release') },
      ensureStorageLayout: async () => { throw new Error('must not verify twice') },
    }
    const layoutSeen: { session?: VerifiedStorageLayoutV2; deps?: VerifiedStorageLayoutV2 } = {}

    const instance = await bootstrapServer({
      ...baseOptions(events, storageBootstrap, layoutSeen),
      verifiedStorageLayout: layout,
    })

    expect(layoutSeen.session).toBe(layout)
    expect(layoutSeen.deps).toBe(layout)
    expect(events).not.toContain('lease:acquire')
    expect(events).not.toContain('readiness:start')
    await instance.stop()
    expect(events).not.toContain('lease:release')
  })

  it('releases an internally acquired lease when later startup fails', async () => {
    const events: string[] = []
    const hostLease = lease(events)
    const layout: VerifiedStorageLayoutV2 = {
      storageLayoutVersion: 2,
      verificationId: 'late-failure-layout',
    }
    const storageBootstrap: HeadlessStorageBootstrap = {
      acquireHostLease: () => {
        events.push('lease:acquire')
        return hostLease
      },
      releaseHostLease: () => { events.push('lease:release') },
      ensureStorageLayout: async () => ({ status: 'ready', layout }),
    }
    const layoutSeen: { session?: VerifiedStorageLayoutV2; deps?: VerifiedStorageLayoutV2 } = {}

    const originalDispose = OAuthFlowStore.prototype.dispose
    const disposeSpy = spyOn(OAuthFlowStore.prototype, 'dispose').mockImplementation(function (this: OAuthFlowStore) {
      originalDispose.call(this)
    })
    try {
      await expect(bootstrapServer({
        ...baseOptions(events, storageBootstrap, layoutSeen),
        rpcServerFactory: () => {
          events.push('rpc:create')
          const server = rpcServer(events)
          server.listen = async () => {
            events.push('rpc:listen:failed')
            throw new Error('listen failed')
          }
          return server
        },
      })).rejects.toThrow('listen failed')

      expect(events.slice(-5)).toEqual([
        'rpc:listen:failed',
        'models:stop',
        'session:cleanup',
        'rpc:close',
        'lease:release',
      ])
      expect(disposeSpy).toHaveBeenCalledTimes(1)
    } finally {
      disposeSpy.mockRestore()
    }
  })
})
