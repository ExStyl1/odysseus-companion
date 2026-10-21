import { describe, expect, it } from 'bun:test'
import type { RequestContext } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { assertCallerWorkspace } from '../caller-workspace'

/**
 * UA1.9 — the lifted caller-workspace check. One positive arm (the window's
 * workspace passes) and its negatives (another workspace, and a caller with no
 * workspace at all, throw the code the CALLER gave), on both sources of the
 * caller's workspace: the window manager for a window request, the transport
 * context otherwise.
 */
function depsWithWindows(windows: Record<number, string>): HandlerDeps {
  return {
    windowManager: { getWorkspaceForWindow: (id: number) => windows[id] ?? null },
  } as unknown as HandlerDeps
}

function windowCtx(webContentsId: number, workspaceId: string | null = null): RequestContext {
  return { clientId: 'client-a', workspaceId, webContentsId }
}

describe('assertCallerWorkspace', () => {
  it("passes when the request names the window's own workspace", () => {
    const deps = depsWithWindows({ 7: 'ws-a' })
    // The context's own workspace is stale on purpose: the window binding wins.
    expect(() => assertCallerWorkspace(windowCtx(7, 'ws-stale'), deps, 'ws-a', 'any-code')).not.toThrow()
  })

  it('throws the GIVEN code when the window belongs to another workspace', () => {
    const deps = depsWithWindows({ 7: 'ws-a' })
    expect(() => assertCallerWorkspace(windowCtx(7, 'ws-b'), deps, 'ws-b', 'task-workspace-mismatch'))
      .toThrow('task-workspace-mismatch')
    expect(() => assertCallerWorkspace(windowCtx(7), deps, 'ws-b', 'project-workspace-mismatch'))
      .toThrow('project-workspace-mismatch')
  })

  it('falls back to the transport context when the request has no window', () => {
    const deps = depsWithWindows({})
    const ctx: RequestContext = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }
    expect(() => assertCallerWorkspace(ctx, deps, 'ws-a', 'code-x')).not.toThrow()
    expect(() => assertCallerWorkspace(ctx, deps, 'ws-b', 'code-x')).toThrow('code-x')
  })

  it('refuses a caller with no workspace at all', () => {
    const ctx: RequestContext = { clientId: 'client-a', workspaceId: null, webContentsId: null }
    expect(() => assertCallerWorkspace(ctx, depsWithWindows({}), 'ws-a', 'code-y')).toThrow('code-y')
    // An unbound window with no context workspace is the same refusal.
    expect(() => assertCallerWorkspace(windowCtx(9), depsWithWindows({}), 'ws-a', 'code-y')).toThrow('code-y')
  })
})
