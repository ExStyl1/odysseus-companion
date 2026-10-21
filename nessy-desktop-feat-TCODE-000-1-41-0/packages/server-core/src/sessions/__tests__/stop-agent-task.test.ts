/**
 * L9 — `SessionManager.stopAgentTask`, the route the kill button never had.
 *
 * `killShell` has existed for the shell half of the Background Tasks list since
 * before this row. The AGENT half had nothing at all: the renderer logged
 * "Killing agent tasks not yet implemented" and removed the row anyway, so a
 * press told the user a task was killed while it kept running. These tests pin
 * the route and — more importantly — pin that a FAILURE is reported as one,
 * because the whole value of the row is that the caller may only drop the row on
 * a `success`.
 *
 * TWO ARMS, IN THE MODEL'S OWN ORDER, and the order is what the review caught.
 * `createStopTaskTool` — the `stopTask` tool the model has always had — calls
 * `BackgroundTaskRegistry.stop` FIRST and the durable `ChildSessionPort.stopTask`
 * only as a fallback. The first version of this method went straight to the
 * host-side child service, which cannot stop a `kind: 'mcp'` task at all (no child
 * record exists) and stops only ONE NODE of a background workflow while the DAG
 * script keeps scheduling. So:
 *   - arm 1 is `AgentInstance.stopBackgroundTask`, read structurally, which
 *     `PiAgent` now implements as "ask the subprocess's registry" and `ClaudeAgent`
 *     implements as `Query.stopTask`;
 *   - arm 2 is the host-side Pi `ChildSessionService`, for a durable background
 *     child the registry does not hold.
 * Two kinds refuse arm 2 outright, and `managed.piBackgroundTaskKinds` is how the
 * route knows which.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession, type SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-l9-stop-agent-task'

interface Rig {
  sm: SessionManager
  sessionId: string
  cleanup: () => void
}

function rig(options: {
  /** The backend lever, when this session's runtime has one. */
  stopBackgroundTask?: (taskId: string) => Promise<{ stopped: boolean; error?: string }>
  /** The host-side Pi child service, when one has been created for this session. */
  piStopTask?: (taskId: string) => Promise<void>
  /** What `task_backgrounded` recorded for each id, which is what the route reads. */
  kinds?: Record<string, 'workflow' | 'subagent' | 'mcp'>
  /**
   * P6.793 — the OTHER direction's lever. Given, this session's runtime has it
   * (claude, or codex refusing by name); omitted, the backend has no such method
   * at all, which is Pi and every older build.
   */
  backgroundInFlightTasks?: (toolUseId?: string) => Promise<{ backgrounded: boolean; error?: string; unsupported?: true }>
} = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), 'nessy-l9-stop-agent-task-'))
  const sm = createTestSessionManager()
  const sessionId = 'session-l9-stop-agent-task'
  const managed = createManagedSession(
    { id: sessionId, name: 'L9 stop agent task' },
    {
      id: WORKSPACE_ID,
      name: 'L9 Workspace',
      rootPath: root,
      createdAt: Date.now(),
    } as never,
    { messagesLoaded: true },
  )
  if (options.stopBackgroundTask || options.backgroundInFlightTasks) {
    ;(managed as { agent?: unknown }).agent = {
      ...(options.stopBackgroundTask ? { stopBackgroundTask: options.stopBackgroundTask } : {}),
      ...(options.backgroundInFlightTasks ? { backgroundInFlightTasks: options.backgroundInFlightTasks } : {}),
    }
  }
  for (const [taskId, kind] of Object.entries(options.kinds ?? {})) {
    managed.piBackgroundTaskKinds ??= new Map()
    managed.piBackgroundTaskKinds.set(taskId, kind)
  }
  ;(sm as unknown as { sessions: Map<string, typeof managed> })
    .sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }), managed)
  if (options.piStopTask) {
    ;(sm as unknown as { piChildSessionServices: Map<string, unknown> })
      .piChildSessionServices.set(
        encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
        { stopTask: options.piStopTask },
      )
  }
  return { sm, sessionId, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('SessionManager.stopAgentTask — the backend lever', () => {
  it("routes to the runtime's own stop and reports success", async () => {
    const calls: string[] = []
    const { sm, sessionId, cleanup } = rig({
      stopBackgroundTask: async taskId => { calls.push(taskId); return { stopped: true } },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'task_7', WORKSPACE_ID)).toEqual({ success: true })
      expect(calls).toEqual(['task_7'])
    } finally {
      cleanup()
    }
  })

  it("reports the runtime's refusal instead of rounding it up to success", async () => {
    const { sm, sessionId, cleanup } = rig({
      stopBackgroundTask: async () => ({ stopped: false, error: 'This Claude session is not running any background task.' }),
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'task_7', WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'failed',
        error: 'This Claude session is not running any background task.',
      })
    } finally {
      cleanup()
    }
  })

  it('turns a thrown backend call into a reported failure, never a rejected RPC', async () => {
    const { sm, sessionId, cleanup } = rig({
      stopBackgroundTask: async () => { throw new Error('the live session went away') },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'task_7', WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'failed',
        error: 'the live session went away',
      })
    } finally {
      cleanup()
    }
  })

  it('reports an unknown session instead of throwing at the RPC boundary', async () => {
    const { sm, cleanup } = rig()
    try {
      expect(await sm.stopAgentTask('no-such-session', 'task_7', WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'session-not-found',
      })
    } finally {
      cleanup()
    }
  })
})

