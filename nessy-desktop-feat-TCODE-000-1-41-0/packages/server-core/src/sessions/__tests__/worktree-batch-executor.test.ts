/**
 * P6.508 — the batch EXECUTOR.
 *
 * `worktree-batch-plan.test.ts` pins the PLANNER (the bound, the branch slugs,
 * the deferral list, the human-submits text). This file pins the half W8-r
 * handed on: `SessionManager.runWorktreeBatch`, which turns the plan into N
 * sessions over the same create path New-Chat-in-Worktree uses.
 *
 * Delegated decision 2026-09-05 (Q-den 31) is option A — MR-less — so the row
 * that matters most here is the one asserting NO forge write of any kind, and
 * the one asserting the bound cannot be raised.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'
import { MAX_BATCH_UNITS } from '../../pi-harness/worktree-batch-plan.ts'

type Enter = { name: string; branch?: string }

function rig(options: {
  failOnUnit?: string
  /** C3.328 — the SEND rejects for the unit carrying this PROMPT, where `failOnUnit` fails the create by session name. */
  failSendOnPrompt?: string
  /**
   * C3.328 — acknowledge the prompt and then never settle the turn. This is the
   * instrument for "the await is on the ARRIVAL, not on the turn": a batch that
   * awaited `sendMessage` itself could not return at all under this rig.
   */
  ackThenHang?: boolean
} = {}) {
  const created: { name?: string }[] = []
  const entered: Enter[] = []
  const sent: { sessionId: string; text: string }[] = []
  const managed = { id: 'parent', workspace: { id: 'ws-a' }, llmConnection: 'gateway', model: 'm-1' }
  let next = 0
  const manager = createTestSessionManager() as unknown as {
    runWorktreeBatch(managed: unknown, input: {
      tasks: readonly { name: string; prompt: string }[]
      branchPrefix: string
      bound?: number
    }): Promise<{
      started: { sessionId: string; name: string; branch: string }[]
      deferred: { name: string; reason: string }[]
      bound: number
      summary: string
    }>
  }
  Object.assign(manager, {
    createSession: async (_workspaceId: string, input: { name?: string }) => {
      created.push(input)
      if (options.failOnUnit && input.name === options.failOnUnit) throw new Error('worktree-project-required')
      return { id: `s${++next}`, workspaceId: 'ws-a' }
    },
    getManaged: (id: string) => ({ id, workspace: { id: 'ws-a' } }),
    createSessionWorktreePort: () => ({
      enter: async (input: Enter) => {
        entered.push(input)
        return { worktreeLeaseId: 'l', path: `/w/${input.name}`, branch: input.branch ?? 'derived', previousWorkingDirectory: '/p', created: true }
      },
    }),
    // The real signature's 8th positional argument is `onAck`, which fires once
    // the user message is persisted and flushed — before any streaming work.
    sendMessage: (
      sessionId: string,
      text: string,
      _a?: unknown, _b?: unknown, _c?: unknown, _d?: unknown, _e?: unknown,
      onAck?: (messageId: string) => void,
    ) => {
      sent.push({ sessionId, text })
      if (options.failSendOnPrompt && text === options.failSendOnPrompt) {
        return Promise.reject(new Error('prompt-not-delivered'))
      }
      if (options.ackThenHang) {
        onAck?.('m1')
        // Never settles: a turn that is still running when the batch replies,
        // which is the ordinary case and the reason the ack exists.
        return new Promise<void>(() => {})
      }
      return Promise.resolve()
    },
  })
  return { manager, managed, created, entered, sent }
}

const tasks = (n: number) =>
  Array.from({ length: n }, (_, index) => ({ name: `task ${index + 1}`, prompt: `do ${index + 1}` }))

