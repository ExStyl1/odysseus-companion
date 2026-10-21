/**
 * RoutedClient tests — channel routing, workspace readiness, and listener migration.
 */

import { describe, expect, it, mock } from 'bun:test'
import { isLocalOnly, RPC_CHANNELS, TRANSPORT_INTERNAL_CHANNELS } from '@nessy-agent/shared/protocol'
import {
  RoutedClient,
  UnclassifiedChannelError,
  WorkspaceRoutingError,
} from '../routed-client'
import type { TransportConnectionState, WsRpcClient } from '../client'

const LOCAL_CHANNEL = RPC_CHANNELS.window.GET_WORKSPACE
const REMOTE_CHANNEL = RPC_CHANNELS.sessions.GET
const SWITCH_CHANNEL = RPC_CHANNELS.window.SWITCH_WORKSPACE

interface StubOptions {
  workspaceId?: string
  state?: TransportConnectionState
}

interface StubControl {
  client: WsRpcClient
  emitState(state: TransportConnectionState): void
}

function state(
  status: TransportConnectionState['status'] = 'connected',
  mode: TransportConnectionState['mode'] = 'local',
): TransportConnectionState {
  return {
    mode,
    status,
    url: mode === 'local' ? 'ws://127.0.0.1:9000' : 'wss://remote.example',
    attempt: 0,
    updatedAt: Date.now(),
  }
}

