/**
 * Client capabilities — named actions a client can perform on behalf of the server.
 *
 * See docs/architecture/transport-locality.md for the locality boundary definition.
 */

import type { BrowserCapabilityRequest } from './browser-capability'
import type { SafeMarketplacePluginInstallProposal } from '@nessy-agent/shared/protocol'
import type { RpcServer } from './types'

/** Capability: open a URL in the client's default browser. */
export const CLIENT_OPEN_EXTERNAL = 'client:openExternal'

/** Capability: open a file with the OS default application. */
export const CLIENT_OPEN_PATH = 'client:openPath'

/** Capability: reveal a file in Finder / Explorer. */
export const CLIENT_SHOW_IN_FOLDER = 'client:showItemInFolder'

/** Capability: show a confirmation dialog (message box) on the client. */
export const CLIENT_CONFIRM_DIALOG = 'client:confirmDialog'

/** Capability: show a native file/folder picker on the client. */
export const CLIENT_OPEN_FILE_DIALOG = 'client:openFileDialog'

/** Capability: pick and upload an MCPB archive without exposing its local path. */
export const CLIENT_PROPOSE_MCPB = 'client:proposeMcpb'

/** Capability: drive a local `BrowserPaneManager` instance for a remote agent. */
export const CLIENT_BROWSER_INVOKE = 'client:browser:invoke'

/**
 * D1.224 — the client invokes whose duration is a HUMAN's, not a computation's.
 *
 * `WsRpcServer.invokeClient` bounds every server→client request at 30 s, which
 * is a sane ceiling for a capability the client answers from code and an absurd
 * one for a dialog somebody has to read. `CLIENT_PROPOSE_MCPB` already carried
 * the exception with ten minutes of its own; this set is that same judgement
 * applied to its three siblings rather than a new mechanism beside it — every
 * member blocks on a person, and none of them can be finished by waiting
 * harder.
 *
 * The three RPC channels that reach these (`file:openDialog`,
 * `dialog:openFolder`, `projects:pickLocalDirectory`, `gitbash:browse`,
 * `auth:showLogoutConfirmation`, `auth:showDeleteSessionConfirmation`) carry a
 * matching entry in `RPC_REQUEST_TIMEOUT_BY_CHANNEL` — all three layers have to
 * agree or the innermost one decides, which is what this row measured.
 */
export const USER_PACED_CLIENT_CHANNELS: ReadonlySet<string> = new Set([
  CLIENT_PROPOSE_MCPB,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_CONFIRM_DIALOG,
])

/**
 * The budget a {@link USER_PACED_CLIENT_CHANNELS} invoke gets. Ten minutes is
 * NOT a new number: it is what `CLIENT_PROPOSE_MCPB` has had since the capability
 * was added, and the entries in `RPC_REQUEST_TIMEOUT_BY_CHANNEL` for these
 * channels are the same 600 000 its own channel already carries.
 */
export const USER_PACED_CLIENT_INVOKE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * F8 — is this client running ON the machine?
 *
 * "Reveal in Finder" is the sharpest available proxy: it is an OS action on the
 * server's own filesystem, so a client that can do it is by definition local,
 * and a phone can never advertise it honestly. There is no separate locality
 * field on the handshake, and inventing one would mean a wire change for a fact
 * the capability set already carries.
 *
 * The rationale — why a capability rather than a flag, and why unknown reads as
 * remote — is `docs/architecture/transport-locality.md`.
 */
export function isLocalClient(server: RpcServer, clientId: string): boolean {
  return server.hasClientCapability(clientId, CLIENT_SHOW_IN_FOLDER)
}

/** All capabilities a local Electron client advertises on handshake. */
export const LOCAL_CLIENT_CAPABILITIES: readonly string[] = [
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_PROPOSE_MCPB,
  CLIENT_BROWSER_INVOKE,
]

// ---------------------------------------------------------------------------
// Helper wrappers — thin error-handling around server.invokeClient()
// ---------------------------------------------------------------------------

/**
 * Ask a specific client to open a URL in its default browser.
 *
 * Returns `{ opened: true }` on success.
 * Returns `{ opened: false, error, authUrl }` on failure — caller can
 * show authUrl to user for manual "copy link / open" action.
 */
export async function requestClientOpenExternal(
  server: RpcServer,
  clientId: string,
  url: string,
): Promise<{ opened: boolean; error?: string; authUrl?: string }> {
  try {
    await server.invokeClient(clientId, CLIENT_OPEN_EXTERNAL, url)
    return { opened: true }
  } catch (err) {
    const code = (err as any)?.code
    const message = err instanceof Error ? err.message : String(err)
    return { opened: false, error: `${code ?? 'UNKNOWN'}: ${message}`, authUrl: url }
  }
}

/**
 * Ask the client to open a file with the OS default application.
 * Equivalent to Electron's `shell.openPath()`.
 */
export async function requestClientOpenPath(
  server: RpcServer,
  clientId: string,
  path: string,
): Promise<{ error?: string }> {
  try {
    const result = await server.invokeClient(clientId, CLIENT_OPEN_PATH, path)
    return result ?? {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}

/**
 * Ask the client to reveal a file in Finder / Explorer.
 * Equivalent to Electron's `shell.showItemInFolder()`.
 */
export async function requestClientShowInFolder(
  server: RpcServer,
  clientId: string,
  path: string,
): Promise<void> {
  await server.invokeClient(clientId, CLIENT_SHOW_IN_FOLDER, path)
}

/** Spec for a confirmation dialog (maps to Electron's MessageBoxOptions). */
export interface ConfirmDialogSpec {
  type?: 'none' | 'info' | 'warning' | 'error' | 'question'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

/**
 * Ask the client to show a confirmation dialog.
 * Returns the index of the clicked button.
 */
export async function requestClientConfirmDialog(
  server: RpcServer,
  clientId: string,
  spec: ConfirmDialogSpec,
): Promise<{ response: number }> {
  return await server.invokeClient(clientId, CLIENT_CONFIRM_DIALOG, spec)
}

/** Spec for a file/folder picker dialog (maps to Electron's OpenDialogOptions). */
export interface FileDialogSpec {
  title?: string
  defaultPath?: string
  properties?: string[]
  filters?: Array<{ name: string; extensions: string[] }>
}

/**
 * Ask the client to show a native file/folder picker.
 * Returns the selection result (canceled + filePaths).
 */
export async function requestClientOpenFileDialog(
  server: RpcServer,
  clientId: string,
  spec: FileDialogSpec,
): Promise<{ canceled: boolean; filePaths: string[] }> {
  return await server.invokeClient(clientId, CLIENT_OPEN_FILE_DIALOG, spec)
}

export async function requestClientMcpbProposal(
  server: RpcServer,
  clientId: string,
): Promise<SafeMarketplacePluginInstallProposal | null> {
  return await server.invokeClient(clientId, CLIENT_PROPOSE_MCPB)
}

/**
 * Ask the client to invoke a `BrowserPaneManager` method.
 *
 * Errors propagate with `.code` preserved (see transport error-code preservation
 * in `client.ts` / `server.ts`). Callers can branch on `(err as any).code`.
 */
export async function requestClientBrowserInvoke<T>(
  server: RpcServer,
  clientId: string,
  req: BrowserCapabilityRequest,
): Promise<T> {
  return server.invokeClient(clientId, CLIENT_BROWSER_INVOKE, req) as Promise<T>
}
