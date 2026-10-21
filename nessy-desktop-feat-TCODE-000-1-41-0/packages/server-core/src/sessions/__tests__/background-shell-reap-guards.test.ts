/**
 * P6.826 — `sessionQuiescence` had no supplier, so P6.346's memory-pressure
 * reaper could not fire even when an operator configured it.
 *
 * `resolveBackgroundShellReaping` returns `{ reap: false }` for
 * `guards: undefined`, which is the right fail-safe and is exactly why nothing
 * was broken — and exactly why nothing worked either. This is the supplier, and
 * the two things worth pinning about it are the two failure directions:
 *
 *  1. it must say BUSY while a turn or a subagent is running, on every runtime,
 *     because the reaper acts under no user request and the cost of the other
 *     answer is destroyed work;
 *  2. it must NOT consult the process snapshot. The candidate for reaping is a
 *     running supervised process, so a guard derived from
 *     `liveAgentBusyDomainsFor` — which counts the `process` domain — would be
 *     busy by its own subject and the reaper would be structurally dead.
 *
 * Harness: a real manager overridden, `reconnect-mcp-server.test.ts`'s shape.
 */
import { describe, expect, test } from 'bun:test'
import { resolveBackgroundShellReaping } from '../../pi-harness/process-supervisor'
import { createTestSessionManager } from './test-session-manager.ts'

const KEY = { workspaceId: 'w', sessionId: 's' }

function managerWith(overrides: Record<string, unknown> = {}) {
  const manager = createTestSessionManager() as any
  const managed: any = {
    id: 's',
    workspace: { id: 'w', rootPath: '/tmp', name: 'w', createdAt: 1 },
    isProcessing: false,
    agentLastActiveAt: 1_000,
    ...overrides,
  }
  manager.getManaged = (sessionId: string) => (sessionId === 's' ? managed : undefined)
  manager.piChildSessionServices = new Map()
  manager.managedKey = () => 'w:s'
  return { manager, managed }
}

const guardsOf = (manager: any) => manager.backgroundShellReapGuards(KEY)

describe('P6.826 · the background-shell reap guards', () => {
  test('an idle session answers all three, and the reaper can then fire', () => {
    const { manager } = managerWith()
    const guards = guardsOf(manager)

    expect(guards).toEqual({ lastActiveAt: 1_000, turnRunning: false, subagentRunning: false })

    // End to end through the supervisor's own pure decision, so this is not a
    // shape assertion: with the supplier absent the same call answers `false`.
    const now = 1_000 + 31 * 60_000
    const pressure = { now, freeBytes: 1, totalBytes: 100, thresholdPercent: 10 }
    expect(resolveBackgroundShellReaping({ guards, ...pressure }).reap).toBe(true)
    expect(resolveBackgroundShellReaping({ guards: undefined, ...pressure }).reap).toBe(false)
  })

  test('a running turn is busy — host flag or BACKEND flag, since claude holds its own', () => {
    const host = guardsOf(managerWith({ isProcessing: true }).manager)
    expect(host.turnRunning).toBe(true)

    const backend = guardsOf(managerWith({ agent: { isProcessing: () => true } }).manager)
    expect(backend.turnRunning).toBe(true)
  })

  test('a running subagent is busy through each of its three counters', () => {
    const child = guardsOf(managerWith({
      childSessionState: { children: [{ status: 'running' }] },
    }).manager)
    expect(child.subagentRunning).toBe(true)

    const task = guardsOf(managerWith({
      piBackgroundTaskKinds: new Map([['t', 'subagent']]),
    }).manager)
    expect(task.subagentRunning).toBe(true)

    // L5's input: claude backgrounds by default and emits no `task_backgrounded`,
    // so the host-side map is empty and only the backend's own count sees it.
    const backend = guardsOf(managerWith({ agent: { backgroundWorkCount: () => 1 } }).manager)
    expect(backend.subagentRunning).toBe(true)
  })

  test('a FINISHED child does not hold the shell — the counter is by status, not by presence', () => {
    const guards = guardsOf(managerWith({
      childSessionState: { children: [{ status: 'completed' }, { status: 'failed' }] },
    }).manager)
    expect(guards.subagentRunning).toBe(false)
  })

  test('an unknown session answers undefined, keeping the supervisor’s fail-safe', () => {
    const { manager } = managerWith()
    expect(manager.backgroundShellReapGuards({ workspaceId: 'w', sessionId: 'gone' })).toBeUndefined()
  })
})
