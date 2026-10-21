/**
 * L9 — `SessionManager.readBackgroundTaskOutput`, the read the "View Output" item
 * never had.
 *
 * **WHY A SECOND READ EXISTS, and it is a measurement rather than a preference.**
 * `getTaskOutput` is written in ONE place — the `task_completed` handler — and the
 * renderer retires the row on that same event. So for every row a user can see it
 * returns `null`, and the overlay said "No output available yet" about a command
 * that had printed megabytes. The last test in this file pins that ordering
 * directly, because it is the premise the whole row rests on: if `getTaskOutput`
 * ever starts answering for a RUNNING task, this route's reason for existing
 * changes and this file should say so.
 *
 * **THE HONEST-EMPTY CASE IS THE POINT.** Three answers used to be one:
 *   - the task printed nothing yet  → `success: true, output: ''`
 *   - nothing owns this id at all   → `success: false, reason: 'unknown-task'`
 *   - the owner cannot be reached   → `success: false, reason: 'unavailable'`
 * An empty overlay for the last two is the same shape of lie as a row that
 * vanished without stopping anything.
 *
 * **OWNERSHIP IS THE GATE**, and it is `killShell`'s gate: the handle must be in
 * this session's own `backgroundShellCommands`. A renderer cannot read another
 * session's process log by guessing an id — a property `getTaskOutput`, a global
 * index keyed by task id alone, does not have.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS, REMOTE_ELIGIBLE_CHANNELS } from '@nessy-agent/shared/protocol'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession, type SessionManager } from '../SessionManager.ts'
import { HANDLED_CHANNELS } from '../../handlers/rpc/sessions.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-l9-read-task-output'
const SESSION_ID = 'session-l9-read-task-output'
const FOREIGN_SESSION_ID = 'session-l9-someone-else'

interface ReadRequest {
  sessionKey: { workspaceId: string; sessionId: string }
  handle: string
  cursor?: number
}

interface Rig {
  sm: SessionManager
  reads: ReadRequest[]
  cleanup: () => void
}

function rig(options: {
  /** `shell_backgrounded`'s own map: handle → the command line. */
  shells?: Record<string, string>
  /** What the supervisor answers, or throws. */
  read?: (request: ReadRequest) => unknown
  /** A completed-task record, as `task_completed` would have left it. */
  completedOutput?: string
  /**
   * The same record, but owned by a SECOND live session in the manager.
   *
   * A live owner is what makes the ownership control real rather than vacuous: with
   * no such session, `getTaskOutput` finds the index entry, fails to resolve a
   * session for it, prunes the entry and returns `null` — so a rig with only one
   * session reports `unknown-task` whether the ownership check exists or not. That
   * mistake was made here first and caught by mutation.
   */
  foreignCompletedOutput?: string
} = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), 'nessy-l9-read-task-output-'))
  const sm = createTestSessionManager()
  const managed = createManagedSession(
    { id: SESSION_ID, name: 'L9 read task output' },
    {
      id: WORKSPACE_ID,
      name: 'L9 Workspace',
      rootPath: root,
      createdAt: Date.now(),
    } as never,
    { messagesLoaded: true },
  )
  for (const [handle, command] of Object.entries(options.shells ?? {})) {
    managed.backgroundShellCommands.set(handle, command)
  }
  const key = encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID })
  ;(sm as unknown as { sessions: Map<string, typeof managed> }).sessions.set(key, managed)

  const reads: ReadRequest[] = []
  ;(sm as unknown as { piProcessSupervisor: { read: (r: ReadRequest) => Promise<unknown> } })
    .piProcessSupervisor = {
      read: async request => {
        reads.push(request)
        if (!options.read) throw new Error('Unknown supervised process handle')
        return options.read(request)
      },
    }

  if (options.completedOutput !== undefined) {
    // The shape `task_completed` leaves behind, reached through `getTaskOutput`:
    // a real file on disk, so the primary branch is the one exercised rather than
    // its summary fallback.
    const outputFile = join(root, 'task_finished.log')
    writeFileSync(outputFile, options.completedOutput)
    managed.backgroundTaskOutputs.set('task_finished', {
      outputFile,
      summary: 'a summary nobody should read while the file is there',
      status: 'completed',
      completedAt: Date.now(),
    })
    ;(sm as unknown as { taskOutputIndex: Map<string, string> }).taskOutputIndex.set('task_finished', key)
  }

  if (options.foreignCompletedOutput !== undefined) {
    const foreign = createManagedSession(
      { id: FOREIGN_SESSION_ID, name: 'L9 someone else' },
      { id: WORKSPACE_ID, name: 'L9 Workspace', rootPath: root, createdAt: Date.now() } as never,
      { messagesLoaded: true },
    )
    const outputFile = join(root, 'foreign_task.log')
    writeFileSync(outputFile, options.foreignCompletedOutput)
    foreign.backgroundTaskOutputs.set('task_foreign', {
      outputFile,
      summary: 'a summary nobody should read while the file is there',
      status: 'completed',
      completedAt: Date.now(),
    })
    const foreignKey = encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId: FOREIGN_SESSION_ID })
    ;(sm as unknown as { sessions: Map<string, typeof foreign> }).sessions.set(foreignKey, foreign)
    ;(sm as unknown as { taskOutputIndex: Map<string, string> }).taskOutputIndex.set('task_foreign', foreignKey)
  }

  return { sm, reads, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('readBackgroundTaskOutput — a running shell', () => {
  it('returns the live log, the command, the cursor and the running flag', async () => {
    const { sm, reads, cleanup } = rig({
      shells: { shell_1: 'npm run build -- --watch' },
      read: () => ({
        handle: 'shell_1',
        output: 'built in 1.2s\n',
        nextCursor: 14,
        isRunning: true,
      }),
    })
    try {
      expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'shell_1', undefined, WORKSPACE_ID)).toEqual({
        success: true,
        // The COMMAND comes from the ownership map, not from the row's synthesised
        // label — that is the whole reason the gate reads the map first.
        command: 'npm run build -- --watch',
        output: 'built in 1.2s\n',
        nextCursor: 14,
        isRunning: true,
      })
      // Scoped to THIS session, so the supervisor's own assertOwner has a real key.
      expect(reads).toEqual([{ sessionKey: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID }, handle: 'shell_1', cursor: undefined }])
    } finally {
      cleanup()
    }
  })

  it('passes the cursor through, so a follow-up read does not re-read the log', async () => {
    const { sm, reads, cleanup } = rig({
      shells: { shell_1: 'tail -f app.log' },
      read: () => ({ handle: 'shell_1', output: 'line 2\n', nextCursor: 14, isRunning: true }),
    })
    try {
      await sm.readBackgroundTaskOutput(SESSION_ID, 'shell_1', 7, WORKSPACE_ID)
      expect(reads[0]!.cursor).toBe(7)
    } finally {
      cleanup()
    }
  })

  it('A COMMAND THAT HAS PRINTED NOTHING IS A SUCCESS, not "no output available"', async () => {
    // The honest-empty case. `output: ''` with `isRunning: true` is "running, nothing
    // yet"; it must never be collapsed into the failure path, which is exactly what
    // the `output || t('chat.noOutputYet')` idiom this route replaces did.
    const { sm, cleanup } = rig({
      shells: { shell_1: 'sleep 300' },
      read: () => ({ handle: 'shell_1', output: '', nextCursor: 0, isRunning: true }),
    })
    try {
      expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'shell_1', undefined, WORKSPACE_ID)).toEqual({
        success: true,
        command: 'sleep 300',
        output: '',
        nextCursor: 0,
        isRunning: true,
      })
    } finally {
      cleanup()
    }
  })

  it('carries the exit code once the process ended, and omits it while it runs', async () => {
    const ended = rig({
      shells: { shell_1: 'make test' },
      read: () => ({ handle: 'shell_1', output: 'FAIL\n', nextCursor: 5, isRunning: false, exitCode: 1 }),
    })
    try {
      const result = await ended.sm.readBackgroundTaskOutput(SESSION_ID, 'shell_1', undefined, WORKSPACE_ID)
      expect(result.exitCode).toBe(1)
      expect(result.isRunning).toBe(false)
    } finally {
      ended.cleanup()
    }

    // `exitCode` absent rather than `undefined`-valued: the overlay renders an exit
    // badge off its presence, so a running command must not carry the key at all.
    const running = rig({
      shells: { shell_1: 'make test' },
      read: () => ({ handle: 'shell_1', output: '', nextCursor: 0, isRunning: true, exitCode: undefined }),
    })
    try {
      const result = await running.sm.readBackgroundTaskOutput(SESSION_ID, 'shell_1', undefined, WORKSPACE_ID)
      expect('exitCode' in result).toBe(false)
    } finally {
      running.cleanup()
    }
  })
})

