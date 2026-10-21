/**
 * P2.114 — a background WORKFLOW run that admitted nothing must not report a start.
 *
 * The twin of P2.27 at the other seam, and NOT a copy of it. Three things differ:
 *
 *  1. There is no empty-list tell. `agent_ids` and `details.agentIds` are OMITTED
 *     when nothing was admitted, so the field P2.27 keys on does not exist here.
 *     The tell is a POSITIVELY observed outcome — the script's own terminal
 *     payload — against the fact that no `onAdmitted` ever fired.
 *  2. The seam observes the SCRIPT's outcome rather than the sealed promise —
 *     `sealOwnerTask` is a round trip to the host, and waiting for it would add
 *     that trip to every refusal the run already knows. Pinned below by a seal
 *     that really does take a macrotask.
 *
 * P2.131 removed what was difference 3: the race carried a `setTimeout(0)` arm,
 * and a clock beats a host. Every refusal needing a round trip — the USD cap and
 * every `start` refusal — lost to it in production, and so did a genuine
 * admission, so all three came back saying only that nothing had been admitted
 * yet. The arm is gone and the wait is the accepted price; the two cases and the
 * boundary that price buys are pinned here against a host that answers on a gate
 * instead of within microtasks, which is the only rig where the timer ever won.
 *
 * Controls that must not move: a genuine background start (byte-identical text
 * and details), a run that finished `done` without admitting anything, and the
 * `task_backgrounded` / `task_completed` pair on both sides.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CHILD_SESSION_BUDGET_EXHAUSTED_ERROR } from '../../../server-core/src/pi-harness/child-session-service.ts'
import type { PiChildSessionPort } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import { BackgroundTaskRegistry } from './background-task-registry.ts'
import {
  BUDGET_EXHAUSTED_SPAWN_MESSAGE,
  configureSpawner,
  type ChildSessionResult,
  type SpawnChildSessionArgs,
  type SpawnerRuntime,
} from './spawner.ts'
import {
  BACKGROUND_WORKFLOW_COMPLETED_UNATTENDED_MESSAGE,
  BACKGROUND_WORKFLOW_NOT_RUNNING_MESSAGE,
  BACKGROUND_WORKFLOW_NOT_YET_ADMITTED_MESSAGE,
  BACKGROUND_WORKFLOW_REPLAYED_NOT_RUNNING_MESSAGE,
  createWorkflowTool,
} from './workflow-tool.ts'

type WorkflowToolOptions = Parameters<typeof createWorkflowTool>[0]
type ToolResult = Awaited<ReturnType<ReturnType<typeof createWorkflowTool>['execute']>>

/** The one sentence this row exists to keep out of a run that started nothing. */
const SUCCESS_SENTENCE = 'Started background workflow run'

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
 * Yield past one macrotask, then let the microtasks behind it run.
 *
 * The sequencing primitive for P2.131's cases, and it is an ORDERING argument
 * rather than a delay: any `setTimeout(0)` inside the tool is registered while
 * the call is being set up, i.e. strictly before this one, and equal-delay
 * timers fire in registration order — so when this resumes, a timer arm would
 * already have answered. The microtask turns afterwards let the `.then` that
 * records the answer actually run, so a real early return cannot be missed.
 */
const drainMacrotask = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

/** Each run journals into its own directory; none of them may outlive the test. */
async function withSession<T>(run: (sessionPath: string) => Promise<T>): Promise<T> {
  const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-refusal-'))
  try {
    return await run(sessionPath)
  } finally {
    rmSync(sessionPath, { recursive: true, force: true })
  }
}

interface RefusalCase {
  /** The reason, as the gate that produced it names it. */
  name: string
  /** The spawner's own state for this refusal, when the case needs the real one. */
  configure?: () => void
  tool?: Partial<WorkflowToolOptions>
  script: string
  /** A phrase only THIS refusal produces. */
  expected: string
}

