/**
 * Target eligibility for "Send to Workspace".
 *
 * Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/transfer-targets.ts
 * (craft-agents-oss, Apache-2.0; landed upstream in v0.11.2), UA1.14. Adapted: the
 * renderer's workspace record is `WorkspaceInfo` here (upstream's `Workspace` is our
 * deprecated alias of it, `packages/core/src/types/workspace.ts`).
 *
 * A session can be sent to any workspace other than the one it lives in —
 * remote targets are pushed to over an outbound WS connection, local targets
 * import in-process on the embedded server. Remote targets additionally need a
 * connectivity check before they are selectable; local targets are always
 * reachable.
 */

import type { WorkspaceInfo } from '../../../shared/types'

/** All workspaces a session in `activeWorkspaceId` can be sent to. */
export function getTransferTargets(workspaces: WorkspaceInfo[], activeWorkspaceId: string | null): WorkspaceInfo[] {
  return workspaces.filter(w => w.id !== activeWorkspaceId)
}

/**
 * Menu gating: is there anywhere to send a session to? Expects the full
 * workspace list (including the active workspace), so "more than one" means
 * at least one other workspace exists.
 */
export function hasTransferTargets(workspaces: WorkspaceInfo[] | undefined | null): boolean {
  return (workspaces?.length ?? 0) > 1
}
