/**
 * P2.27 — a REFUSED backgrounded spawn must not return the success shape.
 *
 * Every refusal in `spawner.ts` is a `failure()` returned BEFORE `onAdmitted`
 * ever fires: the fork-in-fork rule, a call-site `isolation` on a named
 * subagent, the fork tool-pool requirement, the depth limit, the
 * concurrent-subagent ceiling, the USD budget cap, and every refusal the host
 * throws out of `start`. The background seam in `subagent-tool.ts` raced the
 * admissions against the run and then reported "Started background subagent
 * task" with an EMPTY `agent_ids` list for all of them — so the model read
 * success where nothing had been spawned, and the honest sentence rode a later
 * `task_completed: failed` that a capped session may never usefully see.
 *
 * The refusal now travels in the tool's own return value, in the same turn the
 * model asked. Three things are deliberately NOT changed and are pinned here as
 * controls: a genuine background start (byte-identical text and details), the
 * later `task_completed` emission, and a PARTIAL fan-out — one admitted child
 * out of two is a task that really did start, so it keeps the success shape.
 */
import { describe, expect, it } from 'bun:test'

import { CHILD_SESSION_BUDGET_EXHAUSTED_ERROR } from '../../../server-core/src/pi-harness/child-session-service.ts'
import type { PiChildSessionPort } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import {
  BUDGET_EXHAUSTED_SPAWN_MESSAGE,
  configureSpawner,
  type ChildSessionResult,
  type SpawnChildSessionArgs,
  type SpawnerRuntime,
} from './spawner.ts'
import {
  BACKGROUND_SPAWN_NOT_RUNNING_MESSAGE,
  createSubagentTool,
  type CreateSubagentToolOptions,
} from './subagent-tool.ts'
import { BackgroundTaskRegistry } from './background-task-registry.ts'

type ToolResult = Awaited<ReturnType<ReturnType<typeof createSubagentTool>['execute']>>

/** The one sentence this row exists to keep out of a refusal. */
const SUCCESS_SENTENCE = 'Started background subagent task'

/** What the MODEL reads back — the only surface a refusal is judged on. */
function modelText(result: ToolResult): string {
  const block = result.content[0]
  return block && 'text' in block ? block.text : ''
}

function port(overrides: Partial<PiChildSessionPort> = {}): PiChildSessionPort {
  return {
    start: async input => ({ agentId: input.requestedAgentId ?? 'child', status: 'completed', output: 'ok', result: 'ok' }),
    resume: async agentId => ({ agentId, status: 'completed', output: '' }),
    steer: async () => {}, getResult: async agentId => ({ agentId, status: 'completed', output: '' }),
    stop: async () => {}, stopTask: async () => {}, sealOwnerTask: async () => {},
    searchOutput: async agentId => ({ agentId, cursor: 0, status: 'completed', results: [] }),
    attach: async agentId => ({ agentId, cursor: 0, output: '', status: 'completed' }),
    monitor: async agentId => ({ agentId, status: 'completed', output: 'ok', result: 'ok' }),
    ...overrides,
  }
}

function configure(childSessionPort: PiChildSessionPort, overrides: Partial<SpawnerRuntime> = {}): void {
  configureSpawner({ childSessionPort, modelId: 'default-model', retryBaseDelayMs: () => 0, ...overrides })
}

/**
 * AWAITS `run` before restoring. A synchronous `try { return run() } finally`
 * hands the env back the moment the body first suspends — the same trap
 * `spawner.test.ts`'s `withCeiling` documents.
 */
async function withCeiling<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.NESSY_MAX_CONCURRENT_SUBAGENTS
  if (value === undefined) delete process.env.NESSY_MAX_CONCURRENT_SUBAGENTS
  else process.env.NESSY_MAX_CONCURRENT_SUBAGENTS = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.NESSY_MAX_CONCURRENT_SUBAGENTS
    else process.env.NESSY_MAX_CONCURRENT_SUBAGENTS = previous
  }
}