/**
 * THE ORDER, which the first version had backwards.
 *
 * Every test here has a control that could fail: the same rig with arm 1 removed
 * reaches arm 2, so "arm 2 was not called" is a measurement rather than a hope.
 */
describe('SessionManager.stopAgentTask — registry first, child service as the fallback', () => {
  it('asks the registry before the durable child service', async () => {
    const order: string[] = []
    const { sm, sessionId, cleanup } = rig({
      stopBackgroundTask: async () => { order.push('registry'); return { stopped: true } },
      piStopTask: async () => { order.push('child') },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'task_7', WORKSPACE_ID)).toEqual({ success: true })
      expect(order).toEqual(['registry'])
    } finally {
      cleanup()
    }
  })

  it('falls through to the child service when the registry does not hold the id', async () => {
    // `stopped: false` with NO error is the registry saying "not mine" — a durable
    // child admitted by a previous generation, exactly the case arm 2 exists for.
    const order: string[] = []
    const { sm, sessionId, cleanup } = rig({
      stopBackgroundTask: async () => { order.push('registry'); return { stopped: false } },
      piStopTask: async () => { order.push('child') },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'bg-1', WORKSPACE_ID)).toEqual({ success: true })
      expect(order).toEqual(['registry', 'child'])
    } finally {
      cleanup()
    }
  })

  it('does NOT fall through when the registry owned the id and failed', async () => {
    // A second mechanism on a half-stopped tree turns a reportable failure into a
    // confident lie, so an `error` from arm 1 ends the sequence.
    const order: string[] = []
    const { sm, sessionId, cleanup } = rig({
      stopBackgroundTask: async () => { order.push('registry'); return { stopped: false, error: 'background-task-stop-failed:bg-1' } },
      piStopTask: async () => { order.push('child') },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'bg-1', WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'failed',
        error: 'background-task-stop-failed:bg-1',
      })
      expect(order).toEqual(['registry'])
    } finally {
      cleanup()
    }
  })
})

/**
 * THE TWO KINDS THAT REFUSE THE FALLBACK.
 *
 * Both are measured against a rig whose child service WOULD have answered
 * `success`, so what is pinned is a deliberate refusal and not an absent service.
 */
