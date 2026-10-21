import { DpAuthError } from '@nessy-agent/shared/auth/dp'
import {
  RPC_CHANNELS,
  type DpAuthRequestArgs,
  type DpAuthResult,
  type DpAuthStatusEvent,
  type DpSessionProbeResult,
} from '@nessy-agent/shared/protocol'
import type { RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.dpAuth.ENSURE,
  RPC_CHANNELS.dpAuth.CANCEL,
  RPC_CHANNELS.dpAuth.PROBE,
] as const

function validArgs(value: unknown): value is DpAuthRequestArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return Object.keys(input).length === 2
    && typeof input.sessionId === 'string'
    && input.sessionId.length > 0
    && input.sessionId.length <= 256
    && typeof input.requestId === 'string'
    && input.requestId.length > 0
    && input.requestId.length <= 256
}

function isLocalElectronOwner(
  deps: HandlerDeps,
  ctx: RequestContext,
  workspaceId: string,
): boolean {
  if (ctx.webContentsId === null || !deps.windowManager) return false
  return deps.windowManager.getWorkspaceForWindow(ctx.webContentsId) === workspaceId
    && deps.windowManager.getWindowByWebContentsId(ctx.webContentsId) !== null
}

export function registerDpAuthHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.dpAuth.ENSURE, async (
    ctx,
    args: unknown,
  ): Promise<DpAuthResult> => {
    const workspaceId = ctx.workspaceId
    if (!workspaceId || !isLocalElectronOwner(deps, ctx, workspaceId)) {
      return { ok: false, code: DpAuthError.InteractiveLoginUnavailable }
    }
    if (!validArgs(args) || !deps.sessionManager.hasPendingDpAuthRequest(
      args.sessionId,
      args.requestId,
      workspaceId,
    )) {
      return { ok: false, code: DpAuthError.Cancelled }
    }
    return deps.sessionManager.ensureDpAuth(
      args.sessionId,
      args.requestId,
      workspaceId,
      status => {
        const event: DpAuthStatusEvent = { requestId: args.requestId, status }
        server.push(
          RPC_CHANNELS.dpAuth.STATUS,
          { to: 'client', clientId: ctx.clientId },
          event,
        )
      },
    )
  })

  // Value-only, NON-interactive probe (T3, plugin-install plan). No pending
  // request is required: the checklist/notice call this AFTER the system
  // one-click sign-in completes so the server side observes the dp ready
  // boundary (the broker publishes to its subscribers, which restores the
  // dp-backed servers) without a chat message. Never starts a login.
  server.handle(RPC_CHANNELS.dpAuth.PROBE, async (): Promise<DpSessionProbeResult> => ({
    state: await deps.sessionManager.probeDpSessionState(),
  }))

  server.handle(RPC_CHANNELS.dpAuth.CANCEL, async (
    ctx,
    args: unknown,
  ): Promise<DpAuthResult> => {
    const workspaceId = ctx.workspaceId
    if (!workspaceId) return { ok: false, code: DpAuthError.Cancelled }
    if (!validArgs(args) || !deps.sessionManager.hasPendingDpAuthRequest(
      args.sessionId,
      args.requestId,
      workspaceId,
    )) {
      return { ok: false, code: DpAuthError.Cancelled }
    }
    return deps.sessionManager.cancelDpAuth(
      args.sessionId,
      args.requestId,
      workspaceId,
    )
  })
}