interface RefusalCase {
  /** The reason, as the spawner names it. */
  name: string
  /** The spawner's own state for this refusal. */
  configure: () => void
  tool?: Partial<CreateSubagentToolOptions>
  params: Record<string, unknown>
  /** A phrase only THIS refusal produces. */
  expected: string
}

/**
 * Every refusal reachable at a backgrounded `subagent` call, driven through the
 * REAL spawner rather than a mocked `failure()` — so the reason the model reads
 * is the reason the gate actually produced.
 */
const REFUSAL_CASES: RefusalCase[] = [
  {
    name: 'the depth limit',
    configure: () => configure(port(), { maxDepth: 1 }),
    // Depth 1 + an explicit `background: true` is the same seam a top-level
    // call reaches by default; the spawner sees depth 2 against maxDepth 1.
    tool: { getDepth: () => 1 },
    params: { agent: 'worker', task: 'inspect', background: true },
    expected: 'Subagent depth limit exceeded (1)',
  },
  {
    name: 'the session USD budget cap',
    configure: () => configure(port({ start: async () => { throw new Error(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR) } })),
    params: { agent: 'worker', task: 'inspect' },
    expected: BUDGET_EXHAUSTED_SPAWN_MESSAGE,
  },
  {
    name: "the host's own start refusal",
    configure: () => configure(port({ start: async () => { throw new Error('live-agent-ceiling-reached') } })),
    params: { agent: 'worker', task: 'inspect' },
    expected: 'live-agent-ceiling-reached',
  },
  {
    name: 'a call-site isolation request on a named subagent',
    configure: () => configure(port()),
    // Fork mode ON deliberately: that is the only state where `isolation` is
    // advertised at all, so this is the call a model can actually emit rather
    // than one the schema would have refused first.
    tool: { isForkModeEnabled: () => true },
    params: { agent: 'worker', task: 'inspect', isolation: 'worktree' },
    expected: 'isolation is only available on a fork',
  },
  {
    name: 'fork-in-fork',
    configure: () => configure(port(), { isForkSession: true, sessionToolNames: ['read', 'subagent'] }),
    tool: { isForkModeEnabled: () => true },
    params: { agent: 'fork', task: 'draft' },
    expected: 'a fork cannot spawn another fork',
  },
  {
    name: 'a fork on a host that cannot resolve the parent tool pool',
    configure: () => configure(port()),
    tool: { isForkModeEnabled: () => true },
    params: { agent: 'fork', task: 'draft' },
    expected: 'fork-session-tool-pool-unavailable',
  },
]

