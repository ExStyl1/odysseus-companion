/**
 * WS-mode preload — replaces the full IPC preload (index.ts).
 *
 * Normal mode (local server):
 *   Creates a RoutedClient that routes LOCAL_ONLY channels to the local
 *   Electron server and REMOTE_ELIGIBLE channels to whichever server owns
 *   the active workspace (local or remote). Workspace switches swap the
 *   workspace client transparently.
 *
 * Thin-client mode (NESSY_SERVER_URL):
 *   Creates a single WsRpcClient connected to the remote server.
 *   All channels go to the remote server.
 *
 * On localhost the WS handshake completes in <1ms. The React app takes >100ms
 * to initialise, so by the time any component calls an API method, the
 * connection is established.
 */

import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
import { WsRpcClient, type TransportConnectionState } from '../transport/client'
import { RoutedClient } from '../transport/routed-client'
import { buildClientApi } from '../transport/build-api'
import { CHANNEL_MAP } from '../transport/channel-map'
import { createCallbackServer } from '@nessy-agent/shared/auth/callback-server'
import { CHATGPT_OAUTH_CONFIG } from '@nessy-agent/shared/auth/chatgpt-oauth-config'
import { DpAuthError } from '@nessy-agent/shared/auth/dp'
import { isSafeModeEnabled } from '@nessy-agent/shared/config/safe-mode'
import {
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_PROPOSE_MCPB,
  CLIENT_BROWSER_INVOKE,
  LOCAL_CLIENT_CAPABILITIES,
} from '@nessy-agent/server-core/transport'
import type { ConfirmDialogSpec, FileDialogSpec, BrowserCapabilityRequest } from '@nessy-agent/server-core/transport'
import type { RpcClient } from '@nessy-agent/server-core/transport'
import type { ResolvedRemoteWorkspaceConnection } from '@nessy-agent/shared/workspaces'
import type { ElectronAPI, PiHarnessRuntimeElectronApi } from '../shared/types'
import {
  parsePiAgentViewControlResultV1,
  parsePiAgentViewPageV1,
  parsePiHarnessRuntimeControlResultV1,
  parsePiHarnessRuntimeEventV1,
  parsePiHarnessRuntimeSnapshotV1,
  RPC_CHANNELS,
  RPC_REQUEST_TIMEOUT_BY_CHANNEL,
  type DpAuthRequestArgs,
  type DpAuthResult,
  type DpAuthStatusEvent,
} from '@nessy-agent/shared/protocol'
import { proposeMcpbFromNativePicker } from './mcpb-import'
import { readWindowVibrancy } from './window-vibrancy'
import {
  createOAuthOperation,
  OAuthOperationRegistry,
  OAUTH_CLIENT_CODES,
  type OAuthOperationArgs,
  type OAuthOperationResult,
} from './oauth-orchestration'

// ---------------------------------------------------------------------------
// Client interface — common surface for both RoutedClient and WsRpcClient
// ---------------------------------------------------------------------------

interface TransportClient extends RpcClient {
  isChannelAvailable(channel: string): boolean
  getConnectionState(): TransportConnectionState
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
  reconnectNow(): void
}

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

const webContentsId: number = ipcRenderer.sendSync('__get-web-contents-id')
const isClientOnly = !!process.env.NESSY_SERVER_URL

let client: TransportClient

