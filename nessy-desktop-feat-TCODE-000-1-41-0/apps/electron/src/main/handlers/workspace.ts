import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { RemoteWorkspaceGateway } from '@nessy-agent/shared/workspaces'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.remote.TEST_CONNECTION,
  RPC_CHANNELS.window.OPEN_WORKSPACE,
  RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW,
  RPC_CHANNELS.window.CLOSE,
  RPC_CHANNELS.window.CONFIRM_CLOSE,
  RPC_CHANNELS.window.CANCEL_CLOSE,
  RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS,
] as const

/**
 * Request timeout for the two remote TRANSFER clients, adopted from upstream
 * v0.13.4 (`main/index.ts`, UA12.17): the pull side (`sessions:export`) returns
 * the whole bundle as a single unchunked response frame — up to
 * MAX_BUNDLE_SIZE_BYTES over WAN — so the 30 s default is not enough. Upstream
 * declares it inside the transfer handler; ours is exported from here because
 * `main/index.ts` is docs-cited by line and cannot grow above its highest
 * citation.
 */
export const TRANSFER_REQUEST_TIMEOUT_MS = 120_000

/**
 * Connect to a remote server and wait for handshake.
 * When workspaceId is provided, the handshake is scoped to that workspace so
 * workspace-context RPC handlers (for example sessions:export) can resolve it.
 * `options.requestTimeout` overrides the client's per-request timeout (the
 * transfer handler passes {@link TRANSFER_REQUEST_TIMEOUT_MS}); without it the
 * client keeps its default. Returns the connected client or null + error message.
 */
export async function connectToRemote(
  url: string,
  token: string,
  workspaceId?: string,
  options?: { requestTimeout?: number },
) {
  const { WsRpcClient } = await import('../../transport/client')
  const client = new WsRpcClient(url, {
    token,
    workspaceId,
    autoReconnect: false,
    tlsRejectUnauthorized: false,
    requestTimeout: options?.requestTimeout,
  })

  const connected = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000)
    const unsub = client.onConnectionStateChanged((state) => {
      if (state.status === 'connected') {
        clearTimeout(timeout)
        unsub()
        resolve(true)
      } else if (state.status === 'failed') {
        clearTimeout(timeout)
        unsub()
        resolve(false)
      }
    })
    client.connect()
  })

  if (!connected) {
    const error = client.getConnectionState().lastError?.message ?? 'Connection failed'
    client.destroy()
    return { client: null, error }
  }

  return { client, error: null }
}

/** Trusted-main adapter used by the canonical Workspace binding transaction. */
export function createElectronRemoteWorkspaceGateway(): RemoteWorkspaceGateway {
  return {
    async verifyConnection({ url, token, remoteWorkspaceId }) {
      const { client, error } = await connectToRemote(url, token, remoteWorkspaceId)
      if (!client) throw new Error(error || 'Connection failed')
      try {
        const workspaces = await client.invoke(RPC_CHANNELS.server.GET_WORKSPACES) as Array<{ id: string }>
        if (!workspaces.some(workspace => workspace.id === remoteWorkspaceId)) {
          throw new Error('Remote Workspace is unavailable')
        }
      } finally {
        client.destroy()
      }
    },
    async createWorkspace({ url, token, name }) {
      const { client, error } = await connectToRemote(url, token)
      if (!client) throw new Error(error || 'Connection failed')
      try {
        const workspace = await client.invoke(
          RPC_CHANNELS.server.CREATE_WORKSPACE,
          name,
        ) as { id?: unknown }
        if (typeof workspace.id !== 'string' || !workspace.id) {
          throw new Error('Remote Workspace creation failed')
        }
        return { remoteWorkspaceId: workspace.id }
      } finally {
        client.destroy()
      }
    },
  }
}

export function registerWorkspaceGuiHandlers(server: RpcServer, deps: HandlerDeps): void {
  const windowManager = deps.windowManager

  // Test connection to a remote Nessy Desktop Server.
  // Pure discovery — returns list of existing workspaces or needsWorkspace flag.
  // Workspace creation is handled by the dedicated canonical Workspace RPC.
  server.handle(RPC_CHANNELS.remote.TEST_CONNECTION, async (_ctx, url: string, token: string) => {
    const { client, error } = await connectToRemote(url, token)
    if (!client) return { ok: false, error }

    // Read server version from handshake_ack (null for old servers)
    const serverVersion = client.getServerVersion() ?? undefined

    try {
      console.log(`[TEST_CONNECTION] invoking ${RPC_CHANNELS.server.GET_WORKSPACES} on remote server...`)
      const workspaces = await client.invoke(RPC_CHANNELS.server.GET_WORKSPACES) as Array<{ id: string; name: string }>
      console.log(`[TEST_CONNECTION] remote returned ${workspaces?.length ?? 'null'} workspaces:`, JSON.stringify(workspaces?.map(w => ({ id: w.id, name: w.name }))))

      if (workspaces.length === 0) {
        console.log('[TEST_CONNECTION] → returning needsWorkspace=true')
        return { ok: true, needsWorkspace: true, serverVersion }
      }

      const result = {
        ok: true,
        serverVersion,
        remoteWorkspaces: workspaces,
        // Convenience: auto-select if exactly one
        remoteWorkspaceId: workspaces.length === 1 ? workspaces[0].id : undefined,
        remoteWorkspaceName: workspaces.length === 1 ? workspaces[0].name : undefined,
      }
      console.log(`[TEST_CONNECTION] → returning ${workspaces.length} workspaces`)
      return result
    } catch (err) {
      console.error('[TEST_CONNECTION] error:', err)
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
    } finally {
      client.destroy()
    }
  })

  // Open workspace in new window (or focus existing)
  server.handle(RPC_CHANNELS.window.OPEN_WORKSPACE, async (_ctx, workspaceId: string) => {
    if (!windowManager) return
    windowManager.focusOrCreateWindow(workspaceId)
  })

  // Open a session in a new window
  server.handle(RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW, async (_ctx, workspaceId: string, sessionId: string) => {
    if (!windowManager) return
    const deepLink = `nessy://allSessions/session/${sessionId}`
    windowManager.createWindow({
      workspaceId,
      focused: true,
      initialDeepLink: deepLink,
    })
  })

  // Close the calling window (triggers close event which may be intercepted)
  server.handle(RPC_CHANNELS.window.CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.closeWindow(ctx.webContentsId!)
  })

  // Confirm close - force close the window (bypasses interception).
  server.handle(RPC_CHANNELS.window.CONFIRM_CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.forceCloseWindow(ctx.webContentsId!)
  })

  // Cancel close - renderer handled the request (closed a modal/panel).
  server.handle(RPC_CHANNELS.window.CANCEL_CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.cancelPendingClose(ctx.webContentsId!)
  })

  // Show/hide macOS traffic light buttons (for fullscreen overlays)
  server.handle(RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS, (ctx, visible: boolean) => {
    if (!windowManager) return
    windowManager.setTrafficLightsVisible(ctx.webContentsId!, visible)
  })
}