describe('readBackgroundTaskOutput — an id this session cannot read', () => {
  it('reports `unknown-task` for an id no source owns, rather than an empty log', async () => {
    // The honest answer for a Claude background task, a foreign id and an agent
    // task that is still running. An empty `output` here would tell the user the
    // command printed nothing.
    const { sm, reads, cleanup } = rig({ shells: { shell_1: 'sleep 300' } })
    try {
      expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'bash_1', undefined, WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'unknown-task',
      })
      // The supervisor was never asked: ownership is checked from our own map first,
      // so a guessed id cannot even reach the process store.
      expect(reads).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('reports `unknown-task` for an AGENT task that is still running', async () => {
    // There is nothing to gate on at this layer — an agent id simply is not in the
    // shell map and has no completed record — which is why the task chip's card (UB14.7)
    // offers no Open for a Pi agent row instead of offering an action that lands here.
    const { sm, cleanup } = rig()
    try {
      expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'task-agent-9', undefined, WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'unknown-task',
      })
    } finally {
      cleanup()
    }
  })

  it('reports `session-not-found` instead of throwing at the RPC boundary', async () => {
    const { sm, cleanup } = rig()
    try {
      expect(await sm.readBackgroundTaskOutput('no-such-session', 'shell_1', undefined, WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'session-not-found',
      })
    } finally {
      cleanup()
    }
  })

  it("separates 'the owner is gone' from 'the read went wrong'", async () => {
    // `process-recovery-*` is the supervisor's own family for "this host cannot
    // say" — L7 treats it as a non-answer rather than as proof, and so does this.
    for (const [thrown, reason] of [
      ['process-recovery-host-owner-unavailable', 'unavailable'],
      ['process-recovery-identity-mismatch', 'unavailable'],
      ['Unknown supervised process handle', 'unavailable'],
      ['EACCES: permission denied', 'failed'],
    ] as const) {
      const { sm, cleanup } = rig({
        shells: { shell_1: 'sleep 300' },
        read: () => { throw new Error(thrown) },
      })
      try {
        expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'shell_1', undefined, WORKSPACE_ID)).toEqual({
          success: false,
          reason,
          error: thrown,
        })
      } finally {
        cleanup()
      }
    }
  })
})