if (isClientOnly) {
  // ── Thin-client mode ───────────────────────────────────────────────────
  // Single WsRpcClient connected directly to the remote server.
  // No local server, no routing — all channels go to remote.

  const wsUrl = process.env.NESSY_SERVER_URL!
  const wsToken = process.env.NESSY_SERVER_TOKEN ?? ''

  // Block unencrypted ws:// to non-localhost servers — tokens would be sent in cleartext
  const parsed = new URL(wsUrl)
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol === 'ws:' && !isLocalhost) {
    throw new Error(
      `Refusing to connect to remote server over unencrypted ws://. ` +
      `Use wss:// (TLS) for non-localhost connections. ` +
      `Set NESSY_RPC_TLS_CERT/KEY on the server to enable TLS.`
    )
  }

  // Workspace ID is optional — if missing, renderer shows a workspace picker
  const workspaceId = process.env.NESSY_WORKSPACE_ID || ipcRenderer.sendSync('__get-workspace-id') || undefined

  const wsClient = new WsRpcClient(wsUrl, {
    token: wsToken,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'remote',
    clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
    requestTimeoutByChannel: RPC_REQUEST_TIMEOUT_BY_CHANNEL,
  })
  registerClientCapabilities(wsClient)
  wsClient.connect()
  client = wsClient

} else {
  // ── Normal mode ────────────────────────────────────────────────────────
  // RoutedClient routes LOCAL_ONLY to local server, REMOTE_ELIGIBLE to
  // whichever server owns the workspace (local or remote).

  const wsPort: number = ipcRenderer.sendSync('__get-ws-port')
  const wsToken: string = ipcRenderer.sendSync('__get-ws-token')
  const workspaceId: string = ipcRenderer.sendSync('__get-workspace-id')

  const localClient = new WsRpcClient(`ws://127.0.0.1:${wsPort}`, {
    token: wsToken,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'local',
    clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
    requestTimeoutByChannel: RPC_REQUEST_TIMEOUT_BY_CHANNEL,
  })
  registerClientCapabilities(localClient)

  const routedClient = new RoutedClient(localClient, localClient)

  // Private preload/main command: saved credentials never enter ElectronAPI or
  // renderer state. Local Workspaces resolve to null and reuse localClient.
  routedClient.setClientFactory(async (localWorkspaceId: string) => {
    const remote = await ipcRenderer.invoke(
      '__resolve-workspace-client',
      localWorkspaceId,
    ) as ResolvedRemoteWorkspaceConnection | null
    if (!remote) return localClient
    if (remote.localWorkspaceId !== localWorkspaceId) {
      throw new Error('Workspace connection is unavailable')
    }
    const remoteClient = new WsRpcClient(remote.url, {
      token: remote.token,
      workspaceId: remote.remoteWorkspaceId,
      webContentsId,
      autoReconnect: true,
      mode: 'remote',
      clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
      requestTimeoutByChannel: RPC_REQUEST_TIMEOUT_BY_CHANNEL,
      tlsRejectUnauthorized: false,
    })
    registerClientCapabilities(remoteClient)
    return remoteClient
  })

  localClient.connect()
  void routedClient.initializeWorkspace(workspaceId)
  client = routedClient
}

// ---------------------------------------------------------------------------
// Register client-side capability handlers (server can invoke these)
// ---------------------------------------------------------------------------

function registerClientCapabilities(target: WsRpcClient): void {
  target.handleCapability(CLIENT_OPEN_EXTERNAL, (url: string) => shell.openExternal(url))
  target.handleCapability(CLIENT_OPEN_PATH, async (path: string) => {
    const error = await shell.openPath(path)
    return { error: error || undefined }
  })
  target.handleCapability(CLIENT_SHOW_IN_FOLDER, (path: string) => {
    shell.showItemInFolder(path)
  })
  target.handleCapability(CLIENT_CONFIRM_DIALOG, async (spec: ConfirmDialogSpec) => {
    return await ipcRenderer.invoke('__dialog:showMessageBox', spec)
  })
  target.handleCapability(CLIENT_OPEN_FILE_DIALOG, async (spec: FileDialogSpec) => {
    return await ipcRenderer.invoke('__dialog:showOpenDialog', spec)
  })
  target.handleCapability(CLIENT_PROPOSE_MCPB, async () => {
    return await proposeMcpbFromNativePicker(
      target,
      spec => ipcRenderer.invoke('__dialog:showOpenDialog', spec),
    )
  })
  target.handleCapability(CLIENT_BROWSER_INVOKE, async (req: BrowserCapabilityRequest) => {
    return await ipcRenderer.invoke('__browser:invoke', req)
  })
}

