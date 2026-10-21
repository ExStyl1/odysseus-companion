/**
 * UA1.19 follow-up — the Published pages RPC reaches the SHIPPED client factory (`SessionManager.createArtifactsClient`,
 * the one `publish_artifact` uses), so the host's managed network policy fences the list exactly as it fences a
 * publish. Driven with a real SessionManager and NO client seam: a policy that denies the service's host refuses the
 * list before dp is asked for a token and before any request (UA1.16 fence 3 runs first).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { ArtifactsListResult } from '@nessy-agent/shared/protocol'
import type { RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerArtifactsHandlers } from '../artifacts'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ua119-binding-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function register(sessionManager: unknown) {
  const handlers = new Map<string, (ctx: RequestContext, ...args: unknown[]) => unknown>()
  const server = { handle: (channel: string, fn: (ctx: RequestContext, ...args: unknown[]) => unknown) => { handlers.set(channel, fn) } } as unknown as RpcServer
  registerArtifactsHandlers(server, {
    workspaceService: { resolve: (id: string) => ({ id, workspaceRootPath: root }) },
    windowManager: { getWorkspaceForWindow: () => 'ws-a' },
    sessionManager,
  } as unknown as HandlerDeps)
  const ctx: RequestContext = { clientId: 'c1', workspaceId: 'ws-a', webContentsId: 1 }
  return (channel: string, ...args: unknown[]) => handlers.get(channel)!(ctx, ...args)
}

describe('UA1.19 — the list uses the shipped client factory', () => {
  test('a managed deny of the service host refuses the list as policy — no token read, no request', async () => {
    const manager = createTestSessionManager()
    const internals = manager as unknown as { sandboxSettings: { network: Record<string, unknown> } }
    Object.assign(internals, { sandboxSettings: { ...internals.sandboxSettings, network: { deniedDomains: ['t-artifacts.t-tech.team'] } } })
    const call = register(manager)
    const result = await call(RPC_CHANNELS.artifacts.LIST, 'ws-a') as ArtifactsListResult
    expect(result.status).toBe('unavailable')
    expect(result.errorKind).toBe('policy')
    expect(result.message).toContain('sandbox.network.deniedDomains')
  })

  test('negative: a session manager without the accessor is refused as unavailable, never given an unfenced client', async () => {
    const call = register({})
    await expect(Promise.resolve().then(() => call(RPC_CHANNELS.artifacts.LIST, 'ws-a'))).rejects.toThrow('artifacts-unavailable')
  })
})