/**
 * THE HOST HALF OF THE CHAIN. The renderer half is pinned in
 * `apps/electron/src/renderer/components/app-shell/__tests__/background-task-chip.test.tsx`.
 * Between them, no link from the menu item to this method can be removed silently —
 * which is this plan's recurring failure mode: correct code that cannot be reached
 * from the product.
 */
describe('readBackgroundTaskOutput — the channel reaches it', () => {
  it('the channel is registered, handled, and routed to this method', () => {
    expect(RPC_CHANNELS.sessions.READ_TASK_OUTPUT).toBe('sessions:readTaskOutput')
    const handlers = readFileSync(new URL('../../handlers/rpc/sessions.ts', import.meta.url), 'utf8')
    expect(handlers).toContain('server.handle(\n    RPC_CHANNELS.sessions.READ_TASK_OUTPUT,')
    expect(handlers).toContain('sessionManager.readBackgroundTaskOutput(sessionId, taskId, cursor, ctxWorkspace(ctx))')
    // In HANDLED_CHANNELS too, or the remote/RPC surface never advertises it.
    expect(HANDLED_CHANNELS).toContain(RPC_CHANNELS.sessions.READ_TASK_OUTPUT)
    // Remote-eligible, like KILL_SHELL: it takes a session and needs the workspace
    // owner to answer.
    expect(REMOTE_ELIGIBLE_CHANNELS.has(RPC_CHANNELS.sessions.READ_TASK_OUTPUT)).toBe(true)
  })
})