// ---------------------------------------------------------------------------
// Build ElectronAPI proxy
// ---------------------------------------------------------------------------

const api = buildClientApi(client, CHANNEL_MAP, (ch) => client.isChannelAvailable(ch))

;(api as any).getRuntimeEnvironment = (): 'electron' | 'web' => 'electron'
;(api as any).saveTextFile = (options: unknown) => ipcRenderer.invoke('__dialog:saveTextFile', options)
const piHarnessApi = api as ElectronAPI & PiHarnessRuntimeElectronApi
piHarnessApi.getPiHarnessRuntime = async session => {
  const result = await client.invoke(RPC_CHANNELS.sessions.GET_PI_HARNESS_RUNTIME, session) as { snapshot?: unknown; barrierSeq?: unknown }
  if (!Number.isSafeInteger(result?.barrierSeq) || (result.barrierSeq as number) < 0) throw new Error('pi-harness-runtime-invalid')
  return { snapshot: parsePiHarnessRuntimeSnapshotV1(result.snapshot), barrierSeq: result.barrierSeq as number }
}
piHarnessApi.controlPiHarnessRuntime = async request => parsePiHarnessRuntimeControlResultV1(await client.invoke(RPC_CHANNELS.sessions.CONTROL_PI_HARNESS_RUNTIME, request))
piHarnessApi.listPiAgentView = async request => parsePiAgentViewPageV1(await client.invoke(RPC_CHANNELS.sessions.LIST_PI_AGENT_VIEW, request))
piHarnessApi.controlPiAgentView = async request => parsePiAgentViewControlResultV1(await client.invoke(RPC_CHANNELS.sessions.CONTROL_PI_AGENT_VIEW, request))
piHarnessApi.onPiHarnessRuntimeInvalidated = callback => {
  if (!client.onSequenced) throw new Error('sequenced-transport-unavailable')
  return client.onSequenced(RPC_CHANNELS.sessions.EVENT, ({ seq, args }) => {
    try { callback({ seq, event: parsePiHarnessRuntimeEventV1(args[0]) }) } catch { /* unrelated or malformed server event is ignored */ }
  })
}

// ---------------------------------------------------------------------------
// Transport connection state logging (for remote connections)
// ---------------------------------------------------------------------------

function formatTransportReason(state: TransportConnectionState): string {
  const err = state.lastError
  if (err) {
    const codePart = err.code ? ` [${err.code}]` : ''
    return `${err.kind}${codePart}: ${err.message}`
  }

  if (state.lastClose?.code != null) {
    const reason = state.lastClose.reason ? ` (${state.lastClose.reason})` : ''
    return `close ${state.lastClose.code}${reason}`
  }

  return 'no additional details'
}

// Log remote connection state changes to main process (visible in terminal + main.log).
// Activates whenever the workspace connection is remote (thin client or remote workspace).
client.onConnectionStateChanged((state) => {
  if (state.mode !== 'remote') return

  const emitToMain = (level: 'info' | 'warn' | 'error', message: string) => {
    ipcRenderer.send('__transport:status', {
      level,
      message,
      status: state.status,
      attempt: state.attempt,
      nextRetryInMs: state.nextRetryInMs,
      error: state.lastError,
      close: state.lastClose,
      url: state.url,
    })
  }

  if (state.status === 'connected') {
    const message = `[transport] connected to ${state.url}`
    console.info(message)
    emitToMain('info', message)
    return
  }

  if (state.status === 'reconnecting') {
    const retry = state.nextRetryInMs != null ? ` retry in ${state.nextRetryInMs}ms` : ''
    const message = `[transport] reconnecting (attempt ${state.attempt})${retry} — ${formatTransportReason(state)}`
    console.warn(message)
    emitToMain('warn', message)
    return
  }

  if (state.status === 'failed' || state.status === 'disconnected') {
    const message = `[transport] ${state.status} — ${formatTransportReason(state)}`
    console.error(message)
    emitToMain('error', message)
  }
})

