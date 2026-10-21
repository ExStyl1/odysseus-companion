/**
 * P6.510 — a channel opt-in made for one piece of work is permanent and
 * invisible thereafter.
 *
 * `channels` specifies a per-SESSION act; ours was an app-wide preference
 * (`mcpChannelPushEnabled`, default `false`), so the only way to let one server
 * push into one turn was to grant every server that right in every future
 * session. Delegated decision 2026-09-05 (Q-den 37) chose option 2: a
 * per-session arming set SEEDED from the persistent preference.
 *
 * These arms drive the REAL `resolveChannelPolicy` — the sibling
 * `mcp-channel-gate.test.ts` stubs it, deliberately, because its subject is the
 * delivery discipline rather than the resolution. Here the resolution IS the
 * subject, so nothing about it is replaced: `getMcpChannelPushEnabled()` reads
 * the real (isolated, default-off) config and the managed policy is the real
 * `parseManagedPiPolicyV1` product.
 */
import { describe, expect, test } from 'bun:test'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { SdkMcpServerConfig } from '@nessy-agent/shared/agent/backend/types'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { McpClientPool, MCP_CHANNEL_CAPABILITY, type McpChannelMessage, type PoolClient } from '@nessy-agent/shared/mcp'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

const TOOLS: Tool[] = [{ name: 'test-tool', inputSchema: { type: 'object' as const, properties: {} } }]

/** A server that DECLARES `claude/channel`, so the handshake precondition (P6.341) is met. */
function channelClient(): PoolClient {
  return {
    listTools: async () => TOOLS,
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    close: async () => {},
    getServerCapabilities: () => ({ tools: {}, experimental: { [MCP_CHANNEL_CAPABILITY]: {} } }),
    setChannelHandler(_next: ((message: McpChannelMessage) => void) | undefined) {},
  }
}

class TestPool extends McpClientPool {
  protected override async openConnection(): Promise<PoolClient> {
    return channelClient()
  }
}

async function session(managedPolicy?: Record<string, unknown>) {
  const manager = createTestSessionManager(
    managedPolicy ? { managedPiPolicy: parseManagedPiPolicyV1(managedPolicy) } : {},
  )
  const pool = new TestPool()
  await pool.sync(
    { pusher: { type: 'http', url: 'https://mcp.example.com' }, other: { type: 'http', url: 'https://other.example.com' } },
    {},
    { leaserId: 'leaser-1' },
  )
  const managed: Record<string, unknown> = {
    id: 'session-1',
    workspace: { id: 'workspace-1', rootPath: '/tmp/workspace-1' },
    mcpPool: pool,
    mcpLeaserId: 'leaser-1',
  }
  const internals = manager as unknown as { sessions: Map<string, unknown>; sendEvent(event: unknown, workspaceId: string): void }
  internals.sessions.set(encodeSessionKey({ workspaceId: 'workspace-1', sessionId: 'session-1' }), managed)
  const events: Array<{ message?: string }> = []
  internals.sendEvent = event => { events.push(event as { message?: string }) }
  return { manager, pool, managed, events }
}

describe('a channel grant can be made for one session', () => {
  test('with the app-wide preference off, arming one source installs its dispatcher and only its', async () => {
    const h = await session()
    expect(h.pool.hasChannelHandler('pusher')).toBe(false)
    expect(h.manager.armSessionChannelSources('session-1', ['pusher'], 'workspace-1')).toEqual(['pusher'])
    expect(h.pool.hasChannelHandler('pusher')).toBe(true)
    // The other connected source was not armed, so the preference stays what it
    // was: off. Arming is a grant to a named server, not a master switch.
    expect(h.pool.hasChannelHandler('other')).toBe(false)
    h.manager.cleanup()
  })

  test('several servers can be armed at once, and arming is additive and idempotent', async () => {
    const h = await session()
    h.manager.armSessionChannelSources('session-1', ['pusher'], 'workspace-1')
    expect(h.manager.armSessionChannelSources('session-1', ['other', 'pusher'], 'workspace-1'))
      .toEqual(['other', 'pusher'])
    expect(h.pool.hasChannelHandler('pusher')).toBe(true)
    expect(h.pool.hasChannelHandler('other')).toBe(true)
    h.manager.cleanup()
  })

  test('a session that armed nothing gets no dispatcher — CHANNEL_PUSH_OFF stays fail-closed', async () => {
    const h = await session()
    expect(h.pool.hasChannelHandler('pusher')).toBe(false)
    expect(h.pool.hasChannelHandler('other')).toBe(false)
    h.manager.cleanup()
  })

  test('the managed allowlist still bounds what a session may arm', async () => {
    const h = await session({ schemaVersion: 1, disabledPermissionModes: [], allowedChannelServers: ['other'] })
    h.manager.armSessionChannelSources('session-1', ['pusher', 'other'], 'workspace-1')
    // `pusher` is outside the administrator's list, so the session's own act
    // cannot reach it; `other` is inside it and is armed.
    expect(h.pool.hasChannelHandler('pusher')).toBe(false)
    expect(h.pool.hasChannelHandler('other')).toBe(true)
    h.manager.cleanup()
  })

  test('an administrator who turned channels off refuses the session grant outright', async () => {
    const h = await session({ schemaVersion: 1, disabledPermissionModes: [], channelsEnabled: false })
    h.manager.armSessionChannelSources('session-1', ['pusher'], 'workspace-1')
    expect(h.pool.hasChannelHandler('pusher')).toBe(false)
    h.manager.cleanup()
  })

  test('the grant is revoked with the session, and disarming revokes it early', async () => {
    const h = await session()
    h.manager.armSessionChannelSources('session-1', ['pusher'], 'workspace-1')
    expect(h.pool.hasChannelHandler('pusher')).toBe(true)
    h.manager.disarmSessionChannelSources('session-1', 'workspace-1')
    expect(h.pool.hasChannelHandler('pusher')).toBe(false)
    // The grant lives on the managed session object and nowhere else: it is
    // never handed to the session store, so nothing can restore it later.
    expect(Object.hasOwn(h.managed, 'armedChannelSources')).toBe(true)
    expect(h.managed.armedChannelSources).toBeUndefined()
    h.manager.cleanup()
  })

  test('the session-start notice names the scope that granted the arming', async () => {
    const h = await session()
    h.manager.armSessionChannelSources('session-1', ['pusher'], 'workspace-1')
    const messages = h.events.map(event => event.message ?? '')
    expect(messages.some(message => message.includes('armed for this session only'))).toBe(true)
    expect(messages.some(message => message.includes('stay armed in every session'))).toBe(false)
    h.manager.cleanup()
  })
})
