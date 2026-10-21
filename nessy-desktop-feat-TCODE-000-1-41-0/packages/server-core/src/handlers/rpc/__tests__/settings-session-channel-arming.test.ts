/**
 * P6.510's arming VERB — the caller the host API landed without.
 *
 * `SessionManager.armSessionChannelSources` / `disarmSessionChannelSources`
 * were committed complete in `9376f8501` and reachable from nowhere: no
 * channel, no handler, no client. A per-session grant nobody can make is the
 * same as no per-session grant, so these assertions are about REACH first and
 * about the argument order second — the manager takes
 * `(sessionId, sources, workspaceId)` while every RPC verb beside it takes
 * `(sessionId, workspaceId, …)`, and a silent transposition would arm the
 * workspace id as a server name and look like nothing happened.
 *
 * In-process, with a stub manager: the real arming is already pinned by
 * `sessions/__tests__/channel-session-arming.test.ts`, and duplicating it here
 * would test the same behaviour twice while testing the seam not at all.
 */

import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

interface ArmCall {
  sessionId: string
  sources: readonly string[]
  workspaceId: string | undefined
}

function harness() {
  const armCalls: ArmCall[] = []
  const disarmCalls: Array<{ sessionId: string; workspaceId: string | undefined }> = []
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const deps = {
    sessionManager: {
      armSessionChannelSources(sessionId: string, sources: readonly string[], workspaceId?: string) {
        armCalls.push({ sessionId, sources, workspaceId })
        // The real one answers with the whole armed set, sorted.
        return [...new Set(sources)].sort()
      },
      disarmSessionChannelSources(sessionId: string, workspaceId?: string) {
        disarmCalls.push({ sessionId, workspaceId })
      },
    },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  return { registered, armCalls, disarmCalls }
}

const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

describe('the per-session channel arming verb', () => {
  it('registers both halves of the grant', () => {
    const { registered } = harness()
    expect(registered.has(RPC_CHANNELS.permissions.ARM_SESSION_CHANNEL_SOURCES)).toBe(true)
    expect(registered.has(RPC_CHANNELS.permissions.DISARM_SESSION_CHANNEL_SOURCES)).toBe(true)
  })

  it('arms SEVERAL servers at once and answers with the whole armed set', async () => {
    // `done_means`: "a session can arm several servers at once for that
    // session" — so the parameter is a list, and the answer is the set rather
    // than a delta.
    const { registered, armCalls } = harness()
    const handler = registered.get(RPC_CHANNELS.permissions.ARM_SESSION_CHANNEL_SOURCES)!
    const armed = await handler(ctx, 'session-1', 'workspace-1', ['pusher', 'other'])
    expect(armed).toEqual(['other', 'pusher'])
    expect(armCalls).toEqual([
      { sessionId: 'session-1', sources: ['pusher', 'other'], workspaceId: 'workspace-1' },
    ])
  })

  it('refuses a payload that is not a list of names, without touching the session', async () => {
    // The transposition guard's other half: a caller that sent one name as a
    // bare string, or a list with a non-string in it, must be refused rather
    // than have `String(...)` quietly applied to it — an arming is a grant, and
    // a grant coerced from the wrong shape names a server nobody chose.
    const { registered, armCalls } = harness()
    const handler = registered.get(RPC_CHANNELS.permissions.ARM_SESSION_CHANNEL_SOURCES)!
    await expect(handler(ctx, 'session-1', 'workspace-1', 'pusher' as never)).rejects.toThrow(
      /array of server names/,
    )
    await expect(handler(ctx, 'session-1', 'workspace-1', ['pusher', 7] as never)).rejects.toThrow(
      /array of server names/,
    )
    expect(armCalls).toEqual([])
  })

  it('disarms the session and says nothing about the app-wide preference', async () => {
    const { registered, disarmCalls } = harness()
    const handler = registered.get(RPC_CHANNELS.permissions.DISARM_SESSION_CHANNEL_SOURCES)!
    await expect(handler(ctx, 'session-1', 'workspace-1')).resolves.toBeUndefined()
    expect(disarmCalls).toEqual([{ sessionId: 'session-1', workspaceId: 'workspace-1' }])
  })
})
