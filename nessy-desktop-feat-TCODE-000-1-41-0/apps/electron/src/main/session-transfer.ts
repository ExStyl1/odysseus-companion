/**
 * The local-target arm of "Send to Workspace" (UA1.14).
 *
 * Adapted from the `session:transferToWorkspace` handler in
 * v0.13.4:apps/electron/src/main/index.ts (craft-agents-oss, Apache-2.0; the
 * local arm landed upstream in v0.11.2): a LOCAL target imports the exported
 * bundle in-process on the embedded server, through the same
 * `SessionManager.importSession(target, bundle, 'fork')` the `sessions:import`
 * RPC runs on a remote target, so both arms return the same `{ sessionId }`.
 *
 * Why a module and not upstream's inline arm: the handler sits in
 * `apps/electron/src/main/index.ts`, which the docs cite by line far below it,
 * so the handler is edited line for line and the arm's body lives here, where
 * it is also testable without Electron.
 *
 * Before UA1.14 the handler resolved the target with
 * `resolveRemoteWorkspaceConnection`, which throws `remote-not-configured` for a
 * local workspace, so a local target could never be reached (measured
 * 2026-10-02, recorded in the UA1.14 commit).
 */

import type { SessionBundle } from '@nessy-agent/shared/sessions'
import type { ResolvedRemoteWorkspaceConnection, WorkspaceService } from '@nessy-agent/shared/workspaces'

/** The renderer-facing progress frame the dialog already reads (`transfer:progress`). */
export interface TransferProgressFrame {
  sessionIndex: number
  sessionCount: number
  chunkSent: number
  chunkTotal: number
}

export interface LocalTransferProgress {
  sessionIndex: number
  sessionCount: number
  /** Sends one frame to the renderer; a gone renderer must not fail the transfer. */
  send: (frame: TransferProgressFrame) => void
}

/**
 * The target's remote connection, or `null` for a local target. Resolved
 * before the export so a remote target with a missing credential still fails
 * fast, before a summary is generated. An unknown id throws (`resolve`).
 */
export async function resolveTransferTargetConnection(
  workspaceService: Pick<WorkspaceService, 'resolve' | 'resolveRemoteWorkspaceConnection'>,
  targetWorkspaceId: string,
): Promise<ResolvedRemoteWorkspaceConnection | null> {
  if (!workspaceService.resolve(targetWorkspaceId).config.remoteServer) return null
  return workspaceService.resolveRemoteWorkspaceConnection(targetWorkspaceId)
}

/** Imports the bundle into a LOCAL target as a fork, reporting 0/1 then 1/1 like a direct RPC. */
export async function importTransferBundleLocally(
  sessionManager: { importSession(workspaceId: string, bundle: SessionBundle, mode: 'fork'): Promise<{ sessionId: string; warnings?: string[] }> },
  targetWorkspaceId: string,
  bundle: SessionBundle,
  progress: LocalTransferProgress,
): Promise<{ sessionId: string; warnings?: string[] }> {
  const emit = (chunkSent: number, chunkTotal: number) => {
    try {
      progress.send({ sessionIndex: progress.sessionIndex, sessionCount: progress.sessionCount, chunkSent, chunkTotal })
    } catch { /* renderer may be gone */ }
  }
  console.log(`[Transfer] Target workspace ${targetWorkspaceId} is local → importing in-process`)
  emit(0, 1)
  const result = await sessionManager.importSession(targetWorkspaceId, bundle, 'fork')
  emit(1, 1)
  return result
}
