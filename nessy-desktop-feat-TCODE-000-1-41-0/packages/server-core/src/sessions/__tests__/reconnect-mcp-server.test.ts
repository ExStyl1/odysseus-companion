/**
 * P6.711 - the host verb that reaches ONE of a session's MCP servers.
 *
 * W9-k landed `McpClientPool.reconnect(slug, leaserId?)` and could not land the
 * renderer half: the pool is per MANAGED SESSION and `HandlerDeps` publishes no
 * accessor for one, so nothing outside `SessionManager` could reach it. This is
 * that method, and these are the two things about it that are not obvious from
 * its four lines.
 *
 * Harness: a real manager with the two collaborators the method touches
 * overridden, in `goal-reaches-every-runtime.test.ts`'s shape.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'

function managerWith(pool: unknown, leaserId?: string, agent?: unknown) {
  const manager = createTestSessionManager() as any
  const managed: any = {
    id: 's',
    workspace: { id: 'w', rootPath: '/tmp', name: 'w', createdAt: 1 },
    ...(pool === undefined ? {} : { mcpPool: pool }),
    ...(leaserId === undefined ? {} : { mcpLeaserId: leaserId }),
    ...(agent === undefined ? {} : { agent }),
  }
  manager.sessions = new Map([['w:s', managed]])
  manager.getManaged = (sessionId: string) => (sessionId === 's' ? managed : undefined)
  return { manager, managed }
}

describe('P6.711 · SessionManager.reconnectMcpServer', () => {
  test('reaches the session\'s own pool and hands back its verdict unchanged', async () => {
    const calls: Array<readonly [string, string | undefined]> = []
    const { manager } = managerWith({
      reconnect: async (slug: string, leaserId?: string) => {
        calls.push([slug, leaserId])
        return { ok: false, reason: 'failed', detail: 'stdio server exited' }
      },
    }, 'lease-7')

    const result = await manager.reconnectMcpServer('s', 'github')

    // The verdict travels verbatim: each of the pool's four reasons is
    // something the panel renders, so collapsing them into a throw - or into a
    // boolean - would lose the answer this verb exists to give.
    expect(result).toEqual({ ok: false, reason: 'failed', detail: 'stdio server exited' })
    // THE SECURITY HALF: the leaser id is passed and never omitted. A pool can
    // be shared across a workspace's sessions, and the leaser is what confines
    // the lookup to the connection THIS session resolved the slug to - a slug
    // is a user-chosen string, not an authority.
    expect(calls).toEqual([['github', 'lease-7']])
  })

  test('answers unknown-server for a session with no pool, and never invents a pool call', async () => {
    const { manager } = managerWith(undefined)

    expect(await manager.reconnectMcpServer('s', 'github'))
      .toEqual({ ok: false, reason: 'unknown-server' })

    // And for a session that is not there at all - the same one of the four
    // verdicts, because from the panel's side both ARE "this session holds no
    // such server", and a throw would make one of them look like a fault.
    expect(await manager.reconnectMcpServer('missing', 'github'))
      .toEqual({ ok: false, reason: 'unknown-server' })
  })

  test('a session that never leased passes no leaser rather than a wrong one', async () => {
    const calls: Array<string | undefined> = []
    const { manager } = managerWith({
      reconnect: async (_slug: string, leaserId?: string) => {
        calls.push(leaserId)
        return { ok: true }
      },
    })

    expect(await manager.reconnectMcpServer('s', 'github')).toEqual({ ok: true })
    // `undefined` is the pool's own "this is a private pool" case. Substituting
    // any other id would point the lookup at a connection this session does not
    // hold.
    expect(calls).toEqual([undefined])
  })

  /**
   * P6.711 hand-off 1 — the claude LEG.
   *
   * Routing is not a refinement here: on a claude session the servers the model
   * can see are the CHILD's, so the pool call restarts the host's copy and the
   * model still faces the dead server. `ClaudeAgent.reconnectMcpServer` falls
   * back to this same pool with this same leaser when no child is live, which is
   * why the route can be unconditional on the method's presence.
   */
  test('a backend that publishes its own reconnect verb is asked instead of the pool', async () => {
    const poolCalls: string[] = []
    const agentCalls: string[] = []
    const { manager } = managerWith(
      { reconnect: async (slug: string) => { poolCalls.push(slug); return { ok: true } } },
      'lease-7',
      { reconnectMcpServer: async (slug: string) => { agentCalls.push(slug); return { ok: true } } },
    )

    const result = await manager.reconnectMcpServer('s', 'github')

    expect(result).toEqual({ ok: true })
    expect(agentCalls).toEqual(['github'])
    // The pool is not ALSO dialled: two reconnects for one click would restart
    // a healthy host connection every time the child's one was restarted.
    expect(poolCalls).toEqual([])
  })

  test('a backend without the verb still goes to the pool, with the leaser — the control', async () => {
    const calls: Array<readonly [string, string | undefined]> = []
    const { manager } = managerWith(
      { reconnect: async (slug: string, leaserId?: string) => { calls.push([slug, leaserId]); return { ok: true } } },
      'lease-7',
      // Pi and codex publish no per-server reconnect verb; an agent object is
      // present on every live session, so absence of the METHOD is the test.
      { isProcessing: () => false },
    )

    expect(await manager.reconnectMcpServer('s', 'github')).toEqual({ ok: true })
    expect(calls).toEqual([['github', 'lease-7']])
  })
})