describe('a refused background subagent spawn does not report success', () => {
  for (const testCase of REFUSAL_CASES) {
    it(`refuses in the same turn: ${testCase.name}`, async () => {
      testCase.configure()
      const tool = createSubagentTool({
        getCwd: () => '/tmp/ws',
        makeRunId: () => 'run-refused',
        ...testCase.tool,
      })

      const result = await tool.execute('call-refused', testCase.params, undefined, undefined, {} as never)
      const text = modelText(result)

      // The defect, stated as an assertion: nothing was spawned, so the success
      // sentence must not be what the model reads.
      expect(text).not.toContain(SUCCESS_SENTENCE)
      expect(text.startsWith(BACKGROUND_SPAWN_NOT_RUNNING_MESSAGE)).toBe(true)
      // ...and the reason is HERE, not only on a later completion event.
      expect(text).toContain(testCase.expected)
      expect(result.details?.isError).toBe(true)
      expect(result.details?.error).toContain(testCase.expected)
      // No agent ids to publish, because no agent was admitted.
      expect(result.details?.agentIds ?? []).toEqual([])
    })
  }

  it('refuses at the concurrent-subagent ceiling instead of reporting a start', async () => {
    // A really held slot, not a simulated counter: the first spawn parks in the
    // port, so "1 subagent is already running" is a true state when the tool
    // makes its backgrounded call.
    await withCeiling('1', async () => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const started: string[] = []
      configure(port({
        start: async input => {
          started.push(input.task)
          await gate
          return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok', result: 'ok' }
        },
      }), { concurrency: 1 })

      const holder = createSubagentTool({ getCwd: () => '/tmp/ws', makeRunId: () => 'run-holder' })
      const held = holder.execute('call-holder', { agent: 'worker', task: 'hold' }, undefined, undefined, {} as never)
      // Wait for the EFFECT — the port really holding the slot — not a fixed
      // number of microtasks.
      const deadline = Date.now() + 2000
      while (started.length === 0) {
        if (Date.now() > deadline) throw new Error('the holding spawn never reached the port')
        await Bun.sleep(1)
      }

      const tool = createSubagentTool({ getCwd: () => '/tmp/ws', makeRunId: () => 'run-ceiling' })
      const result = await tool.execute('call-ceiling', { agent: 'worker', task: 'inspect' }, undefined, undefined, {} as never)

      expect(modelText(result)).not.toContain(SUCCESS_SENTENCE)
      expect(modelText(result)).toContain('Concurrent subagent limit reached: 1')
      expect(modelText(result)).toContain('Do not retry')
      expect(result.details?.isError).toBe(true)
      // Refused BEFORE the port: no second child was ever created.
      expect(started).toEqual(['hold'])

      release()
      await held
    })
  })

  it('refuses an invalid outputSchema at a backgrounded call instead of reporting a start', async () => {
    // The gate that fires before any child spawns — until now it was invisible
    // on the background path for exactly the same reason.
    let attempts = 0
    const tool = createSubagentTool({
      getCwd: () => '/tmp/ws',
      makeRunId: () => 'run-schema-bg',
      spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
        attempts += 1
        args.onAdmitted?.(args.requestedAgentId!)
        return { agent: args.agentDef.name, status: 'done', text: '{}', tokensIn: 1, tokensOut: 1 }
      },
    })

    const result = await tool.execute('call-schema-bg', {
      agent: 'worker',
      task: 'return json',
      outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
    }, undefined, undefined, {} as never)

    expect(attempts).toBe(0)
    expect(modelText(result)).not.toContain(SUCCESS_SENTENCE)
    expect(modelText(result)).toContain('invalid structured-output schema')
    expect(result.details?.isError).toBe(true)
  })

  it('does not claim nothing ran when a lost child carried partial work', async () => {
    // The over-claim this wording closes. `spawner.ts` KEEPS whatever the child
    // produced when a spawn is lost after host-side admission — "The child was
    // admitted and may already have produced work; keep it", and the
    // `recoverPartialText` arm beside it — and neither path ever calls
    // `onAdmitted`, so both land in this same branch. A lead sentence saying
    // every subagent "was refused before it ran" would then contradict the work
    // printed directly underneath it, and the model would read two statements
    // that disagree.
    //
    // Driven through the REAL spawner by the recovery arm, which is
    // deterministic. The abort spelling of the same carriage needs a stop to
    // land inside a one-microtask window between `startWithAbort`'s last
    // `signal.aborted` check and the spawner's own; a test tuned to that window
    // would measure its own timing rather than the seam, so the class is
    // covered here and by the registry stop below instead.
    const partial = 'partial work the child had already produced'
    configure(port({
      start: async () => { throw new Error('child-session-start-failed') },
      getResult: async agentId => ({ agentId, status: 'failed', output: partial, result: partial }),
    }))
    const tool = createSubagentTool({ getCwd: () => '/tmp/ws', makeRunId: () => 'run-partial-loss' })

    const result = await tool.execute('call-partial-loss', { agent: 'worker', task: 'inspect' }, undefined, undefined, {} as never)
    const text = modelText(result)

    // Both true at once: nothing is running, AND the work that does exist is
    // printed rather than denied.
    expect(text.startsWith(BACKGROUND_SPAWN_NOT_RUNNING_MESSAGE)).toBe(true)
    expect(text).toContain(partial)
    expect(text).toContain('child-session-start-failed')
    // The removed over-claim, asserted as LITERALS. The constant cannot police
    // its own wording: every assertion that interpolates it stays green no
    // matter what it comes to say.
    expect(text).not.toContain('refused before it ran')
    expect(text).not.toContain('No background subagent task was started')
    expect(text).not.toContain(SUCCESS_SENTENCE)
    expect(result.details?.isError).toBe(true)
  })

  it('does not claim nothing ran when the task was stopped mid-start', async () => {
    // The abort half of the same class, driven for real: the run is stopped
    // through the registry while the child is still being admitted, so the
    // spawner returns its `aborted` failure and no id is ever published.
    const backgroundTasks = new BackgroundTaskRegistry()
    configure(port({
      start: async input => {
        // The registration exists only once `registerBackgroundChildTask` has
        // called `run` and returned, so the stop waits for it instead of racing
        // it; the second wait keeps the abort ahead of this resolution.
        await Bun.sleep(5)
        void backgroundTasks.stop('task-run-stopped').catch(() => {})
        await Bun.sleep(5)
        return { agentId: input.requestedAgentId!, status: 'running', output: '', result: '' }
      },
    }))
    const tool = createSubagentTool({
      getCwd: () => '/tmp/ws',
      makeRunId: () => 'run-stopped',
      backgroundTasks,
      childSessionPort: port() as never,
    })

    const result = await tool.execute('call-stopped', { agent: 'worker', task: 'inspect' }, undefined, undefined, {} as never)
    const text = modelText(result)

    expect(text.startsWith(BACKGROUND_SPAWN_NOT_RUNNING_MESSAGE)).toBe(true)
    expect(text).toContain('1. worker - aborted')
    expect(text).not.toContain('refused before it ran')
    expect(text).not.toContain('No background subagent task was started')
    expect(text).not.toContain(SUCCESS_SENTENCE)
    expect(result.details?.isError).toBe(true)
  })

  it('leaves a genuine background start byte-identical', async () => {
    // The control. Nothing about a spawn that really started may move: same
    // text, same details, and no error flag.
    const tool = createSubagentTool({
      getCwd: () => '/tmp/ws',
      makeRunId: () => 'run-ok',
      spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
        args.onAdmitted?.(args.requestedAgentId!)
        return { agent: args.agentDef.name, status: 'done', text: 'child result', tokensIn: 1, tokensOut: 1 }
      },
    })

    const result = await tool.execute('call-ok', { agent: 'worker', task: 'inspect' }, undefined, undefined, {} as never)

    expect(modelText(result)).toBe(
      'Started background subagent task\ntask_id: task-run-ok\nagent_ids: agent-run-ok-1',
    )
    expect(result.details?.taskId).toBe('task-run-ok')
    expect(result.details?.agentIds).toEqual(['agent-run-ok-1'])
    expect(result.details?.backgrounded).toBe(true)
    expect(result.details?.progress?.runId).toBe('run-ok')
    expect(result.details?.isError).toBeUndefined()
  })

  it('reports the start when a run SUCCEEDED without publishing an admission', async () => {
    // The guard on the refusal, and the reason it is `status !== 'done'` rather
    // than "no agent ids": a run that finished successfully is not a refusal,
    // whatever it published. Only the real spawner guarantees an admission
    // before a `done` result, so this keeps the seam honest about what it
    // actually observed instead of inferring a refusal from an empty list.
    const tool = createSubagentTool({
      getCwd: () => '/tmp/ws',
      makeRunId: () => 'run-silent-ok',
      spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => ({
        agent: args.agentDef.name, status: 'done', text: 'child result', tokensIn: 1, tokensOut: 1,
      }),
    })

    const result = await tool.execute('call-silent-ok', { agent: 'worker', task: 'inspect' }, undefined, undefined, {} as never)

    expect(modelText(result)).toBe('Started background subagent task\ntask_id: task-run-silent-ok\nagent_ids: ')
    expect(result.details?.isError).toBeUndefined()
  })

  it('still reports the started task when only part of a fan-out was refused', async () => {
    // The boundary, pinned deliberately: one admitted child means a task really
    // is running and a result really will arrive, so the success shape stays and
    // the refused sibling is reported by the run's own completion summary.
    const events: Array<{ type: string; status?: string; summary?: string }> = []
    let resolveCompleted!: () => void
    const completed = new Promise<void>(resolve => { resolveCompleted = resolve })
    const tool = createSubagentTool({
      getCwd: () => '/tmp/ws',
      makeRunId: () => 'run-partial',
      emitEvent: event => {
        events.push(event)
        if (event.type === 'task_completed') resolveCompleted()
      },
      spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
        if (args.agentDef.name === 'worker') {
          args.onAdmitted?.(args.requestedAgentId!)
          return { agent: args.agentDef.name, status: 'done', text: 'child result', tokensIn: 1, tokensOut: 1 }
        }
        return {
          agent: args.agentDef.name, status: 'error', text: '', tokensIn: 0, tokensOut: 0,
          error: 'Concurrent subagent limit reached: 1 subagents are already running in this session.',
        }
      },
    })

    const result = await tool.execute('call-partial', {
      tasks: [{ agent: 'worker', task: 'one' }, { agent: 'scout', task: 'two' }],
    }, undefined, undefined, {} as never)

    expect(modelText(result)).toContain(SUCCESS_SENTENCE)
    expect(result.details?.agentIds).toEqual(['agent-run-partial-1'])
    expect(result.details?.isError).toBeUndefined()
    await completed
    const completion = events.find(event => event.type === 'task_completed')
    expect(completion?.status).toBe('failed')
    expect(completion?.summary).toContain('Concurrent subagent limit reached')
  })

  it('returns a partially-refused fan-out WHILE its admitted member is still running', async () => {
    // P2.115. The pin above says a partial fan-out keeps the success shape; it
    // could not say WHEN, and the answer was "after the whole run finished".
    // `Promise.all(admissions)` could only be resolved by admissions, so the
    // refused member's slot stayed pending and the background return waited for
    // the run — announcing a START for a task that was already over.
    //
    // The measurement is a FLAG, not a clock: the admitted member parks on a
    // gate this test alone opens, so "the tool returned first" is a fact about
    // ordering rather than about how fast the box was.
    let openGate!: () => void
    const gate = new Promise<void>(resolve => { openGate = resolve })
    let admittedMemberFinished = false
    const events: Array<{ type: string; status?: string; summary?: string }> = []
    let resolveCompleted!: () => void
    const completed = new Promise<void>(resolve => { resolveCompleted = resolve })

    const tool = createSubagentTool({
      getCwd: () => '/tmp/ws',
      makeRunId: () => 'run-partial-live',
      emitEvent: event => {
        events.push(event)
        if (event.type === 'task_completed') resolveCompleted()
      },
      spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
        if (args.agentDef.name === 'worker') {
          args.onAdmitted?.(args.requestedAgentId!)
          await gate
          admittedMemberFinished = true
          return { agent: args.agentDef.name, status: 'done', text: 'child result', tokensIn: 1, tokensOut: 1 }
        }
        // The refused sibling: a `failure()`-shaped return, no `onAdmitted`.
        return {
          agent: args.agentDef.name, status: 'error', text: '', tokensIn: 0, tokensOut: 0,
          error: 'Concurrent subagent limit reached: 1 subagents are already running in this session.',
        }
      },
    })

    const result = await tool.execute('call-partial-live', {
      tasks: [{ agent: 'worker', task: 'one' }, { agent: 'scout', task: 'two' }],
    }, undefined, undefined, {} as never)

    // The whole row, in one assertion: the call came back and the work did not.
    expect(admittedMemberFinished).toBe(false)
    expect(modelText(result)).toBe(
      'Started background subagent task\ntask_id: task-run-partial-live\nagent_ids: agent-run-partial-live-1',
    )
    expect(result.details?.agentIds).toEqual(['agent-run-partial-live-1'])
    expect(result.details?.backgrounded).toBe(true)
    expect(result.details?.isError).toBeUndefined()

    openGate()
    await completed
    expect(admittedMemberFinished).toBe(true)
  })

  it('still waits for the run when EVERY member of a fan-out was refused', async () => {
    // The boundary the fix must not cross, and the reason the settle race has a
    // second wait after it. With every member settling on its own, the race can
    // now be won without a single admission — and winning it there would hand
    // back the success shape with an empty `agent_ids`, which is precisely the
    // P2.114 lie the refusal arm exists to prevent. Nothing is in flight, so the
    // call waits for the run's own reason and reports THAT.
    const tool = createSubagentTool({
      getCwd: () => '/tmp/ws',
      makeRunId: () => 'run-all-refused',
      spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => ({
        agent: args.agentDef.name, status: 'error', text: '', tokensIn: 0, tokensOut: 0,
        error: 'Concurrent subagent limit reached: 0 subagents are already running in this session.',
      }),
    })

    const result = await tool.execute('call-all-refused', {
      tasks: [{ agent: 'worker', task: 'one' }, { agent: 'scout', task: 'two' }],
    }, undefined, undefined, {} as never)

    const text = modelText(result)
    expect(text.startsWith(BACKGROUND_SPAWN_NOT_RUNNING_MESSAGE)).toBe(true)
    expect(text).not.toContain(SUCCESS_SENTENCE)
    expect(text).toContain('Concurrent subagent limit reached')
    expect(result.details?.isError).toBe(true)
  })

  it('keeps the task_backgrounded / task_completed pair unchanged on both sides', async () => {
    // The second control: this row changes the SYNCHRONOUS return only. The
    // registration seam still announces the task and still reports its outcome,
    // for a refusal exactly as for a start.
    const refusedEvents: Array<{ type: string; status?: string; summary?: string }> = []
    let resolveRefused!: () => void
    const refusedDone = new Promise<void>(resolve => { resolveRefused = resolve })
    configure(port({ start: async () => { throw new Error(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR) } }))
    const refusedTool = createSubagentTool({
      getCwd: () => '/tmp/ws',
      makeRunId: () => 'run-events-refused',
      emitEvent: event => {
        refusedEvents.push(event)
        if (event.type === 'task_completed') resolveRefused()
      },
    })
    await refusedTool.execute('call-events-refused', { agent: 'worker', task: 'inspect' }, undefined, undefined, {} as never)
    await refusedDone
    expect(refusedEvents.map(event => event.type)).toEqual(['task_backgrounded', 'task_completed'])
    expect(refusedEvents[1]?.status).toBe('failed')
    expect(refusedEvents[1]?.summary).toContain(BUDGET_EXHAUSTED_SPAWN_MESSAGE)

    const okEvents: Array<{ type: string; status?: string }> = []
    let resolveOk!: () => void
    const okDone = new Promise<void>(resolve => { resolveOk = resolve })
    const okTool = createSubagentTool({
      getCwd: () => '/tmp/ws',
      makeRunId: () => 'run-events-ok',
      emitEvent: event => {
        okEvents.push(event)
        if (event.type === 'task_completed') resolveOk()
      },
      spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
        args.onAdmitted?.(args.requestedAgentId!)
        return { agent: args.agentDef.name, status: 'done', text: 'child result', tokensIn: 1, tokensOut: 1 }
      },
    })
    await okTool.execute('call-events-ok', { agent: 'worker', task: 'inspect' }, undefined, undefined, {} as never)
    await okDone
    expect(okEvents.map(event => event.type)).toEqual(['task_backgrounded', 'task_completed'])
    expect(okEvents[1]?.status).toBe('completed')
  })

  it('leaves a run that THREW reaching the model as itself', async () => {
    // Measured, and deliberately not changed: a run that REJECTS (an unknown
    // agent name, an unconfigured spawner, a throwing spawn) already rejects the
    // admissions race, so the tool call fails with that reason in the same turn.
    // Only the `failure()`-returning class was success-shaped, and only that
    // class moves.
    const tool = createSubagentTool({ getCwd: () => '/tmp/ws', makeRunId: () => 'run-thrown' })
    await expect(
      tool.execute('call-thrown', { agent: 'no-such-agent', task: 'inspect' }, undefined, undefined, {} as never),
    ).rejects.toThrow('Unknown agent "no-such-agent"')
  })
})