// ---------------------------------------------------------------------------
// Transport state API (exposed to renderer)
// ---------------------------------------------------------------------------

;(api as any).getTransportConnectionState = async () => client.getConnectionState()
;(api as any).onTransportConnectionStateChanged = (callback: (state: TransportConnectionState) => void) => {
  return client.onConnectionStateChanged(callback)
}
;(api as any).reconnectTransport = async () => {
  client.reconnectNow()
}

;(api as ElectronAPI).performDpAuth = async (
  args: DpAuthRequestArgs,
  onStatus?: (status: DpAuthStatusEvent['status']) => void,
): Promise<DpAuthResult> => {
  const unsubscribe = onStatus
    ? client.on(RPC_CHANNELS.dpAuth.STATUS, (event: DpAuthStatusEvent) => {
        if (event.requestId === args.requestId) onStatus(event.status)
      })
    : undefined
  try {
    return await client.invoke(RPC_CHANNELS.dpAuth.ENSURE, args)
  } catch {
    return { ok: false, code: DpAuthError.ExecFailed }
  } finally {
    unsubscribe?.()
  }
}

;(api as ElectronAPI).cancelDpAuth = async (
  args: DpAuthRequestArgs,
): Promise<DpAuthResult> => {
  try {
    return await client.invoke(RPC_CHANNELS.dpAuth.CANCEL, args)
  } catch {
    return { ok: false, code: DpAuthError.ExecFailed }
  }
}

// ── performOAuth ─────────────────────────────────────────────────────────
// Multi-step orchestration: callback server (local) → oauth:start (server) →
// open browser → wait for callback → oauth:complete (server).
// Runs client-side because the callback server must receive the redirect.
const oauthOperations = new OAuthOperationRegistry()

;(api as ElectronAPI).performOAuth = async (
  args: OAuthOperationArgs,
): Promise<OAuthOperationResult> => {
  return oauthOperations.run(args, () => createOAuthOperation({
    createCallbackServer: () => createCallbackServer({ appType: 'electron' }),
    openExternal: url => shell.openExternal(url),
    invoke: (channel, request) => client.invoke(channel, request),
  }, args))
}

;(api as ElectronAPI).cancelOAuth = async args => {
  const operation = oauthOperations.get(args)
  if (operation) return operation.cancel()

  try {
    const response = await client.invoke(RPC_CHANNELS.oauth.CANCEL, {
      sessionId: args.sessionId,
      authRequestId: args.authRequestId,
      sourceSlug: args.sourceSlug,
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    })
    return response?.success === true
      ? { ok: true }
      : { ok: false, code: OAUTH_CLIENT_CODES.CANCEL_FAILED }
  } catch {
    return { ok: false, code: OAUTH_CLIENT_CODES.CANCEL_FAILED }
  }
}

// ── startClaudeOAuth ─────────────────────────────────────────────────────
// Override the channel-map stub: the server now returns authUrl without opening
// the browser. We open it locally so it works in remote mode.
// Claude OAuth is two-step: browser opens → user copies code → pastes in UI.
;(api as any).startClaudeOAuth = async (): Promise<{
  success: boolean
  authUrl?: string
  error?: string
}> => {
  try {
    const result = await client.invoke(RPC_CHANNELS.onboarding.START_CLAUDE_OAUTH)
    if (result.success && result.authUrl) {
      await shell.openExternal(result.authUrl)
    }
    return result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Claude OAuth failed',
    }
  }
}

