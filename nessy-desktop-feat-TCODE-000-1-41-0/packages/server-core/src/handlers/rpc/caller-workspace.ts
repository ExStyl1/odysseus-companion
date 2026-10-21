import type { RequestContext } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

/**
 * The caller-workspace check every workspace-scoped RPC handler runs first.
 *
 * Lifted out of `rpc/projects.ts` (UA1.9, 2026-10-02), where it was private,
 * so the 1.42.0 handlers (`rpc/tasks.ts`, `rpc/artifacts.ts`, `rpc/pages.ts`)
 * import ONE implementation instead of each copying it. Upstream craft-agents
 * v0.13.4 has no counterpart (searched `packages/server-core/src` for the name
 * and for `workspace-mismatch`: nothing) — this is ours.
 *
 * The caller's workspace is the one its WINDOW is bound to when the request
 * came from a window (the window manager is authoritative there, because the
 * renderer's own `ctx.workspaceId` is what a stale or hostile window would
 * lie about), and the transport's `ctx.workspaceId` otherwise. A request whose
 * caller has no workspace, or a different one from the `workspaceId` the
 * request names, is refused with `code` — each module keeps its own refusal
 * string (`projects.ts` passes `'project-workspace-mismatch'`), so a renderer
 * that maps errors by message keeps working unchanged.
 */
export function assertCallerWorkspace(
  ctx: RequestContext,
  deps: HandlerDeps,
  workspaceId: string,
  code: string,
): void {
  const callerWorkspaceId = ctx.webContentsId != null
    ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) ?? ctx.workspaceId
    : ctx.workspaceId
  if (!callerWorkspaceId || callerWorkspaceId !== workspaceId) {
    throw new Error(code)
  }
}