describe('P6.508 · runWorktreeBatch', () => {
  test('fans out into one session per task, each on its own branch under the prefix', async () => {
    const { manager, managed, created, entered, sent } = rig()
    const outcome = await manager.runWorktreeBatch(managed, {
      tasks: tasks(3), branchPrefix: 'batch/2026-09-08',
    })
    expect(outcome.started).toHaveLength(3)
    expect(outcome.deferred).toEqual([])
    expect(created).toHaveLength(3)
    // The BRANCH the lease gets is the one the reply promises — that is why the
    // create path takes it at all.
    expect(entered.map(entry => entry.branch)).toEqual([
      'batch/2026-09-08/task-1', 'batch/2026-09-08/task-2', 'batch/2026-09-08/task-3',
    ])
    expect(outcome.started.map(unit => unit.branch)).toEqual(entered.map(entry => entry.branch!))
    // Isolation first, prompt second: the run's first tool call must already
    // see the isolated cwd.
    expect(sent.map(entry => entry.text)).toEqual(['do 1', 'do 2', 'do 3'])
    for (const branch of entered.map(entry => entry.branch!)) {
      expect(outcome.summary).toContain(branch)
    }
  })

  // Q-den 31 = A. The one row this decision turns on.
  test('opens no merge request and says a human must submit the branches', async () => {
    const { manager, managed } = rig()
    const outcome = await manager.runWorktreeBatch(managed, {
      tasks: tasks(2), branchPrefix: 'batch/2026-09-08',
    })
    expect(outcome.summary).toContain('No merge request was opened')
    expect(outcome.summary).toContain('submit these branches yourself')
  })

  // NEGATIVE 1 — the bound is a MEASUREMENT. A caller can lower it and cannot
  // raise it, and what the bound refuses is NAMED rather than dropped.
  test('the bound can be lowered, never raised, and the refusals are named', async () => {
    const lowered = rig()
    const small = await lowered.manager.runWorktreeBatch(lowered.managed, {
      tasks: tasks(5), branchPrefix: 'batch/x', bound: 2,
    })
    expect(small.started).toHaveLength(2)
    expect(small.deferred.map(task => task.name)).toEqual(['task 3', 'task 4', 'task 5'])
    expect(small.bound).toBe(2)
    expect(small.summary).toContain('task 3')

    const raised = rig()
    const big = await raised.manager.runWorktreeBatch(raised.managed, {
      tasks: tasks(MAX_BATCH_UNITS + 3), branchPrefix: 'batch/x', bound: MAX_BATCH_UNITS + 3,
    })
    expect(big.bound).toBe(MAX_BATCH_UNITS)
    expect(big.started).toHaveLength(MAX_BATCH_UNITS)
    expect(big.deferred).toHaveLength(3)
  })

  // C3.107 — FRESH LEASES ONLY, and this is the arm that says so.
  //
  // W17-g's reopen table (`worktree-git-plan.ts` symbol
  // `worktreeReopenResetDecision`) can answer `reset` — one atomic
  // `checkout -B` — when a worktree NAME is reused. None of its five states may
  // ever be reachable from a batch, because the name a batch child would be
  // reusing belongs either to a sibling unit or to an earlier batch, and
  // resetting a sibling's branch mid-run is the one outcome the whole row exists
  // to prevent. The guarantee is a property of the NAME rather than a check: the
  // lease name carries the child session's own id, which is minted per unit, so
  // no two units and no two batches can name the same worktree. (A repeated
  // batch under the same prefix is still refused, separately, by
  // `WorktreeLeaseService.acquire`'s branch/path collision check — the rig here
  // does not model that, which is why this case asserts the names.)
  test('every unit gets a FRESH lease name, so no batch child reaches the reopen screen', async () => {
    const { manager, managed, entered } = rig()
    await manager.runWorktreeBatch(managed, { tasks: tasks(3), branchPrefix: 'batch/x' })
    // The same three task names again: a second batch must not re-enter the
    // first batch's worktrees.
    await manager.runWorktreeBatch(managed, { tasks: tasks(3), branchPrefix: 'batch/x' })
    const names = entered.map(entry => entry.name)
    expect(names).toHaveLength(6)
    expect(new Set(names).size).toBe(6)
    // Not unique by accident of the task list — the session id is IN the name.
    expect(names).toEqual([
      'batch-task-1-s1', 'batch-task-2-s2', 'batch-task-3-s3',
      'batch-task-1-s4', 'batch-task-2-s5', 'batch-task-3-s6',
    ])
    // And the batch never passes `path`, which is the one input to `enter` that
    // adopts an EXISTING worktree instead of creating one.
    expect(entered.map(entry => (entry as { path?: string }).path)).toEqual([
      undefined, undefined, undefined, undefined, undefined, undefined,
    ])
  })

  // NEGATIVE 2 — a unit that fails to start must not throw away the ones that
  // did, and must not be reported as a branch a human can submit.
  test('a unit that fails to start joins the deferred list and leaves the others running', async () => {
    const { manager, managed } = rig({ failOnUnit: 'task 2' })
    const outcome = await manager.runWorktreeBatch(managed, {
      tasks: tasks(3), branchPrefix: 'batch/x',
    })
    expect(outcome.started.map(unit => unit.name)).toEqual(['task 1', 'task 3'])
    expect(outcome.deferred.map(task => task.name)).toEqual(['task 2'])
    expect(outcome.deferred[0]!.reason).toContain('worktree-project-required')
    // The failed unit's branch must NOT be named as one to submit.
    expect(outcome.summary).not.toContain('batch/x/task-2')
    expect(outcome.summary).toContain('batch/x/task-1')
  })

  // C3.327 — and the reply must not blame the BOUND for it. The remedy differs:
  // an over-bound task re-run as a second batch works, where this one would
  // reproduce its own failure.
  test('a unit that failed to start is not blamed on the bound', async () => {
    const { manager, managed } = rig({ failOnUnit: 'task 2' })
    const outcome = await manager.runWorktreeBatch(managed, { tasks: tasks(3), branchPrefix: 'batch/x' })
    // C3.328 widened this sentence from "could not be started at all", which is
    // false for the second shape the same reason word now covers.
    expect(outcome.summary).toContain('not running, and the bound is not the reason')
    expect(outcome.summary).not.toContain('Run them as a second batch')
  })

  // POSITIVE CONTROL for the case above: a genuinely over-bound task still gets
  // the bound's own sentence and its own remedy, so the split is a
  // discriminator rather than a rename.
  test('an over-bound task still names the bound and the second-batch remedy', async () => {
    const { manager, managed } = rig()
    const outcome = await manager.runWorktreeBatch(managed, {
      tasks: tasks(4), branchPrefix: 'batch/x', bound: 2,
    })
    expect(outcome.summary).toContain('a batch runs at most 2 agents at once')
    expect(outcome.summary).toContain('Run them as a second batch')
    expect(outcome.summary).not.toContain('not running, and the bound is not the reason')
  })

  /**
   * C3.328 — a unit whose PROMPT never arrives is not a branch to submit.
   *
   * The send used to be fire-and-forget: `void this.sendMessage(...)` with a
   * `warn` on rejection, while `started.push(...)` ran on the next line
   * regardless. The reply then named a branch whose agent was never told what to
   * do, which is worse than naming nothing — a human opens it and finds an empty
   * worktree.
   */
  test('a unit whose prompt never arrives is deferred, not named as a branch', async () => {
    const { manager, managed } = rig({ failSendOnPrompt: 'do 2' })
    const outcome = await manager.runWorktreeBatch(managed, { tasks: tasks(3), branchPrefix: 'batch/x' })
    expect(outcome.started.map(unit => unit.name)).toEqual(['task 1', 'task 3'])
    expect(outcome.deferred.map(task => task.name)).toEqual(['task 2'])
    // The unit's OWN cause, not the shared sentence — which is the half that
    // tells a reader which of the two shapes this was.
    expect(outcome.deferred[0]!.reason).toContain('prompt-not-delivered')
    expect(outcome.summary).not.toContain('batch/x/task-2')
    expect(outcome.summary).toContain('not running, and the bound is not the reason')
    // NEGATIVE: it did not take the siblings with it, and it is not blamed on
    // the bound either.
    expect(outcome.summary).toContain('batch/x/task-1')
    expect(outcome.summary).toContain('batch/x/task-3')
    expect(outcome.summary).not.toContain('Run them as a second batch')
  })

  /**
   * The CONTROL that makes the case above a fix rather than a regression: the
   * wait is on the ARRIVAL, never on the turn. Every unit here acknowledges its
   * prompt and then never settles — the ordinary case, since a batch replies
   * while its agents are still working — and the batch must still return with
   * all three running. A version that awaited `sendMessage` itself could not
   * return at all under this rig, so the case would time out rather than fail.
   */
  test('the wait is on the ACK, so a still-running turn does not serialise the fan-out', async () => {
    const { manager, managed, sent } = rig({ ackThenHang: true })
    const outcome = await manager.runWorktreeBatch(managed, { tasks: tasks(3), branchPrefix: 'batch/x' })
    expect(outcome.started).toHaveLength(3)
    expect(outcome.deferred).toEqual([])
    expect(sent.map(entry => entry.text)).toEqual(['do 1', 'do 2', 'do 3'])
  })
})