// ── performChatGptOAuth ──────────────────────────────────────────────────
// Same shape as performOAuth: callback server (port 1455) → chatgpt:startOAuth →
// browser → callback → chatgpt:completeOAuth.
// Overrides the startChatGptOAuth API method so the renderer call is unchanged.
;(api as any).startChatGptOAuth = async (
  connectionSlug: string,
): Promise<{ success: boolean; error?: string }> => {
  let callbackServer: Awaited<ReturnType<typeof createCallbackServer>> | null = null
  let flowId: string | undefined
  let state: string | undefined

  try {
    // 1. Start callback server on ChatGPT's fixed port with /auth/callback path
    callbackServer = await createCallbackServer({
      appType: 'electron',
      port: CHATGPT_OAUTH_CONFIG.CALLBACK_PORT,
      callbackPaths: ['/auth/callback'],
    })

    // 2. Ask server to prepare the flow (PKCE, auth URL, store pending flow)
    const startResult = await client.invoke(RPC_CHANNELS.chatgpt.START_OAUTH, connectionSlug)
    flowId = startResult.flowId
    state = startResult.state

    // 3. Open browser for user consent
    await shell.openExternal(startResult.authUrl)

    // 4. Wait for OpenAI to redirect to our callback server
    const callback = await callbackServer.promise

    // 5. Check for errors from the provider
    if (callback.query.error) {
      const error = callback.query.error_description || callback.query.error
      await client.invoke(RPC_CHANNELS.chatgpt.CANCEL_OAUTH, { state })
      return { success: false, error }
    }

    const code = callback.query.code
    if (!code) {
      await client.invoke(RPC_CHANNELS.chatgpt.CANCEL_OAUTH, { state })
      return { success: false, error: 'No authorization code received' }
    }

    // 6. Send code to server for token exchange + credential storage
    const result = await client.invoke(RPC_CHANNELS.chatgpt.COMPLETE_OAUTH, { flowId, code, state })
    return { success: result.success, error: result.error }
  } catch (err) {
    if (state) {
      client.invoke(RPC_CHANNELS.chatgpt.CANCEL_OAUTH, { state }).catch(() => {})
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'ChatGPT OAuth flow failed',
    }
  } finally {
    callbackServer?.close()
  }
}

;(api as ElectronAPI).getOdysseusSkillPrompt = (name: string) => ipcRenderer.invoke('odysseus:skill-prompt', name)
;(api as ElectronAPI).getOdysseusStatus = () => ipcRenderer.invoke('odysseus:status')
;(api as ElectronAPI).syncOdysseus = () => ipcRenderer.invoke('odysseus:sync')
;(api as ElectronAPI).launchOdysseusCli = (sessionId?: string) => ipcRenderer.invoke('odysseus:cli', sessionId)
;(api as ElectronAPI).setOdysseusAppearance = mode => ipcRenderer.invoke('odysseus:appearance', mode)

;(api as ElectronAPI).getKnowledgeView = options => ipcRenderer.invoke('odysseus:knowledge-view',options)
;(api as ElectronAPI).editKnowledge = operation => ipcRenderer.invoke('odysseus:knowledge-edit',operation)
;(api as ElectronAPI).getKnowledgeAgent = options => ipcRenderer.invoke('odysseus:knowledge-agent',options)
;(api as ElectronAPI).getKnowledgeDocument = options => ipcRenderer.invoke('odysseus:knowledge-document',options)
;(api as ElectronAPI).manageKnowledgeCatalog = options => ipcRenderer.invoke('odysseus:knowledge-catalogs',options)
;(api as ElectronAPI).syncKnowledgeObsidian = () => ipcRenderer.invoke('odysseus:knowledge-obsidian-sync')

// App lifecycle — direct IPC (not WS RPC) since it restarts the server itself
;(api as ElectronAPI).relaunchApp = (options?: { safeMode?: boolean }) =>
  ipcRenderer.invoke('app:relaunch', options)
;(api as ElectronAPI).removeWorkspace = (workspaceId: string) => ipcRenderer.invoke('workspace:remove', workspaceId)
;(api as any).importResourcesIntoRemoteWorkspace = (
  targetWorkspaceId: string,
  bundle: unknown,
  mode: 'skip' | 'overwrite',
) => ipcRenderer.invoke('resources:importIntoRemoteWorkspace', targetWorkspaceId, bundle, mode)
;(api as ElectronAPI).transferSessionToWorkspace = (sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) =>
  ipcRenderer.invoke('session:transferToWorkspace', sessionId, targetWorkspaceId, sessionIndex, sessionCount)
