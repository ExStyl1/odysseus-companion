/**
 * P6.275 — one gesture stops every background subagent and background shell.
 *
 * Measured before building: every per-ITEM route already exists on all three
 * runtimes. `killShell` sends a non-Pi handle to
 * `AgentInstance.stopBackgroundTask` (claude's `Query.stopTask`, codex's own
 * lever) and a Pi one to `piProcessSupervisor.stop`; `stopAgentTask` runs the
 * backend lever and then the host-side Pi child service. What did not exist is
 * the AGGREGATE — stopping ten items meant ten gestures — and no runtime has a
 * mechanism for it, so this is host case (2): one implementation, over routes
 * that already answer honestly.
 *
 * The arms assert ROUTING, BOUNDING and REPORTING. Nothing new decides whether
 * an item stops: a lie here would be a lie the per-item route already tells, and
 * the inventory is the same one the `background_tasks` hook payload reports, so
 * a hook that listed the work and a user who stopped it see one list.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'

type Child = { agentId: string; backgroundTaskId?: string; agent: string; task: string; status: string }

function harness(sources: {
  shells?: Array<[string, string]>
  children?: Child[]
}) {
  const killed: string[] = []
  const stoppedTasks: string[] = []
  let live = 0
  let peak = 0
  const manager = createTestSessionManager() as any
  const managed = { id: 'session-1', workspace: { id: 'workspace-1' } }
  manager.getManaged = () => managed
  manager.hookTaskRegistrySources = () => ({
    monitors: [],
    children: sources.children ?? [],
    evaluatorKinds: [],
    shells: sources.shells ?? [],
  })
  const track = async <T>(run: () => Promise<T>): Promise<T> => {
    live += 1
    peak = Math.max(peak, live)
    // A real yield, so concurrency is observable rather than assumed.
    await new Promise(resolve => setTimeout(resolve, 1))
    try { return await run() } finally { live -= 1 }
  }
  manager.killShell = (_sessionId: string, shellId: string) => track(async () => {
    killed.push(shellId)
    return shellId === 'shell-refuses'
      ? { success: false, error: 'Unknown supervised process handle' }
      : { success: true }
  })
  manager.stopAgentTask = (_sessionId: string, taskId: string) => track(async () => {
    stoppedTasks.push(taskId)
    return taskId === 'task-refuses' ? { success: false, reason: 'unknown-task-id' } : { success: true }
  })
  return { manager, killed, stoppedTasks, peak: () => peak }
}

describe('P6.275 one gesture, every background item', () => {
  test('routes a shell to killShell and a subagent to stopAgentTask', async () => {
    const rig = harness({
      shells: [['shell-1', 'npm test'], ['shell-2', 'bun run dev']],
      children: [{ agentId: 'child-1', backgroundTaskId: 'task-1', agent: 'reviewer', task: 'review', status: 'running' }],
    })

    const result = await rig.manager.stopAllBackgroundWork('session-1', 'workspace-1')

    expect(result.stopped).toBe(3)
    expect(result.failed).toEqual([])
    expect(rig.killed.sort()).toEqual(['shell-1', 'shell-2'])
    expect(rig.stoppedTasks).toEqual(['task-1'])
  })

  test('a session with no background work is REFUSED by name', async () => {
    const rig = harness({})

    const result = await rig.manager.stopAllBackgroundWork('session-1', 'workspace-1')

    // Not a cheerful success: a gesture that reports success for work it did not
    // find teaches the user it worked when it did not run.
    expect(result).toEqual({ stopped: 0, failed: [], reason: 'nothing-to-stop' })
  })

  test('a refusal is reported per item and does not stop the rest', async () => {
    const rig = harness({
      shells: [['shell-refuses', 'stuck'], ['shell-2', 'bun run dev']],
      children: [{ agentId: 'c', backgroundTaskId: 'task-refuses', agent: 'a', task: 't', status: 'running' }],
    })

    const result = await rig.manager.stopAllBackgroundWork('session-1', 'workspace-1')

    expect(result.stopped).toBe(1)
    expect(result.failed).toHaveLength(2)
    // The route's own words, carried rather than flattened: `killShell` answers
    // with an `error`, `stopAgentTask` with a stable `reason` code.
    expect(result.failed.find((f: { id: string }) => f.id === 'shell-refuses')?.error)
      .toContain('Unknown supervised process handle')
    expect(result.failed.find((f: { id: string }) => f.id === 'task-refuses')?.reason).toBe('unknown-task-id')
  })

  test('the fan-out is BOUNDED at four, whatever the session holds', async () => {
    const rig = harness({
      shells: Array.from({ length: 12 }, (_, index) => [`shell-${index}`, 'cmd'] as [string, string]),
    })

    const result = await rig.manager.stopAllBackgroundWork('session-1', 'workspace-1')

    expect(result.stopped).toBe(12)
    // Electron does not inherit the shell's `ulimit -n` (floor 256 here) and
    // each stop can open a control channel, so the fan-out must not fire every
    // stop at once.
    expect(rig.peak()).toBeLessThanOrEqual(4)
    expect(rig.peak()).toBeGreaterThan(1)
  })

  test('an unknown session refuses by name rather than reporting nothing to do', async () => {
    const rig = harness({})
    rig.manager.getManaged = () => undefined
    const result = await rig.manager.stopAllBackgroundWork('no-such', 'workspace-1')
    expect(result.reason).toBe('session-not-found')
  })
})
