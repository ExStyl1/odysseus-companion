/**
 * RoutedClient — client-side channel router.
 *
 * Wraps two WsRpcClient instances: localClient (always the embedded Electron
 * server) and workspaceClient (whichever server owns the active workspace).
 *
 * - LOCAL_ONLY channels route to localClient
 * - REMOTE_ELIGIBLE channels route to workspaceClient
 * - A channel in NEITHER set is refused with `UnclassifiedChannelError`
 * - On workspace switch, workspaceClient is swapped and REMOTE_ELIGIBLE
 *   listeners are re-subscribed transparently (make-before-break)
 *
 * The refusal is the point of P2.296. This router used to consult
 * `isLocalOnly()` alone, so "not local" and "may cross to another machine" were
 * the same predicate and an unclassified channel crossed silently — meaning a
 * channel reached a remote server because nobody had said it should not, and
 * `REMOTE_ELIGIBLE` had no runtime reader at all. Routing now goes through
 * `channelLocality()`, which grants `'workspace'` only on membership.
 *
 * Refusing, rather than falling back to `localClient`, is deliberate. Every
 * real channel is classified at COMPILE time (see `routing.ts`), so an
 * unclassified string is a programming error, not a user-reachable state.
 * Falling back to local would run the call on the wrong machine for a remote
 * workspace — silently, which is the same class of failure this replaces.
 */