function stubClient(
  overrides: Partial<WsRpcClient> = {},
  options: StubOptions = {},
): StubControl {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const sequencedListeners = new Map<string, Set<(event: { seq: number; args: any[] }) => void>>()
  const capabilities = new Map<string, (...args: any[]) => any>()
  const stateListeners = new Set<(next: TransportConnectionState) => void>()
  let currentState = options.state ?? state()

  const client = {
    connect: mock(() => {}),
    destroy: mock(() => {}),
    invoke: mock(async () => undefined),
    on: mock((channel: string, cb: (...args: any[]) => void) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(cb)
      return () => { set!.delete(cb) }
    }),
    onSequenced: mock((channel: string, cb: (event: { seq: number; args: any[] }) => void) => {
      let set = sequencedListeners.get(channel)
      if (!set) {
        set = new Set()
        sequencedListeners.set(channel, set)
      }
      set.add(cb)
      return () => { set!.delete(cb) }
    }),
    handleCapability: mock((channel: string, handler: (...args: any[]) => any) => {
      capabilities.set(channel, handler)
    }),
    isChannelAvailable: mock(() => true),
    getWorkspaceId: mock(() => options.workspaceId),
    getConnectionState: mock(() => ({ ...currentState })),
    onConnectionStateChanged: mock((cb: (next: TransportConnectionState) => void) => {
      stateListeners.add(cb)
      cb({ ...currentState })
      return () => { stateListeners.delete(cb) }
    }),
    reconnectNow: mock(() => {}),
    emitReconnected: mock((isStale: boolean) => {
      for (const cb of listeners.get('__transport:reconnected') ?? []) cb(isStale)
    }),
    _listeners: listeners,
    _sequencedListeners: sequencedListeners,
    _capabilities: capabilities,
    ...overrides,
  } as unknown as WsRpcClient

  return {
    client,
    emitState(next) {
      currentState = next
      for (const cb of stateListeners) cb({ ...next })
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('RoutedClient', () => {
  describe('routing and startup readiness', () => {
    it('keeps LOCAL_ONLY calls available while the workspace client connects', async () => {
      const local = stubClient({ invoke: mock(async () => 'local-result') }, { workspaceId: 'local-1' }).client
      const workspace = stubClient({}, { workspaceId: 'remote-1', state: state('connecting', 'remote') })
      const routed = new RoutedClient(local, workspace.client)

      const remoteCall = routed.invoke(REMOTE_CHANNEL)
      await Promise.resolve()
      expect(workspace.client.invoke).not.toHaveBeenCalled()

      await expect(routed.invoke(LOCAL_CHANNEL)).resolves.toBe('local-result')
      workspace.emitState(state('connected', 'remote'))
      await remoteCall

      expect(workspace.client.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
    })

    it('derives the initial local-to-remote mapping from client workspace IDs', async () => {
      const local = stubClient({}, { workspaceId: 'local-1' }).client
      const workspace = stubClient({}, { workspaceId: 'remote-1', state: state('connected', 'remote') }).client
      const routed = new RoutedClient(local, workspace)

      await routed.invoke(REMOTE_CHANNEL, 'local-1', { workspaceId: 'local-1' })

      expect(workspace.invoke).toHaveBeenCalledWith(
        REMOTE_CHANNEL,
        'remote-1',
        { workspaceId: 'remote-1' },
      )
    })

    it('holds startup calls behind the async workspace resolver', async () => {
      const local = stubClient({}, { workspaceId: 'local-1' }).client
      const remote = stubClient({}, {
        workspaceId: 'remote-1',
        state: state('connected', 'remote'),
      }).client
      const resolved = deferred<WsRpcClient>()
      const routed = new RoutedClient(local, local)
      routed.setClientFactory(async () => resolved.promise)

      const initialization = routed.initializeWorkspace('local-1')
      const remoteCall = routed.invoke(REMOTE_CHANNEL, 'local-1')
      await Promise.resolve()
      expect(remote.invoke).not.toHaveBeenCalled()

      resolved.resolve(remote)
      await initialization
      await remoteCall

      expect(remote.connect).toHaveBeenCalledTimes(1)
      expect(remote.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL, 'remote-1')
    })

    it('fails startup readiness with a typed non-secret error', async () => {
      const local = stubClient({}, { workspaceId: 'local-1' }).client
      const workspace = stubClient({}, { workspaceId: 'remote-1', state: state('connecting', 'remote') })
      const routed = new RoutedClient(local, workspace.client)
      const call = routed.invoke(REMOTE_CHANNEL)

      workspace.emitState({
        ...state('failed', 'remote'),
        lastError: { kind: 'auth', message: 'missing token super-secret' },
      })

      const error = await call.catch(value => value)
      expect(error).toBeInstanceOf(WorkspaceRoutingError)
      expect(error.code).toBe('WORKSPACE_CONNECTION_UNAVAILABLE')
      expect(JSON.stringify(error)).not.toContain('super-secret')
      expect(error.message).not.toContain('token')
    })

    it('routes listeners by channel without waiting for readiness', () => {
      const local = stubClient({}, { workspaceId: 'local-1' }).client
      const workspace = stubClient({}, { workspaceId: 'remote-1', state: state('connecting', 'remote') }).client
      const routed = new RoutedClient(local, workspace)
      const localListener = mock(() => {})
      const remoteListener = mock(() => {})

      routed.on(LOCAL_CHANNEL, localListener)
      routed.on(REMOTE_CHANNEL, remoteListener)

      expect(local.on).toHaveBeenCalledWith(LOCAL_CHANNEL, localListener)
      expect(workspace.on).toHaveBeenCalledWith(REMOTE_CHANNEL, remoteListener)
    })
  })

  describe('workspace switch', () => {
    it('switches local to remote using only the local workspace ID', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'local-2',
          remoteServer: { token: 'must-not-cross-the-boundary' },
        })),
      }, { workspaceId: 'local-1' }).client
      const remote = stubClient({}, {
        workspaceId: 'remote-2',
        state: state('connected', 'remote'),
      }).client
      const routed = new RoutedClient(local, local)
      const factory = mock(async (workspaceId: string) => remote)
      routed.setClientFactory(factory)

      const result = await routed.invoke(SWITCH_CHANNEL)
      await routed.invoke(REMOTE_CHANNEL, 'local-2')

      expect(result).toBeUndefined()
      expect(factory).toHaveBeenCalledWith('local-2')
      expect(remote.connect).toHaveBeenCalledTimes(1)
      expect(remote.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL, 'remote-2')
    })

    it('switches remote to remote and destroys the old remote client', async () => {
      const local = stubClient({
        invoke: mock(async () => ({ workspaceId: 'local-2' })),
      }, { workspaceId: 'local-1' }).client
      const oldRemote = stubClient({}, {
        workspaceId: 'remote-1',
        state: state('connected', 'remote'),
      }).client
      const newRemote = stubClient({}, {
        workspaceId: 'remote-2',
        state: state('connected', 'remote'),
      }).client
      const routed = new RoutedClient(local, oldRemote)
      routed.setClientFactory(async () => newRemote)

      await routed.invoke(SWITCH_CHANNEL)

      expect(oldRemote.destroy).toHaveBeenCalledTimes(1)
      expect(newRemote.connect).toHaveBeenCalledTimes(1)
    })

    it('switches remote to local without retaining the remote mapping', async () => {
      const local = stubClient({
        invoke: mock(async (channel: string) => channel === SWITCH_CHANNEL
          ? { workspaceId: 'local-2' }
          : 'local-result'),
      }, { workspaceId: 'local-2' }).client
      const remote = stubClient({}, {
        workspaceId: 'remote-1',
        state: state('connected', 'remote'),
      }).client
      const routed = new RoutedClient(local, remote)
      routed.setClientFactory(async () => local)

      await routed.invoke(SWITCH_CHANNEL)
      await routed.invoke(REMOTE_CHANNEL, 'local-2')

      expect(remote.destroy).toHaveBeenCalledTimes(1)
      expect(local.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL, 'local-2')
    })

    it('holds a racing REMOTE_ELIGIBLE call until the async factory is ready', async () => {
      const local = stubClient({
        invoke: mock(async () => ({ workspaceId: 'local-2' })),
      }, { workspaceId: 'local-1' }).client
      const oldRemote = stubClient({}, {
        workspaceId: 'remote-1',
        state: state('connected', 'remote'),
      }).client
      const nextRemote = stubClient({}, {
        workspaceId: 'remote-2',
        state: state('connecting', 'remote'),
      })
      const factory = deferred<WsRpcClient>()
      const routed = new RoutedClient(local, oldRemote)
      routed.setClientFactory(() => factory.promise)

      const switching = routed.invoke(SWITCH_CHANNEL)
      const remoteCall = routed.invoke(REMOTE_CHANNEL, 'local-2')
      await Promise.resolve()

      expect(oldRemote.invoke).not.toHaveBeenCalledWith(REMOTE_CHANNEL, expect.anything())
      expect(nextRemote.client.invoke).not.toHaveBeenCalled()

      factory.resolve(nextRemote.client)
      await Promise.resolve()
      await Promise.resolve()
      expect(nextRemote.client.invoke).not.toHaveBeenCalled()

      nextRemote.emitState(state('connected', 'remote'))
      await switching
      await remoteCall

      expect(nextRemote.client.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL, 'remote-2')
    })

    it('returns a typed non-secret error when credential resolution fails', async () => {
      const local = stubClient({
        invoke: mock(async () => ({ workspaceId: 'local-2' })),
      }).client
      const routed = new RoutedClient(local, local)
      routed.setClientFactory(async () => {
        throw new Error('remote_server_token super-secret is missing')
      })

      const switching = routed.invoke(SWITCH_CHANNEL)
      const racingCall = routed.invoke(REMOTE_CHANNEL)
      const switchError = await switching.catch(value => value)
      const callError = await racingCall.catch(value => value)

      for (const error of [switchError, callError]) {
        expect(error).toBeInstanceOf(WorkspaceRoutingError)
        expect(error.code).toBe('WORKSPACE_CONNECTION_UNAVAILABLE')
        expect(error.message).toBe('Workspace connection is unavailable')
        expect(JSON.stringify(error)).not.toContain('super-secret')
      }
    })

    it('re-subscribes listeners and capabilities before destroying the old client', async () => {
      const order: string[] = []
      const local = stubClient({
        invoke: mock(async () => ({ workspaceId: 'local-2' })),
      }).client
      const oldRemote = stubClient({
        on: mock(() => () => { order.push('old-unsubscribe') }),
        destroy: mock(() => { order.push('old-destroy') }),
      }, { workspaceId: 'remote-1', state: state('connected', 'remote') }).client
      const nextRemote = stubClient({
        on: mock(() => {
          order.push('new-subscribe')
          return () => {}
        }),
      }, { workspaceId: 'remote-2', state: state('connected', 'remote') }).client
      const routed = new RoutedClient(local, oldRemote)
      routed.setClientFactory(async () => nextRemote)
      const listener = mock(() => {})
      const capability = mock(async () => undefined)
      routed.on(REMOTE_CHANNEL, listener)
      routed.handleCapability('test:capability', capability)
      order.length = 0

      await routed.invoke(SWITCH_CHANNEL)

      expect(nextRemote.handleCapability).toHaveBeenCalledWith('test:capability', capability)
      expect(order).toEqual(['new-subscribe', 'old-unsubscribe', 'old-destroy'])
    })

    it('migrates sequenced listeners make-before-break and unsubscribes the active listener', async () => {
      const order: string[] = []
      const oldListeners = new Set<(event: { seq: number; args: any[] }) => void>()
      const nextListeners = new Set<(event: { seq: number; args: any[] }) => void>()
      const local = stubClient({ invoke: mock(async () => ({ workspaceId: 'local-2' })) }, { workspaceId: 'local-1' }).client
      const oldRemote = stubClient({ onSequenced: mock((_channel, callback) => { oldListeners.add(callback); return () => { order.push('old-unsubscribe'); oldListeners.delete(callback) } }) }, { workspaceId: 'remote-1', state: state('connected', 'remote') }).client
      const nextRemote = stubClient({ onSequenced: mock((_channel, callback) => { order.push('new-subscribe'); nextListeners.add(callback); return () => { order.push('new-unsubscribe'); nextListeners.delete(callback) } }) }, { workspaceId: 'remote-2', state: state('connected', 'remote') }).client
      const routed = new RoutedClient(local, oldRemote)
      routed.setClientFactory(async () => nextRemote)
      const received: unknown[] = []
      const unsubscribe = routed.onSequenced(REMOTE_CHANNEL, event => received.push(event))
      expect(oldListeners.size).toBe(1)

      await routed.invoke(SWITCH_CHANNEL)
      expect(order.slice(0, 2)).toEqual(['new-subscribe', 'old-unsubscribe'])
      expect(oldListeners.size).toBe(0)
      for (const listener of nextListeners) listener({ seq: 12, args: ['value'] })

      expect(received).toEqual([{ seq: 12, args: ['value'] }])
      unsubscribe()
      expect(nextListeners.size).toBe(0)
      expect(order.at(-1)).toBe('new-unsubscribe')
    })
  })

  describe('connection state and reconnect', () => {
    it('delegates state and reconnects through a fresh readiness barrier', async () => {
      const local = stubClient({}, { workspaceId: 'local-1' }).client
      const workspace = stubClient({}, { workspaceId: 'remote-1', state: state('connected', 'remote') })
      const routed = new RoutedClient(local, workspace.client)
      expect(routed.getConnectionState().mode).toBe('remote')

      workspace.client.reconnectNow = mock(() => {
        workspace.emitState(state('reconnecting', 'remote'))
      }) as WsRpcClient['reconnectNow']
      routed.reconnectNow()
      const call = routed.invoke(REMOTE_CHANNEL)
      await Promise.resolve()
      expect(workspace.client.invoke).not.toHaveBeenCalled()

      workspace.emitState(state('connected', 'remote'))
      await call
      expect(workspace.client.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
    })

    it('can reconnect after the previous readiness attempt failed', async () => {
      const local = stubClient({}, { workspaceId: 'local-1' }).client
      const workspace = stubClient({}, { workspaceId: 'remote-1', state: state('failed', 'remote') })
      const routed = new RoutedClient(local, workspace.client)
      workspace.client.reconnectNow = mock(() => {
        workspace.emitState(state('reconnecting', 'remote'))
      }) as WsRpcClient['reconnectNow']

      routed.reconnectNow()
      const call = routed.invoke(REMOTE_CHANNEL)
      await Promise.resolve()
      expect(workspace.client.invoke).not.toHaveBeenCalled()

      workspace.emitState(state('connected', 'remote'))
      await call
      expect(workspace.client.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
    })

    it('forwards connection state changes', () => {
      const local = stubClient({}, { workspaceId: 'local-1' }).client
      const workspace = stubClient({}, { workspaceId: 'remote-1', state: state('connected', 'remote') })
      const routed = new RoutedClient(local, workspace.client)
      const listener = mock(() => {})
      routed.onConnectionStateChanged(listener)

      workspace.emitState(state('reconnecting', 'remote'))

      expect(listener).toHaveBeenCalledTimes(2)
    })
  })
})