;(api as ElectronAPI).onTransferProgress = (cb: (progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => void) => {
  const handler = (_e: any, progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => cb(progress)
  ipcRenderer.on('transfer:progress', handler)
  return () => { ipcRenderer.removeListener('transfer:progress', handler) }
}

// Safe mode — the same env the capability funnel gates on, read directly so
// the banner cannot disagree with what the server actually loaded. Sync and
// IPC-free: the posture is fixed for the life of the process.
;(api as ElectronAPI).isSafeModeSession = () => isSafeModeEnabled(process.env)

// System warnings — expose env-based flags set during main process startup
// (preload-only: reads env var directly, no IPC round-trip needed)
;(api as ElectronAPI).getSystemWarnings = async () => ({
  vcredistMissing: process.env.NESSY_VCREDIST_MISSING === '1',
  downloadUrl: process.env.NESSY_VCREDIST_URL,
})
;(api as ElectronAPI).getNessyGatewayJwt = () => ipcRenderer.invoke('nessy:getGatewayJwt')
;(api as ElectronAPI).ensureGatewayAuth = () => ipcRenderer.invoke('nessy:ensureGatewayAuth')
;(api as ElectronAPI).cancelGatewayAuth = () => ipcRenderer.invoke('nessy:cancelGatewayAuth')
;(api as ElectronAPI).onGatewayAuthStatus = (cb: (status: string) => void) => {
  const handler = (_e: any, status: string) => cb(status)
  ipcRenderer.on('nessy:gatewayAuthStatus', handler)
  return () => { ipcRenderer.removeListener('nessy:gatewayAuthStatus', handler) }
}
;(api as ElectronAPI).isCodexRuntimeEnabled = () => ipcRenderer.invoke('nessy:isCodexRuntimeEnabled')
;(api as ElectronAPI).getProviderFlags = () => ipcRenderer.invoke('nessy:getProviderFlags')

// Native window material, passed by the main process as a launch argument (window-manager.ts).
// Read synchronously so the first paint already knows whether the canvas may be translucent (UB14.47).
;(api as ElectronAPI).getWindowVibrancy = () => readWindowVibrancy(process.argv)

// i18n: sync language changes to main process (for native menus/dialogs)
;(api as ElectronAPI).changeLanguage = (lang: string) => ipcRenderer.invoke('i18n:changeLanguage', lang)

// webUtils.getPathForFile: returns the absolute OS path of a File object obtained
// from <input type="file"> or OS drag-drop. Returns null for Files fabricated from
// Blobs (clipboard paste, web-drag) — those are content-only, no filesystem path.
;(api as ElectronAPI).getFilePath = (file: File) => {
  try {
    return webUtils.getPathForFile(file) || null
  } catch {
    return null
  }
}

// Exposed under a PRIVATE name, not as `electronAPI`.
//
// `contextBridge` defines its globals `writable: false, configurable: false`
// and freezes the object — measured on packaged Electron 39.2.7:
// `Object.getOwnPropertyDescriptor(window, 'electronAPI')` reports both false
// and `Object.isFrozen` is true, so a renderer-side wrapper CANNOT replace it.
//
// That matters because a rejection cannot carry its `code` across this bridge
// (the property, the name and even the stack are lost — the stack is
// regenerated). The transport therefore resolves failures as plain envelopes
// and the renderer rebuilds real Errors from them in its own world. For that
// wrapper to be the thing every call site reaches, `electronAPI` has to be
// defined by the renderer — so this side publishes the raw surface under a
// name product code never uses.
//
// `renderer/lib/install-rpc-api.ts` is the only reader, and it is main.tsx's
// FIRST import so nothing can observe a missing `electronAPI`.
contextBridge.exposeInMainWorld('__nessyRpcRaw', api)