/**
 * Every refusal reachable at a backgrounded `workflow` call that publishes no
 * admission, driven through the REAL spawner (or the real in-file gate) rather
 * than a mocked `failure()` — so the reason the model reads is the reason the
 * gate actually produced.
 *
 * `limitScope: 'workflow'` skips the concurrent-SUBAGENT ceiling, which is the
 * one member of P2.27's set that cannot fire here; a call-site `isolation` and a
 * `skillFork` are not reachable either, because this tool passes neither.
 */
const REFUSAL_CASES: RefusalCase[] = [
  {
    name: 'the depth limit',
    configure: () => configure(port(), { maxDepth: 1 }),
    tool: { getDepth: () => 1 },
    script: "return agent({ agent: 'scout', task: 'inspect' });",
    expected: 'Subagent depth limit exceeded (1)',
  },
  {
    name: 'the session USD budget cap',
    configure: () => configure(port({ start: async () => { throw new Error(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR) } })),
    script: "return agent({ agent: 'scout', task: 'inspect' });",
    expected: BUDGET_EXHAUSTED_SPAWN_MESSAGE,
  },
  {
    name: "the host's own start refusal",
    configure: () => configure(port({ start: async () => { throw new Error('live-agent-ceiling-reached') } })),
    script: "return agent({ agent: 'scout', task: 'inspect' });",
    expected: 'live-agent-ceiling-reached',
  },
  {
    name: 'fork-in-fork',
    // Reachable from a workflow script because this tool has NO fork gate of its
    // own: `agent({ agent: 'fork' })` resolves the reserved definition and goes
    // straight to the spawner, which is where the rule lives.
    configure: () => configure(port(), { isForkSession: true, sessionToolNames: ['read', 'workflow'] }),
    script: "return agent({ agent: 'fork', task: 'draft' });",
    expected: 'a fork cannot spawn another fork',
  },
  {
    name: 'a fork on a host that cannot resolve the parent tool pool',
    configure: () => configure(port()),
    script: "return agent({ agent: 'fork', task: 'draft' });",
    expected: 'fork-session-tool-pool-unavailable',
  },
  {
    name: 'an unknown agent name',
    // The subagent seam REJECTS this one; here it is caught inside the script
    // and settles as an ordinary failed run, so it reached the model as a start.
    configure: () => configure(port()),
    script: "return agent({ agent: 'no-such-agent', task: 'inspect' });",
    expected: 'Unknown agent "no-such-agent"',
  },
  {
    name: 'an invalid outputSchema',
    // The gate that fires before any child spawns.
    configure: () => configure(port()),
    script: "return agent({ agent: 'scout', task: 'json', outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' } });",
    expected: 'invalid structured-output schema',
  },
  {
    name: "the run's own agent ceiling",
    configure: () => configure(port()),
    tool: { getMaxAgents: () => 0 },
    script: "return agent({ agent: 'scout', task: 'inspect' });",
    expected: 'workflow maxAgents exceeded: 0',
  },
  {
    name: 'an unresolvable workflow recipe',
    configure: () => configure(port()),
    script: "return workflow('nope');",
    expected: 'Unknown workflow recipe: nope',
  },
]