/**
 * D1.144 — the unit that failed AFTER creating a session and a worktree.
 *
 * The rig's `failSendOnPrompt` arm is exactly that shape: `createSession` and
 * `enter` both succeeded and the SEND rejected, so the host is holding a session
 * and a branch the reply used to describe only as "deferred".
 */
describe('D1.144 · a created-but-not-running unit is NAMED', () => {
  test('names the session and the branch on the unit whose prompt never arrived', async () => {
    const { manager, managed, created, entered } = rig({ failSendOnPrompt: 'do 2' })
    const outcome = await manager.runWorktreeBatch(managed, {
      tasks: tasks(3), branchPrefix: 'batch/x',
    })

    // The orphan really exists — both calls were made for that unit.
    expect(created).toHaveLength(3)
    expect(entered).toHaveLength(3)
    const orphan = outcome.deferred.find(entry => entry.name === 'task 2')
    expect(orphan).toBeDefined()
    // The original cause is KEPT; the naming is added to it, not instead of it.
    expect(orphan!.reason).toContain('prompt-not-delivered')
    expect(orphan!.reason).toContain('s2')
    expect(orphan!.reason).toContain('batch/x/task-2')
    // And the two that worked are untouched.
    expect(outcome.started.map(unit => unit.name)).toEqual(['task 1', 'task 3'])
  })

  /**
   * The NEGATIVE, and it is what stops the sentence being noise: a unit that
   * failed BEFORE anything was created has no orphan to name, and its reason is
   * byte-for-byte what it was.
   */
  test('says nothing about a session for a unit that never got one', async () => {
    const { manager, managed, entered } = rig({ failOnUnit: 'task 2' })
    const outcome = await manager.runWorktreeBatch(managed, {
      tasks: tasks(3), branchPrefix: 'batch/x',
    })

    expect(entered).toHaveLength(2)
    const refused = outcome.deferred.find(entry => entry.name === 'task 2')
    expect(refused!.reason).toBe('worktree-project-required')
    expect(refused!.reason).not.toContain('was created')
  })
})