describe('isLocalOnly consistency', () => {
  it('keeps window channels local and session channels remote-eligible', () => {
    expect(isLocalOnly(LOCAL_CHANNEL)).toBe(true)
    expect(isLocalOnly(REMOTE_CHANNEL)).toBe(false)
  })
})

// P2.296. These drive the real RoutedClient, because the property under test is
// where a call LANDS, and a double that reports what it was handed would be
// green with and without the guard.
//
// The defect: routing consulted `isLocalOnly()` alone, so the complement of
// LOCAL_ONLY reached the workspace client — including channels in neither set.
// An RPC channel added without classification was remote-reachable by default,
// and adding one to REMOTE_ELIGIBLE to "harden" routing did nothing, because
// nothing read that set.
describe('RoutedClient — unclassified channels', () => {
  const UNCLASSIFIED = 'invented:channelThatWasNeverClassified'

  function pair() {
    const local = stubClient({}, { workspaceId: 'local-1' }).client
    const workspace = stubClient({}, { workspaceId: 'remote-1', state: state('connected', 'remote') }).client
    return { local, workspace, routed: new RoutedClient(local, workspace) }
  }

  it('refuses to invoke a channel that is in neither routing set', async () => {
    const { local, workspace, routed } = pair()

    const error = await routed.invoke(UNCLASSIFIED, 'payload').catch(value => value)

    expect(error).toBeInstanceOf(UnclassifiedChannelError)
    expect(error.code).toBe('CHANNEL_NOT_CLASSIFIED')
    expect(error.channel).toBe(UNCLASSIFIED)
    // The whole point: it reached NEITHER server. Before P2.296 the workspace
    // client — which may be another machine — would have received this.
    expect(workspace.invoke).not.toHaveBeenCalled()
    expect(local.invoke).not.toHaveBeenCalled()
  })

  it('refuses to subscribe an unclassified channel on either client', () => {
    const { local, workspace, routed } = pair()

    expect(() => routed.on(UNCLASSIFIED, () => {})).toThrow(UnclassifiedChannelError)
    expect(() => routed.onSequenced(UNCLASSIFIED, () => {})).toThrow(UnclassifiedChannelError)
    expect(workspace.on).not.toHaveBeenCalled()
    expect(workspace.onSequenced).not.toHaveBeenCalled()
    expect(local.on).not.toHaveBeenCalled()
    expect(local.onSequenced).not.toHaveBeenCalled()
  })

  it('answers isChannelAvailable false instead of throwing, and asks no server', () => {
    const { local, workspace, routed } = pair()

    expect(routed.isChannelAvailable(UNCLASSIFIED)).toBe(false)
    expect(workspace.isChannelAvailable).not.toHaveBeenCalled()
    expect(local.isChannelAvailable).not.toHaveBeenCalled()

    // Positive control on the same rig — a classified channel is still asked.
    expect(routed.isChannelAvailable(REMOTE_CHANNEL)).toBe(true)
    expect(workspace.isChannelAvailable).toHaveBeenCalledWith(REMOTE_CHANNEL)
  })

  // Same hole as the shared-layer test of the same name, checked here because
  // this is the layer where "not unclassified" turns into "send it to the other
  // machine". A lookup that answers with an inherited Object member routes.
  it('refuses inherited Object property names rather than routing them', async () => {
    const { local, workspace, routed } = pair()

    for (const ch of ['constructor', '__proto__', 'toString', 'valueOf']) {
      const error = await routed.invoke(ch).catch(value => value)
      expect(error).toBeInstanceOf(UnclassifiedChannelError)
    }
    expect(workspace.invoke).not.toHaveBeenCalled()
    expect(local.invoke).not.toHaveBeenCalled()
  })

  // The guard must not break the feature it protects. P2.282 classified these
  // two REMOTE_ELIGIBLE on purpose: importing a Claude setup writes into the
  // workspace and is read by the agent that runs there, so for a remote
  // workspace it MUST cross. A fail-closed router that kept them home would
  // report success and have no effect.
  it('still crosses the Claude-setup import channels to a remote workspace', async () => {
    const { local, workspace, routed } = pair()

    await routed.invoke(RPC_CHANNELS.workspace.IMPORT_CLAUDE_PREVIEW, 'local-1')
    await routed.invoke(RPC_CHANNELS.workspace.IMPORT_CLAUDE_APPLY, { workspaceId: 'local-1' })

    expect(workspace.invoke).toHaveBeenCalledWith(RPC_CHANNELS.workspace.IMPORT_CLAUDE_PREVIEW, 'remote-1')
    expect(workspace.invoke).toHaveBeenCalledWith(
      RPC_CHANNELS.workspace.IMPORT_CLAUDE_APPLY,
      { workspaceId: 'remote-1' },
    )
    expect(local.invoke).not.toHaveBeenCalled()
  })

  // `__transport:reconnected` is emitted by the transport client itself and is
  // deliberately not an RPC channel, so it is invisible to the exhaustiveness
  // test. It reached the workspace client before P2.296 by falling through the
  // fail-open complement; it must keep reaching it now, by classification.
  it('keeps the transport-internal reconnect signal on the workspace client', () => {
    const { local, workspace, routed } = pair()
    const listener = mock(() => {})

    routed.on(TRANSPORT_INTERNAL_CHANNELS.RECONNECTED, listener)

    expect(workspace.on).toHaveBeenCalledWith(TRANSPORT_INTERNAL_CHANNELS.RECONNECTED, listener)
    expect(local.on).not.toHaveBeenCalled()
  })
})