describe('SessionManager.stopAgentTask — the kinds the child service cannot honestly stop', () => {
  it('an mcp task is never routed to the child service, which has no record of it', async () => {
    const child: string[] = []
    const { sm, sessionId, cleanup } = rig({
      piStopTask: async taskId => { child.push(taskId) },
      kinds: { 'task-mcp-1': 'mcp' },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'task-mcp-1', WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'unreachable-mcp',
      })
      expect(child).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('a workflow is never reported stopped when only its current node could be killed', async () => {
    // The registry entry owns the DAG script's AbortController. Killing the node's
    // child leaves the script free to schedule the next node — and reporting
    // `success` would drop the row while the workflow ran on.
    const child: string[] = []
    const { sm, sessionId, cleanup } = rig({
      piStopTask: async taskId => { child.push(taskId) },
      kinds: { 'wf-1': 'workflow' },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'wf-1', WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'unreachable-workflow',
      })
      expect(child).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('the control: a SUBAGENT id on the identical rig does reach the child service', async () => {
    const child: string[] = []
    const { sm, sessionId, cleanup } = rig({
      piStopTask: async taskId => { child.push(taskId) },
      kinds: { 'bg-1': 'subagent' },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'bg-1', WORKSPACE_ID)).toEqual({ success: true })
      expect(child).toEqual(['bg-1'])
    } finally {
      cleanup()
    }
  })

  it('a workflow the registry DID stop is still a success — the refusal is only the fallback', async () => {
    const { sm, sessionId, cleanup } = rig({
      stopBackgroundTask: async () => ({ stopped: true }),
      piStopTask: async () => { throw new Error('must not be reached') },
      kinds: { 'wf-1': 'workflow' },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'wf-1', WORKSPACE_ID)).toEqual({ success: true })
    } finally {
      cleanup()
    }
  })
})

describe('SessionManager.stopAgentTask — the Pi child-service arm', () => {
  it("stops a background child through the same service the model's stop_task tool uses", async () => {
    const calls: string[] = []
    const { sm, sessionId, cleanup } = rig({ piStopTask: async taskId => { calls.push(taskId) } })
    try {
      expect(await sm.stopAgentTask(sessionId, 'bg-1', WORKSPACE_ID)).toEqual({ success: true })
      expect(calls).toEqual(['bg-1'])
    } finally {
      cleanup()
    }
  })

  it("classifies the service's own identity check as a stale id, not as a crash", async () => {
    // `ChildSessionService.stopTask` throws `unknown-task-id:<id>` when no
    // starting/running background child matches — the strongest identity check
    // either arm has. It used to reach the user's toast VERBATIM; now it becomes a
    // code and the raw token survives only as detail.
    const { sm, sessionId, cleanup } = rig({
      piStopTask: async taskId => { throw new Error(`unknown-task-id:${taskId}`) },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'bg-9', WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'unknown-task',
        error: 'unknown-task-id:bg-9',
      })
    } finally {
      cleanup()
    }
  })

  it('any other service failure stays a failure', async () => {
    const { sm, sessionId, cleanup } = rig({
      piStopTask: async () => { throw new Error('worktree lease lost') },
    })
    try {
      expect(await sm.stopAgentTask(sessionId, 'bg-9', WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'failed',
        error: 'worktree lease lost',
      })
    } finally {
      cleanup()
    }
  })

  it('refuses honestly when the session has neither lever', async () => {
    const { sm, sessionId, cleanup } = rig()
    try {
      expect(await sm.stopAgentTask(sessionId, 'task_7', WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'unsupported',
      })
    } finally {
      cleanup()
    }
  })
})

/**
 * DE-DUPLICATION. The button stays on screen while the request is out, so a second
 * press is not hypothetical — and without this the second press runs the whole
 * sequence again, finds the task already gone, and raises an error toast on top of
 * a stop that worked.
 */
describe('SessionManager.stopAgentTask — a second press joins the first', () => {
  it('runs the stop once for two concurrent presses on the same id', async () => {
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const { sm, sessionId, cleanup } = rig({
      stopBackgroundTask: async () => { calls += 1; await gate; return { stopped: true } },
    })
    try {
      const first = sm.stopAgentTask(sessionId, 'task_7', WORKSPACE_ID)
      const second = sm.stopAgentTask(sessionId, 'task_7', WORKSPACE_ID)
      release()
      expect(await first).toEqual({ success: true })
      expect(await second).toEqual({ success: true })
      expect(calls).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('does not collapse two DIFFERENT ids into one stop', async () => {
    const seen: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const { sm, sessionId, cleanup } = rig({
      stopBackgroundTask: async taskId => { seen.push(taskId); await gate; return { stopped: true } },
    })
    try {
      const a = sm.stopAgentTask(sessionId, 'task_7', WORKSPACE_ID)
      const b = sm.stopAgentTask(sessionId, 'task_8', WORKSPACE_ID)
      release()
      await a
      await b
      expect(seen.sort()).toEqual(['task_7', 'task_8'])
    } finally {
      cleanup()
    }
  })

  it('a later press after the first settled runs again', async () => {
    let calls = 0
    const { sm, sessionId, cleanup } = rig({
      stopBackgroundTask: async () => { calls += 1; return { stopped: true } },
    })
    try {
      await sm.stopAgentTask(sessionId, 'task_7', WORKSPACE_ID)
      await sm.stopAgentTask(sessionId, 'task_7', WORKSPACE_ID)
      expect(calls).toBe(2)
    } finally {
      cleanup()
    }
  })
})

/**
 * P6.793 — `SessionManager.backgroundInFlightTasks`, the route for the SDK's own
 * `Query.backgroundTasks`.
 *
 * `stopAgentTask`'s opposite direction, and the four outcomes are four because
 * collapsing any two of them puts a wrong sentence on screen: a runtime with no
 * lever, a lever with nothing to act on, a lever that broke, and success.
 * `unsupported` is the one this row exists for — on codex the press would
 * otherwise look accepted and change nothing.
 */
describe('SessionManager.backgroundInFlightTasks (P6.793)', () => {
  it("routes to the runtime's own lever and reports the acceptance", async () => {
    const calls: (string | undefined)[] = []
    const { sm, sessionId, cleanup } = rig({
      backgroundInFlightTasks: async toolUseId => { calls.push(toolUseId); return { backgrounded: true } },
    })
    try {
      expect(await sm.backgroundInFlightTasks(sessionId, 'toolu_01', WORKSPACE_ID))
        .toEqual({ backgrounded: true })
      // No id is the SDK's "all foreground tasks" mode and must reach it as
      // `undefined` rather than being turned into a string by the route.
      expect(await sm.backgroundInFlightTasks(sessionId, undefined, WORKSPACE_ID))
        .toEqual({ backgrounded: true })
      expect(calls).toEqual(['toolu_01', undefined])
    } finally {
      cleanup()
    }
  })

  it('a backend with NO lever is `unsupported`, and so is one that refuses by name', async () => {
    // Two ways to have no lever, one sentence. Pi omits the method; codex
    // implements it solely to refuse, because from here an absent method and a
    // refusing one look identical and only the second can carry a reason.
    const absent = rig()
    try {
      expect(await absent.sm.backgroundInFlightTasks(absent.sessionId, undefined, WORKSPACE_ID))
        .toEqual({ backgrounded: false, reason: 'unsupported' })
    } finally {
      absent.cleanup()
    }

    const refusing = rig({ backgroundInFlightTasks: async () => ({ backgrounded: false, unsupported: true as const }) })
    try {
      expect(await refusing.sm.backgroundInFlightTasks(refusing.sessionId, undefined, WORKSPACE_ID))
        .toEqual({ backgrounded: false, reason: 'unsupported' })
    } finally {
      refusing.cleanup()
    }
  })

  it('a bare false is `nothing-running`, NOT a failure', async () => {
    // The SDK's documented `false`: a toolUseId that matched no foreground task.
    // Rounding it into `failed` would tell the user their press broke.
    const { sm, sessionId, cleanup } = rig({
      backgroundInFlightTasks: async () => ({ backgrounded: false }),
    })
    try {
      expect(await sm.backgroundInFlightTasks(sessionId, 'toolu_missing', WORKSPACE_ID))
        .toEqual({ backgrounded: false, reason: 'nothing-running' })
    } finally {
      cleanup()
    }
  })

  it('reports a broken lever as a failure, and a throw as one too', async () => {
    const errored = rig({ backgroundInFlightTasks: async () => ({ backgrounded: false, error: 'control request refused' }) })
    try {
      expect(await errored.sm.backgroundInFlightTasks(errored.sessionId, undefined, WORKSPACE_ID))
        .toEqual({ backgrounded: false, reason: 'failed', error: 'control request refused' })
    } finally {
      errored.cleanup()
    }

    const throwing = rig({ backgroundInFlightTasks: async () => { throw new Error('child is gone') } })
    try {
      expect(await throwing.sm.backgroundInFlightTasks(throwing.sessionId, undefined, WORKSPACE_ID))
        .toEqual({ backgrounded: false, reason: 'failed', error: 'child is gone' })
    } finally {
      throwing.cleanup()
    }
  })

  it('an unknown session is `session-not-found`, not `unsupported`', async () => {
    const { sm, cleanup } = rig({ backgroundInFlightTasks: async () => ({ backgrounded: true }) })
    try {
      expect(await sm.backgroundInFlightTasks('session-that-never-existed', undefined, WORKSPACE_ID))
        .toEqual({ backgrounded: false, reason: 'session-not-found' })
    } finally {
      cleanup()
    }
  })
})