describe('readBackgroundTaskOutput — the completed-task fallback', () => {
  it('answers from the completed record when no live handle owns the id', async () => {
    // This is what keeps `getTaskOutput` reachable rather than orphaned: a task
    // that finished between the menu opening and the click still answers.
    const { sm, cleanup } = rig({ completedOutput: 'all 40 tests passed' })
    try {
      expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'task_finished', undefined, WORKSPACE_ID)).toEqual({
        success: true,
        output: 'all 40 tests passed',
        isRunning: false,
      })
    } finally {
      cleanup()
    }
  })

  it('UA12.192 — the read is NON-destructive: a second View Output on the same ended chip still answers', async () => {
    // An ended agent chip lingers 8 s and now offers View Output (upstream parity); a click, a close and a second
    // click — or a second window — must not meet `unknown-task` because the first read deleted the record.
    const { sm, cleanup } = rig({ completedOutput: 'all 40 tests passed' })
    try {
      for (let read = 0; read < 2; read += 1) {
        expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'task_finished', undefined, WORKSPACE_ID)).toEqual({
          success: true,
          output: 'all 40 tests passed',
          isRunning: false,
        })
      }
    } finally {
      cleanup()
    }
  })

  it('REFUSES a LIVE other session\'s completed record, and does not consume it', async () => {
    // `taskOutputIndex` is keyed by task id ALONE, so `getTaskOutput` answers out of
    // whichever session recorded the task — and DELETES the record on a successful
    // read. Without the ownership check on this branch, one session asking about a
    // foreign id both READ another session's output and DESTROYED the only copy.
    //
    // The second assertion is what makes this a control rather than a coincidence:
    // the rightful owner still gets its own output afterwards.
    const { sm, cleanup } = rig({ foreignCompletedOutput: 'the other session\'s output' })
    try {
      expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'task_foreign', undefined, WORKSPACE_ID)).toEqual({
        success: false,
        reason: 'unknown-task',
      })
      expect(await sm.readBackgroundTaskOutput(FOREIGN_SESSION_ID, 'task_foreign', undefined, WORKSPACE_ID)).toEqual({
        success: true,
        output: 'the other session\'s output',
        isRunning: false,
      })
    } finally {
      cleanup()
    }
  })

  it('THE PREMISE: a completed record is the ONLY thing getTaskOutput can answer for', async () => {
    // The measurement this whole route rests on. A live shell — a row the user can
    // actually see — has no completed record, so `getTaskOutput` returns null, and
    // wiring "View Output" to it would have shown "No output available yet" for a
    // command that had printed megabytes. If this ever starts returning a string,
    // the reason `readBackgroundTaskOutput` exists has changed.
    const { sm, cleanup } = rig({
      shells: { shell_1: 'npm run build -- --watch' },
      read: () => ({ handle: 'shell_1', output: 'lots of output\n', nextCursor: 15, isRunning: true }),
    })
    try {
      expect(await sm.getTaskOutput('shell_1')).toBeNull()
      const viaNewRoute = await sm.readBackgroundTaskOutput(SESSION_ID, 'shell_1', undefined, WORKSPACE_ID)
      expect(viaNewRoute.output).toBe('lots of output\n')
    } finally {
      cleanup()
    }
  })
})