import type { WsRpcClient, TransportConnectionState } from './client'
import type { RpcClient, SequencedEvent } from '@nessy-agent/server-core/transport'
import { channelLocality, RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { RoutedChannelLocality } from '@nessy-agent/shared/protocol'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListenerEntry {
  callback: (...args: any[]) => void
  unsub: () => void
}

interface SequencedListenerEntry {
  callback: (event: SequencedEvent) => void
  unsub: () => void
}

export type WorkspaceClientFactory = (localWorkspaceId: string) => Promise<WsRpcClient>

export class WorkspaceRoutingError extends Error {
  readonly code = 'WORKSPACE_CONNECTION_UNAVAILABLE' as const

  constructor() {
    super('Workspace connection is unavailable')
    this.name = 'WorkspaceRoutingError'
  }
}

/**
 * A channel reached the router with no transport classification, so there is no
 * answer to "which machine does this run on". Not a connectivity failure and
 * not recoverable at runtime — the fix is in the routing table.
 */
export class UnclassifiedChannelError extends Error {
  readonly code = 'CHANNEL_NOT_CLASSIFIED' as const

  constructor(readonly channel: string) {
    super(
      `Channel "${channel}" has no transport classification, so RoutedClient cannot decide `
      + 'whether it runs on this machine or on the server that owns the workspace. Classify it '
      + 'in packages/shared/src/protocol/routing.ts — LOCAL_ONLY_LIST if it needs this machine '
      + '(a native dialog, a client-supplied path), REMOTE_ELIGIBLE_LIST if it acts on the '
      + 'workspace. If it is not an RPC channel at all, declare it in '
      + 'TRANSPORT_INTERNAL_CHANNELS and give it a locality there. Routing it by default is '
      + 'what this error exists to prevent.',
    )
    this.name = 'UnclassifiedChannelError'
  }
}

interface ReadinessBarrier {
  promise: Promise<void>
  resolve(): void
  reject(error: WorkspaceRoutingError): void
}

function readinessError(): WorkspaceRoutingError {
  return new WorkspaceRoutingError()
}

function createReadinessBarrier(): ReadinessBarrier {
  let resolve!: () => void
  let reject!: (error: WorkspaceRoutingError) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// RoutedClient
// ---------------------------------------------------------------------------

export class RoutedClient implements RpcClient {
  private workspaceClient: WsRpcClient

  /** REMOTE_ELIGIBLE listener registry — survives workspace switches. */
  private remoteListeners = new Map<string, Set<ListenerEntry>>()
  private remoteSequencedListeners = new Map<string, Set<SequencedListenerEntry>>()

  /** Capability handlers — re-registered on workspace switch. */
  private capabilities = new Map<string, (...args: any[]) => Promise<any> | any>()

  /** Connection state listeners (delegates to workspaceClient). */
  private connectionStateListeners = new Set<(state: TransportConnectionState) => void>()
  private connectionStateUnsub: (() => void) | null = null

  /** Factory for creating remote workspace clients on switch. */
  private clientFactory: WorkspaceClientFactory | null = null

  /** REMOTE_ELIGIBLE calls wait here during startup and workspace switches. */
  private workspaceReady: Promise<void>

  /**
   * Workspace ID mapping — translates local workspace IDs to remote ones.
   * When set, REMOTE_ELIGIBLE invoke() calls replace the local ID in
   * arguments with the remote ID so the server can resolve the workspace.
   */
  private workspaceIdMapping: { localId: string; remoteId: string } | null = null

  constructor(
    private readonly localClient: WsRpcClient,
    initialWorkspaceClient: WsRpcClient,
  ) {
    this.workspaceClient = initialWorkspaceClient
    this.workspaceReady = this.initialReadiness(initialWorkspaceClient)
    this.bindConnectionState()
  }

  /** Set factory for creating remote workspace clients. */
  setClientFactory(factory: WorkspaceClientFactory): void {
    this.clientFactory = factory
  }

  /**
   * Resolve the initial Workspace through the same trusted async factory used
   * for later switches. REMOTE_ELIGIBLE calls wait for this promise, so a
   * renderer cannot race startup and accidentally dispatch to the local host.
   */
  initializeWorkspace(localWorkspaceId: string): Promise<void> {
    const ready = this.prepareWorkspaceClient(localWorkspaceId)
    ready.catch(() => {})
    this.workspaceReady = ready
    return ready
  }

  /**
   * Set workspace ID mapping for remote workspaces.
   * When a remote workspace is active, RPC calls pass the local workspace ID
   * as arguments, but the remote server only knows its own workspace IDs.
   * This mapping translates local → remote in invoke() arguments.
   */
  setWorkspaceMapping(localId: string, remoteId: string): void {
    this.workspaceIdMapping = { localId, remoteId }
  }

  /** Clear workspace ID mapping (when switching to a local workspace). */
  clearWorkspaceMapping(): void {
    this.workspaceIdMapping = null
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /**
   * The single routing decision, and the only place an unclassified channel is
   * turned away. Every caller below goes through it — `invoke`, `on`,
   * `onSequenced` — so there is no path that can reacquire the old fail-open
   * behaviour by consulting one set directly.
   */
  private routeFor(channel: string): RoutedChannelLocality {
    const locality = channelLocality(channel)
    if (locality === 'unclassified') throw new UnclassifiedChannelError(channel)
    return locality
  }

  // -------------------------------------------------------------------------
  // RpcClient interface
  // -------------------------------------------------------------------------

  async invoke(channel: string, ...args: any[]): Promise<any> {
    if (channel === RPC_CHANNELS.window.SWITCH_WORKSPACE) {
      return await this.invokeWorkspaceSwitch(args)
    }

    const isLocal = this.routeFor(channel) === 'local'
    if (!isLocal) await this.workspaceReady
    const target = isLocal ? this.localClient : this.workspaceClient

    // Translate local workspace IDs → remote workspace IDs for remote-routed calls.
    // RPC handlers receive workspaceId as a method argument (not from connection context).
    // When routing to a remote server, the renderer's local workspace ID must be replaced
    // with the server's workspace ID so the handler can resolve the workspace.
    // Handles both top-level string args (e.g., getSkills(workspaceId)) and
    // object args with a workspaceId property (e.g., testAutomation({ workspaceId, ... })).
    const translatedArgs = (!isLocal && this.workspaceIdMapping)
      ? args.map(arg => {
          if (arg === this.workspaceIdMapping!.localId) return this.workspaceIdMapping!.remoteId
          if (arg && typeof arg === 'object' && 'workspaceId' in arg && arg.workspaceId === this.workspaceIdMapping!.localId) {
            return { ...arg, workspaceId: this.workspaceIdMapping!.remoteId }
          }
          return arg
        })
      : args

    return await target.invoke(channel, ...translatedArgs)
  }

  on(channel: string, callback: (...args: any[]) => void): () => void {
    if (this.routeFor(channel) === 'local') {
      return this.localClient.on(channel, callback)
    }

    // REMOTE_ELIGIBLE — subscribe on workspaceClient and track for re-subscription
    const unsub = this.workspaceClient.on(channel, callback)

    let set = this.remoteListeners.get(channel)
    if (!set) {
      set = new Set()
      this.remoteListeners.set(channel, set)
    }
    const entry: ListenerEntry = { callback, unsub }
    set.add(entry)

    return () => {
      entry.unsub()
      set!.delete(entry)
      if (set!.size === 0) this.remoteListeners.delete(channel)
    }
  }

  onSequenced(channel: string, callback: (event: SequencedEvent) => void): () => void {
    if (this.routeFor(channel) === 'local') return this.localClient.onSequenced(channel, callback)
    const unsub = this.workspaceClient.onSequenced(channel, callback)
    let set = this.remoteSequencedListeners.get(channel)
    if (!set) {
      set = new Set()
      this.remoteSequencedListeners.set(channel, set)
    }
    const entry: SequencedListenerEntry = { callback, unsub }
    set.add(entry)
    return () => {
      entry.unsub()
      set!.delete(entry)
      if (set!.size === 0) this.remoteSequencedListeners.delete(channel)
    }
  }

  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void {
    this.capabilities.set(channel, handler)
    // Register on both clients — either server can invoke capabilities
    this.localClient.handleCapability(channel, handler)
    if (this.workspaceClient !== this.localClient) {
      this.workspaceClient.handleCapability(channel, handler)
    }
  }

  // -------------------------------------------------------------------------
  // Extended interface (used by bootstrap / build-api)
  // -------------------------------------------------------------------------

  /**
   * A query, not an action — so an unclassified channel answers `false` rather
   * than throwing. "There is no server I would send this to" is the honest
   * answer, and callers use this to hide UI, where a throw would take the
   * render down instead.
   */
  isChannelAvailable(channel: string): boolean {
    const locality = channelLocality(channel)
    if (locality === 'unclassified') return false
    const target = locality === 'local' ? this.localClient : this.workspaceClient
    return target.isChannelAvailable(channel)
  }

  getConnectionState(): TransportConnectionState {
    return this.workspaceClient.getConnectionState()
  }

  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void {
    this.connectionStateListeners.add(callback)
    callback(this.getConnectionState())
    return () => { this.connectionStateListeners.delete(callback) }
  }

  reconnectNow(): void {
    this.workspaceReady = this.waitForReconnect(this.workspaceClient)
    this.workspaceClient.reconnectNow()
  }

  // -------------------------------------------------------------------------
  // Workspace switch
  // -------------------------------------------------------------------------

  private async invokeWorkspaceSwitch(args: any[]): Promise<void> {
    const barrier = createReadinessBarrier()
    this.workspaceReady = barrier.promise

    try {
      const rawResult = await this.localClient.invoke(RPC_CHANNELS.window.SWITCH_WORKSPACE, ...args)
      const workspaceId = this.parseWorkspaceId(rawResult)
      const factory = this.clientFactory
      if (!factory) throw readinessError()

      const nextClient = await factory(workspaceId)
      this.activateWorkspaceClient(workspaceId, nextClient)
      if (nextClient !== this.localClient) nextClient.connect()
      await this.waitForClientReady(nextClient)
      barrier.resolve()
      return
    } catch {
      const error = readinessError()
      barrier.reject(error)
      throw error
    }
  }

  private async prepareWorkspaceClient(localWorkspaceId: string): Promise<void> {
    try {
      const factory = this.clientFactory
      if (!factory) throw readinessError()
      const nextClient = await factory(localWorkspaceId)
      this.activateWorkspaceClient(localWorkspaceId, nextClient)
      if (nextClient !== this.localClient) nextClient.connect()
      await this.waitForClientReady(nextClient)
    } catch {
      throw readinessError()
    }
  }

  private parseWorkspaceId(result: unknown): string {
    const workspaceId = result && typeof result === 'object'
      ? (result as { workspaceId?: unknown }).workspaceId
      : undefined
    if (typeof workspaceId !== 'string' || !workspaceId) throw readinessError()
    return workspaceId
  }

  private activateWorkspaceClient(localWorkspaceId: string, nextClient: WsRpcClient): void {
    if (nextClient === this.localClient) {
      this.clearWorkspaceMapping()
    } else {
      const remoteWorkspaceId = nextClient.getWorkspaceId()
      if (!remoteWorkspaceId) throw readinessError()
      this.setWorkspaceMapping(localWorkspaceId, remoteWorkspaceId)
    }

    if (nextClient !== this.workspaceClient) this.swapWorkspaceClient(nextClient)
  }

  private initialReadiness(initialWorkspaceClient: WsRpcClient): Promise<void> {
    if (initialWorkspaceClient !== this.localClient) {
      const localWorkspaceId = this.localClient.getWorkspaceId()
      const remoteWorkspaceId = initialWorkspaceClient.getWorkspaceId()
      if (!localWorkspaceId || !remoteWorkspaceId) {
        const rejected = Promise.reject<void>(readinessError())
        rejected.catch(() => {})
        return rejected
      }
      this.setWorkspaceMapping(localWorkspaceId, remoteWorkspaceId)
    }
    return this.waitForClientReady(initialWorkspaceClient)
  }

  private waitForClientReady(client: WsRpcClient): Promise<void> {
    const current = client.getConnectionState()
    if (current.status === 'connected') return Promise.resolve()
    if (current.status === 'failed') {
      const rejected = Promise.reject<void>(readinessError())
      rejected.catch(() => {})
      return rejected
    }

    const readiness = new Promise<void>((resolve, reject) => {
      let settled = false
      let unsubscribe: (() => void) | undefined
      const finish = (error?: WorkspaceRoutingError) => {
        if (settled) return
        settled = true
        unsubscribe?.()
        if (error) reject(error)
        else resolve()
      }
      unsubscribe = client.onConnectionStateChanged((state) => {
        if (state.status === 'connected') finish()
        else if (state.status === 'failed') finish(readinessError())
      })
      if (settled) unsubscribe()
    })
    readiness.catch(() => {})
    return readiness
  }

  private waitForReconnect(client: WsRpcClient): Promise<void> {
    const readiness = new Promise<void>((resolve, reject) => {
      let settled = false
      let sawTransition = false
      let receivedInitialState = false
      let unsubscribe: (() => void) | undefined
      const finish = (error?: WorkspaceRoutingError) => {
        if (settled) return
        settled = true
        unsubscribe?.()
        if (error) reject(error)
        else resolve()
      }
      unsubscribe = client.onConnectionStateChanged((state) => {
        if (!receivedInitialState) {
          receivedInitialState = true
          return
        }
        if (state.status === 'failed') finish(readinessError())
        else if (state.status === 'connected' && sawTransition) finish()
        else if (state.status !== 'connected') sawTransition = true
      })
      if (settled) unsubscribe()
    })
    readiness.catch(() => {})
    return readiness
  }

  private swapWorkspaceClient(newClient: WsRpcClient): void {
    const old = this.workspaceClient
    this.workspaceClient = newClient

    // Re-register capabilities on new client
    for (const [channel, handler] of this.capabilities) {
      newClient.handleCapability(channel, handler)
    }

    // Re-subscribe REMOTE_ELIGIBLE listeners (make-before-break:
    // subscribe on new first, then unsubscribe from old)
    for (const [channel, entries] of this.remoteListeners) {
      for (const entry of entries) {
        const oldUnsub = entry.unsub
        entry.unsub = newClient.on(channel, entry.callback)
        oldUnsub()
      }
    }
    for (const [channel, entries] of this.remoteSequencedListeners) {
      for (const entry of entries) {
        const oldUnsub = entry.unsub
        entry.unsub = newClient.onSequenced(channel, entry.callback)
        oldUnsub()
      }
    }

    // Rebind connection state delegation
    this.bindConnectionState()

    // Destroy old client (unless it's the local client or same as new)
    if (old !== this.localClient && old !== newClient) {
      old.destroy()
    }

    // Emit synthetic stale reconnect once the new client connects.
    // Workspace switches create a brand-new client (not a reconnect), so
    // __transport:reconnected never fires naturally. This triggers the App's
    // stale recovery logic to refresh sessions that changed while no client
    // was watching this workspace.
    if (newClient !== this.localClient) {
      // `let` + optional-chaining: onConnectionStateChanged can fire its
      // callback synchronously when the new client is already connected, which
      // would put `unsub` in the TDZ if declared `const`.
      let unsub: (() => void) | undefined
      unsub = newClient.onConnectionStateChanged((state) => {
        if (state.status === 'connected') {
          unsub?.()
          newClient.emitReconnected(true)
        }
      })
    }
  }

  private bindConnectionState(): void {
    this.connectionStateUnsub?.()
    this.connectionStateUnsub = this.workspaceClient.onConnectionStateChanged((state) => {
      const snapshot = { ...state }
      for (const cb of this.connectionStateListeners) {
        try { cb(snapshot) } catch { /* listener errors must not break transport */ }
      }
    })
  }
}