describe('a background workflow run that admitted nothing does not report a start', () => {
  for (const testCase of REFUSAL_CASES) {
    it(`refuses in the same turn: ${testCase.name}`, async () => {
      await withSession(async sessionPath => {
        testCase.configure?.()
        const tool = createWorkflowTool({
          getCwd: () => process.cwd(),
          getSessionPath: () => sessionPath,
          makeRunId: () => 'wf-refused',
          ...testCase.tool,
        })

        const result = await tool.execute('call-refused', { background: true, script: testCase.script }, undefined, undefined, {} as never)
        const text = modelText(result)

        // The defect, stated as an assertion: nothing was admitted, so the
        // success sentence must not be what the model reads.
        expect(text).not.toContain(SUCCESS_SENTENCE)
        expect(text.startsWith(BACKGROUND_WORKFLOW_NOT_RUNNING_MESSAGE)).toBe(true)
        // ...and the reason is HERE, not only on a later completion event.
        expect(text).toContain(testCase.expected)
        // Nothing is running, so nothing invites a stop.
        expect(result.details?.taskId).toBeUndefined()
        expect(result.details?.backgrounded).toBeUndefined()
        expect(result.details?.agentIds).toBeUndefined()
        expect(result.details?.result?.status).not.toBe('done')
      })
    })
  }

  it('names the reason even when sealing the owner task takes a round trip', async () => {
    // Difference 3, pinned. The seam observes the SCRIPT's payload, not the
    // sealed promise: `sealOwnerTask` is a host round trip, and a macrotask
    // spent in it is longer than the `setTimeout(0)` arm below, so waiting for
    // the sealed promise would hand this refusal to the not-yet-known branch.
    await withSession(async sessionPath => {
      configure(port({ start: async () => { throw new Error('live-agent-ceiling-reached') } }))
      let sealed = 0
      const tool = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'wf-slow-seal',
        childSessionPort: {
          stopTask: async () => {},
          sealOwnerTask: async () => { await Bun.sleep(20); sealed += 1 },
        } as never,
      })

      const result = await tool.execute('call-slow-seal', {
        background: true,
        script: "return agent({ agent: 'scout', task: 'inspect' });",
      }, undefined, undefined, {} as never)
      const text = modelText(result)

      // The seal has NOT finished yet, and the refusal is already legible.
      expect(sealed).toBe(0)
      expect(text).not.toContain(SUCCESS_SENTENCE)
      expect(text).not.toContain(BACKGROUND_WORKFLOW_NOT_YET_ADMITTED_MESSAGE)
      expect(text.startsWith(BACKGROUND_WORKFLOW_NOT_RUNNING_MESSAGE)).toBe(true)
      expect(text).toContain('live-agent-ceiling-reached')
    })
  })

  it('refuses a run that was STOPPED, not only one that errored', async () => {
    // The anti-narrowing pin. This branch fires on any non-`done` settled run,
    // and narrowing it to `status === 'error'` would hand the aborted class back
    // the success shape — the trap recorded at the subagent seam.
    //
    // Driven deterministically: the spawn waits one microtask so the
    // registration exists (it is created only after `run` returns), stops the
    // task through the registry — `stop` aborts the controller synchronously —
    // and then returns the spawner's own aborted failure shape.
    await withSession(async sessionPath => {
      const backgroundTasks = new BackgroundTaskRegistry()
      const tool = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'wf-stopped',
        backgroundTasks,
        childSessionPort: { stopTask: async () => {}, sealOwnerTask: async () => {} } as never,
        spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
          await Promise.resolve()
          void backgroundTasks.stop('task-wf-stopped').catch(() => undefined)
          return { agent: args.agentDef.name, status: 'aborted', text: '', tokensIn: 0, tokensOut: 0, error: 'aborted' }
        },
      })

      const result = await tool.execute('call-stopped', {
        background: true,
        script: "return agent({ agent: 'scout', task: 'inspect' });",
      }, undefined, undefined, {} as never)
      const text = modelText(result)

      expect(text).not.toContain(SUCCESS_SENTENCE)
      expect(text.startsWith(BACKGROUND_WORKFLOW_NOT_RUNNING_MESSAGE)).toBe(true)
      expect(text).toContain('workflow aborted')
      expect(result.details?.result?.status).toBe('aborted')
      // The clauses that make the lead sentence true for THIS class, asserted as
      // LITERALS: the constant cannot police its own wording, so every assertion
      // that interpolates it stays green no matter what it comes to say.
      expect(text).toContain('refused, stopped, or failed before any agent delivered a result')
      expect(text).toContain('What follows is all there is')
      expect(text).not.toContain('every agent was refused before it ran')
    })
  })

  /**
   * P2.131's two cases, each driven through the REAL spawner against a host that
   * answers on a gate rather than within microtasks — which is the only rig in
   * which the dropped timer arm was ever the winner.
   */
  const ROUND_TRIP_CASES: Array<{ name: string; answer: () => never; expected: string }> = [
    {
      name: 'the session USD budget cap',
      answer: () => { throw new Error(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR) },
      expected: BUDGET_EXHAUSTED_SPAWN_MESSAGE,
    },
    {
      name: "the host's own start refusal",
      answer: () => { throw new Error('live-agent-ceiling-reached') },
      expected: 'live-agent-ceiling-reached',
    },
  ]

  for (const testCase of ROUND_TRIP_CASES) {
    it(`names a refusal that needs a host ROUND TRIP, and does not answer before it: ${testCase.name}`, async () => {
      // P2.131. The `REFUSAL_CASES` above all pass against a host that answers
      // within microtasks, which is why the dropped `setTimeout(0)` arm looked
      // harmless in tests and was not: in production `start` is an IPC round
      // trip, the timer won every time, and these two classes — the USD cap and
      // every host `start` refusal — could only be learned from a later
      // `task_completed`. Measured before the arm went, all THREE outcomes
      // (these two and a genuine admission) came back saying only that nothing
      // had been admitted yet.
      //
      // Sequenced on real signals rather than a sleep. `startCalled` says the
      // host has the request; the macrotask drain then registers its timer
      // AFTER any timer the tool could have registered, so equal-delay FIFO
      // ordering means a timer arm would already have fired by the time the
      // drain resumes. `answered` is therefore a decision, not a stopwatch.
      await withSession(async sessionPath => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        let startCalled!: () => void
        const hostAsked = new Promise<void>(resolve => { startCalled = resolve })
        configure(port({ start: async () => { startCalled(); await gate; return testCase.answer() } }))
        const tool = createWorkflowTool({
          getCwd: () => process.cwd(),
          getSessionPath: () => sessionPath,
          makeRunId: () => 'wf-round-trip',
        })

        let answered = false
        const call = tool.execute('call-round-trip', {
          background: true,
          script: "return agent({ agent: 'scout', task: 'inspect' });",
        }, undefined, undefined, {} as never)
        void call.then(() => { answered = true })

        await hostAsked
        await drainMacrotask()
        // The accepted cost of P2.131, stated as the assertion that buys the
        // reason below: no answer while the host has not answered.
        expect(answered).toBe(false)

        release()
        const text = modelText(await call)
        expect(text).not.toContain(SUCCESS_SENTENCE)
        expect(text).not.toContain(BACKGROUND_WORKFLOW_NOT_YET_ADMITTED_MESSAGE)
        expect(text.startsWith(BACKGROUND_WORKFLOW_NOT_RUNNING_MESSAGE)).toBe(true)
        expect(text).toContain(testCase.expected)
      })
    })
  }

  it('returns the start as soon as the host ADMITS, without waiting for the run', async () => {
    // The boundary on the same wait: it ends at the FIRST admission, not at the
    // run's end. Dropping the timer cost the immediate return; it must not have
    // cost the background return itself, and a workflow whose child is still
    // running has to come back as a start with the id the host gave it.
    //
    // The child never finishes until this test lets it, so a return can only
    // have come from the admission arm.
    await withSession(async sessionPath => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      let startCalled!: () => void
      const hostAsked = new Promise<void>(resolve => { startCalled = resolve })
      let finishChild!: () => void
      const childRunning = new Promise<void>(resolve => { finishChild = resolve })
      let resolveCompleted!: () => void
      const completed = new Promise<void>(resolve => { resolveCompleted = resolve })
      configure(port({
        start: async input => { startCalled(); await gate; return { agentId: input.requestedAgentId ?? 'child', status: 'running', output: '' } },
        monitor: async agentId => { await childRunning; return { agentId, status: 'completed', output: 'ok', result: 'late answer' } },
      }))
      const tool = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'wf-admitted',
        emitEvent: event => { if (event.type === 'task_completed') resolveCompleted() },
      })

      let answered = false
      const call = tool.execute('call-admitted', {
        background: true,
        script: "return agent({ agent: 'scout', task: 'inspect' });",
      }, undefined, undefined, {} as never)
      void call.then(() => { answered = true })

      await hostAsked
      await drainMacrotask()
      expect(answered).toBe(false)

      release()
      const result = await call

      // The run is still going — this is a real background start, not a run
      // that happened to finish inside the call.
      expect(modelText(result)).toBe(
        'Started background workflow run\nrun_id: wf-admitted\ntask_id: task-wf-admitted\nagent_ids: agent-wf-admitted-1',
      )
      expect(result.details?.agentIds).toEqual(['agent-wf-admitted-1'])
      expect(result.details?.backgrounded).toBe(true)
      expect(result.details?.result).toBeUndefined()

      // Nothing is left dangling, and the completion pair still closes the run.
      finishChild()
      await completed
    })
  })

  /**
   * Seeds `sessionPath`'s journal with ONE finished agent under the run id a
   * later call can resume. Driven through the tool itself rather than by
   * hand-writing a `.jsonl`, so the prompt hash is the one the resume really
   * looks up.
   */
  async function seedJournal(sessionPath: string, runId: string, text: string): Promise<void> {
    const seed = createWorkflowTool({
      getCwd: () => process.cwd(),
      getSessionPath: () => sessionPath,
      makeRunId: () => runId,
      childSessionPort: { stopTask: async () => {}, sealOwnerTask: async () => {} } as never,
      spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
        args.onAdmitted?.(args.requestedAgentId!)
        return { agent: args.agentDef.name, status: 'done', text, tokensIn: 1, tokensOut: 1 }
      },
    })
    const result = await seed.execute('call-seed', {
      script: FIRST_STAGE,
    }, undefined, undefined, {} as never)
    expect(result.details?.result?.status).toBe('done')
  }

  /** The stage both scripts share, so the resume hits the journal entry. */
  const FIRST_STAGE = "return await agent({ agent: 'scout', task: 'first', label: 'first' });"

  it('does not deny delivered work when a REPLAYED run is then refused', async () => {
    // The contradiction class P2.27 recorded, at a narrower door. A `resumeRunId`
    // replay pushes a finished entry into `results` and returns WITHOUT admitting
    // (`workflow-tool.ts`, the `if (cached)` arm), so a later refusal renders the
    // lead sentence directly above a report listing delivered work. "before any
    // agent delivered a result" is then FALSE, and the model reads two statements
    // that disagree.
    await withSession(async sessionPath => {
      await seedJournal(sessionPath, 'wf-replay-source', 'cached scout answer')

      configure(port(), { maxDepth: 1 })
      const tool = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'wf-replay-refused',
        getDepth: () => 1,
        childSessionPort: { stopTask: async () => {}, sealOwnerTask: async () => {} } as never,
      })

      const result = await tool.execute('call-replay-refused', {
        background: true,
        resumeRunId: 'wf-replay-source',
        script: `${FIRST_STAGE.replace('return await', 'await')}
return await agent({ agent: 'scout', task: 'second', label: 'second' });`,
      }, undefined, undefined, {} as never)
      const text = modelText(result)

      // The replay really happened, and the report really does list it as done.
      expect(text).toContain('1. first - done')
      expect(text).toContain('cached scout answer')
      expect(text).toContain('Subagent depth limit exceeded (1)')
      expect(result.details?.result?.status).toBe('error')
      // Still not a start...
      expect(text).not.toContain(SUCCESS_SENTENCE)
      // ...and the lead sentence agrees with the report under it. The false
      // clause is asserted as a LITERAL, because the constant cannot police its
      // own wording.
      expect(text.startsWith(BACKGROUND_WORKFLOW_REPLAYED_NOT_RUNNING_MESSAGE)).toBe(true)
      expect(text).not.toContain('before any agent delivered a result')
      expect(text).toContain('What follows is all there is')
    })
  })

  it('reports a FINISH, not a start, when a resumed run replayed EVERY agent', async () => {
    // The all-cached control, and the `status !== 'done'` guard driven by a real
    // journal rather than a script with no agents: a run answered entirely from
    // the journal admits nothing and is NOT a refusal — so it keeps the refusal
    // arm's hands off it, and P2.163 moved it off the START sentence, which was
    // false about the only thing that mattered: the run is over. The pin moved
    // with the meaning rather than being deleted.
    await withSession(async sessionPath => {
      await seedJournal(sessionPath, 'wf-replay-all-source', 'cached scout answer')

      const tool = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'wf-replay-all',
        childSessionPort: { stopTask: async () => {}, sealOwnerTask: async () => {} } as never,
        // The positive control on the replay itself: a cache MISS would spawn,
        // and this makes that impossible to mistake for a pass.
        spawn: async (): Promise<ChildSessionResult> => { throw new Error('a replayed stage must not spawn') },
      })

      const result = await tool.execute('call-replay-all', {
        background: true,
        resumeRunId: 'wf-replay-all-source',
        script: FIRST_STAGE,
      }, undefined, undefined, {} as never)

      const text = modelText(result)
      expect(text).not.toContain(SUCCESS_SENTENCE)
      expect(text.startsWith(BACKGROUND_WORKFLOW_COMPLETED_UNATTENDED_MESSAGE)).toBe(true)
      // ...and the report under the lead is the replayed work itself, delivered
      // in the turn the model asked instead of in a completion notification for
      // a run that had already ended.
      expect(text).toContain('cached scout answer')
      // Neither refusal lead may appear: this run failed at nothing.
      expect(text).not.toContain('No background workflow run is in flight')
      // The finished shape, matching the refusal arm's for the same reason: no
      // `task_id` to invite `stopTask` on a task that is not there, and the
      // run's own payload rather than an empty success envelope.
      expect(result.details?.backgrounded).toBeUndefined()
      expect(result.details?.taskId).toBeUndefined()
      expect(result.details?.agentIds).toBeUndefined()
      expect(result.details?.result?.status).toBe('done')
    })
  })

  it('leaves a genuine background start byte-identical', async () => {
    // The control. Nothing about a run that really admitted a child may move:
    // same text, same details.
    await withSession(async sessionPath => {
      const tool = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'wf-ok',
        childSessionPort: { stopTask: async () => {}, sealOwnerTask: async () => {} } as never,
        spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
          args.onAdmitted?.(args.requestedAgentId!)
          return { agent: args.agentDef.name, status: 'done', text: 'child result', tokensIn: 1, tokensOut: 1 }
        },
      })

      const result = await tool.execute('call-ok', {
        background: true,
        script: "return agent({ agent: 'scout', task: 'inspect' });",
      }, undefined, undefined, {} as never)

      expect(modelText(result)).toBe(
        'Started background workflow run\nrun_id: wf-ok\ntask_id: task-wf-ok\nagent_ids: agent-wf-ok-1',
      )
      expect(result.details?.taskId).toBe('task-wf-ok')
      expect(result.details?.agentIds).toEqual(['agent-wf-ok-1'])
      expect(result.details?.backgrounded).toBe(true)
      expect(result.details?.progress?.runId).toBe('wf-ok')
    })
  })

  it('reports a FINISH, not a start, when a run SUCCEEDED without admitting anything', async () => {
    // The guard on the refusal, and the reason it is `status !== 'done'` rather
    // than "no agent ids": a run that finished successfully is not a refusal,
    // whatever it admitted. A script that never calls `agent()` — and a journal
    // replay, which answers entirely from cache — is exactly that run.
    //
    // P2.163 is the other half of the same observation. Not being a refusal did
    // not make it a START: the run was over before this return was written, and
    // since the `setTimeout(0)` arm was dropped this is what EVERY agent-less
    // script reports, not the unlucky one. It now names the outcome it observed.
    await withSession(async sessionPath => {
      const tool = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'wf-silent-ok',
        childSessionPort: { stopTask: async () => {}, sealOwnerTask: async () => {} } as never,
      })

      const result = await tool.execute('call-silent-ok', {
        background: true,
        script: "log('no agents here'); return 'done';",
      }, undefined, undefined, {} as never)

      const text = modelText(result)
      expect(text).not.toContain(SUCCESS_SENTENCE)
      expect(text.startsWith(BACKGROUND_WORKFLOW_COMPLETED_UNATTENDED_MESSAGE)).toBe(true)
      // Neither refusal lead: nothing here was refused, stopped or failed.
      expect(text).not.toContain('No background workflow run is in flight')
      expect(result.details?.backgrounded).toBeUndefined()
      expect(result.details?.taskId).toBeUndefined()
      expect(result.details?.result?.status).toBe('done')
      // The script's own log line rides back in the same turn — the concrete
      // gain from naming the outcome instead of the intent.
      expect(text).toContain('no agents here')
    })
  })

  it('keeps the task_backgrounded / task_completed pair unchanged on both sides', async () => {
    // The second control: this row changes the SYNCHRONOUS return only. The
    // registration seam still announces the task and still reports its outcome,
    // for a refusal exactly as for a start — and the completion still carries
    // the run's own report rather than the sentence added above it.
    await withSession(async sessionPath => {
      const refusedEvents: Array<{ type: string; status?: string; summary?: string }> = []
      let resolveRefused!: () => void
      const refusedDone = new Promise<void>(resolve => { resolveRefused = resolve })
      configure(port({ start: async () => { throw new Error(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR) } }))
      const refusedTool = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'wf-events-refused',
        emitEvent: event => {
          refusedEvents.push(event)
          if (event.type === 'task_completed') resolveRefused()
        },
      })
      await refusedTool.execute('call-events-refused', {
        background: true,
        script: "return agent({ agent: 'scout', task: 'inspect' });",
      }, undefined, undefined, {} as never)
      await refusedDone

      expect(refusedEvents.map(event => event.type)).toEqual(['task_backgrounded', 'task_completed'])
      expect(refusedEvents[1]?.status).toBe('failed')
      expect(refusedEvents[1]?.summary).toContain(BUDGET_EXHAUSTED_SPAWN_MESSAGE)
      expect(refusedEvents[1]?.summary).not.toContain(BACKGROUND_WORKFLOW_NOT_RUNNING_MESSAGE)

      const okEvents: Array<{ type: string; status?: string }> = []
      let resolveOk!: () => void
      const okDone = new Promise<void>(resolve => { resolveOk = resolve })
      const okTool = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'wf-events-ok',
        emitEvent: event => {
          okEvents.push(event)
          if (event.type === 'task_completed') resolveOk()
        },
        spawn: async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
          args.onAdmitted?.(args.requestedAgentId!)
          return { agent: args.agentDef.name, status: 'done', text: 'child result', tokensIn: 1, tokensOut: 1 }
        },
      })
      await okTool.execute('call-events-ok', {
        background: true,
        script: "return agent({ agent: 'scout', task: 'inspect' });",
      }, undefined, undefined, {} as never)
      await okDone

      expect(okEvents.map(event => event.type)).toEqual(['task_backgrounded', 'task_completed'])
      expect(okEvents[1]?.status).toBe('completed')
    })
  })
})
