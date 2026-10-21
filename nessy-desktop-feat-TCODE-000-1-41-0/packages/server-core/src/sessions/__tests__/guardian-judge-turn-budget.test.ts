/**
 * F1.817 (release sitting SIT-s, packaged `5896a66d2`, 2026-09-25) — the Pi
 * Guardian judge must be able to ANSWER after it investigates.
 *
 * ## The measured defect
 *
 * `work/sitting/SIT-s/verdicts.md` (F1.68, FAILS 3): on the packaged build the
 * judge thread (scout, `explore`) ended `terminal_reason:max_agent_turns` after
 * ONE investigative tool step with no `{"verdict":…}`, so every judged `auto`
 * action became a card ("the safety judge could not answer…").
 *
 * `guardianJudgeDef` gave the judge `maxTurns: base.maxTurns ?? 1` — and the
 * built-in `scout` declares none, so 1. That number was harmless until F1.83
 * (`04b18be95`, 2026-09-23) made a Pi child's `maxTurns` bind its own agentic
 * loop, one MODEL ROUND TRIP per turn (`agent-sdk/agent-loop.md#turns-and-messages`:
 * "A turn is one round trip inside the loop"); before it the host spent the
 * number on STARTS. Since F1.83 a judge that follows its own prompt —
 * `GUARDIAN_POLICY_PROMPT` §"Investigation Guidelines": "When risk depends on
 * local state, use your read-only tools to gather evidence before deciding" —
 * spends its only round trip on the lookup and is aborted at the next one.
 *
 * ## The rig
 *
 * The REAL judge port (`SessionManager.createGuardianJudgePort`) drives the
 * REAL `runGuardianJudgeCore` and the REAL `guardianJudgeDef` over the REAL
 * `ChildSessionService`. The child RUNTIME is a REAL `PiAgent` built with
 * `piChildMaxTurns` = the `maxTurns` the child record carries (the value the
 * host hands the child's backend config — pinned beside the host in
 * `pi-child-max-turns-config.test.ts`), so the real `getMaxAgentTurns` arms the
 * real turn counter inside the real `chatImpl`. Only the MODEL is scripted: each
 * round trip is one `turn_start` followed by either a read-only tool call or
 * the judge's final text. The runtime reports the child the way the host's
 * `runPiChildTurn` does — `completed`, the last assistant text as `result`, and
 * `turnLimitReached` when the cap stopped it (`piChildTranscriptOutcome`).
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { AbortReason, GUARDIAN_DEFAULT_TIMEOUT_MS } from '@nessy-agent/shared/agent'
import { PiAgent } from '@nessy-agent/shared/agent/pi-agent'
import type { PiChildSessionPort, PiChildStartInput } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import { GUARDIAN_POLICY_PROMPT, type GuardianJudgeInput } from '@nessy-agent/shared/prompts/guardian'
import { ChildSessionService } from '../../pi-harness/child-session-service.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The SessionManager + PiAgent module graphs dominate this file's wall time on
// this rig (a timing lottery on a cold cache); the bodies are milliseconds.
setDefaultTimeout(120_000)

const parentKey = { workspaceId: 'workspace-a', sessionId: 'parent' }

/** One scripted model round trip: a read-only lookup, or the judge's final text. */
type RoundTrip = { lookup: string } | { text: string }

interface ChildRun {
  /** The cap the child's own PiAgent enforced (its real `getMaxAgentTurns`). */
  capInForce: number
  /** Lookups the model actually made before the run ended. */
  lookups: number
  turnLimitReached: boolean
}

const verdict = (value: 'no_objection' | 'deny' | 'unsure', reason = 'a read-only check') =>
  JSON.stringify({ verdict: value, reason, ...(value === 'deny' ? { category: 'destructive_action' } : {}) })

/**
 * F1.83's child rig (`pi-child-max-turns.test.ts`), the cap arriving on the backend config.
 * F1.828: `childSystemPrompt` is the host's mapping of the record's `restrictions.prompt`
 * (`SessionManager`, the child backend config beside `piChildMaxTurns`), so the real
 * judge-identity predicate reads what production gives it.
 */
function piChild(piChildMaxTurns: number | undefined, childSystemPrompt?: string): { agent: PiAgent; abortReasons: string[] } {
  const agent = new PiAgent({
    provider: 'pi',
    workspace: {
      id: 'ws-f1817', name: 'F1.817', rootPath: '/tmp/nessy-f1817',
      workspaceRootPath: '/tmp/nessy-f1817', sessionRootPath: '/tmp/nessy-f1817-sessions/ws-f1817',
    },
    session: { id: 'judge-f1817', workspaceRootPath: '/tmp/nessy-f1817', createdAt: Date.now(), lastUsedAt: Date.now() },
    isHeadless: true,
    ...(piChildMaxTurns === undefined ? {} : { piChildMaxTurns }),
    ...(childSystemPrompt === undefined ? {} : { childSystemPrompt }),
  } as unknown as ConstructorParameters<typeof PiAgent>[0])
  const abortReasons: string[] = []
  const manifestSeed = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-f1817',
    sessionKey: { workspaceId: 'ws-f1817', sessionId: 'judge-f1817' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [],
  }
  agent.setCapabilityTurnRuntime({
    view: {
      generation: manifestSeed.snapshotGeneration,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/tmp/nessy-f1817' },
      async readText() { return '' },
      resolveCredential() { throw new Error('not used by this contract') },
    },
    piExecutionManifestSeed: manifestSeed,
  } as unknown as Parameters<PiAgent['setCapabilityTurnRuntime']>[0])
  const runtime = agent as any
  const execution = runtime.buildExecutionManifestForCurrentTurn()
  runtime.activeExecutionManifest = execution.manifest
  runtime.adapter.setExecutionManifest(execution.manifest)
  // The subprocess and the hook dispatch are not this contract's subject.
  runtime.ensureSubprocess = async () => {}
  runtime.send = () => {}
  runtime.emitAutomationEvent = async () => {}
  runtime.eventQueue.reset = () => {}
  runtime.forceAbort = (reason: string) => {
    abortReasons.push(reason)
    runtime._isProcessing = false
  }
  return { agent, abortReasons }
}

/**
 * A judge whose model plays `script` on every attempt. The child runtime is a
 * real PiAgent capped by the record's own `maxTurns`.
 */
function rig(script: (attempt: number) => RoundTrip[]) {
  const runs: ChildRun[] = []
  const service = new ChildSessionService({
    parentSessionKey: parentKey,
    persist: async () => {},
    disabledByPolicy: () => false,
    runtime: {
      start: async record => {
        const { agent, abortReasons } = piChild(record.restrictions.maxTurns, record.restrictions.prompt)
        const runtime = agent as any
        const trips = script(runs.length + 1)
        let lookups = 0
        runtime.eventQueue.drain = async function* () {
          for (const [index, trip] of trips.entries()) {
            runtime.handleSubprocessEvent({ type: 'turn_start' })
            if (!runtime._isProcessing) return
            if ('lookup' in trip) {
              lookups += 1
              yield { type: 'tool_start', toolName: 'read', toolUseId: `lookup-${index}`, input: { path: trip.lookup } }
              yield { type: 'tool_result', toolUseId: `lookup-${index}`, result: 'file contents', isError: false }
            } else {
              yield { type: 'text_complete', text: trip.text }
            }
          }
          yield { type: 'complete' }
        }
        let lastText: string | undefined
        try {
          for await (const event of runtime.chatImpl(record.task)) {
            if (event.type === 'text_complete') lastText = event.text
          }
        } finally {
          runs.push({
            capInForce: runtime.getMaxAgentTurns(),
            lookups,
            turnLimitReached: abortReasons.includes(AbortReason.MaxAgentTurns),
          })
          agent.destroy()
        }
        const output = lastText ?? ''
        return {
          childSessionKey: record.childSessionKey,
          transcriptId: `t-${record.agentId}`,
          status: 'completed',
          output,
          result: output,
          ...(runs.at(-1)!.turnLimitReached ? { turnLimitReached: true as const } : {}),
        }
      },
      resume: async () => ({ status: 'completed' }),
      steer: async () => {},
      stop: async () => {},
    },
  })
  const starts: PiChildStartInput[] = []
  const childPort = {
    start: async (input: PiChildStartInput) => {
      starts.push(input)
      return service.start(input)
    },
    stop: async (agentId: string) => service.stop(agentId),
  } as unknown as PiChildSessionPort
  const manager = createTestSessionManager()
  const judgePort = (manager as any).createGuardianJudgePort(
    { id: 'parent', model: 'gateway-fast', workspace: { id: 'workspace-a', rootPath: process.cwd() } },
    childPort,
    undefined,
  )
  return { runs, starts, manager, judgePort }
}

const input: GuardianJudgeInput = {
  action: { command: 'rm -rf ./build/cache', cwd: process.cwd() },
  trustedIntent: 'clean the build cache',
  facts: { mode: 'auto', workspaceRoot: process.cwd() },
}

describe('F1.817 — the Pi Guardian judge can answer after a read-only lookup', () => {
  it('PRECONDITION: the cap in force inside the judge child is the judge\'s own maxTurns, not an operator cap', async () => {
    // Without this, an operator `maxAgentTurns` / `CLAUDE_CODE_MAX_TURNS` in the
    // test process could decide the arms below instead of the judge definition.
    const { runs, starts, manager, judgePort } = rig(() => [{ text: verdict('no_objection') }])
    try {
      await judgePort.judge({ input, cwd: process.cwd() })
      expect(starts).toHaveLength(1)
      expect(runs[0]!.capInForce).toBe(starts[0]!.restrictions.maxTurns!)
    } finally {
      await manager.cleanup()
    }
  })

  it('the SIT-s shape: ONE read-only lookup, then the verdict — the judge answers', async () => {
    const { runs, manager, judgePort } = rig(() => [{ lookup: './build/cache' }, { text: verdict('no_objection') }])
    try {
      const result = await judgePort.judge({ input, cwd: process.cwd() })
      expect(result.failure).toBeUndefined()
      expect(result.verdict).toBe('no_objection')
      // Answered on the first attempt: the lookup did not spend the judge.
      expect(runs).toHaveLength(1)
      expect(runs[0]!.turnLimitReached).toBe(false)
      expect(runs[0]!.lookups).toBe(1)
    } finally {
      await manager.cleanup()
    }
  })

  it('a deny after a lookup reaches the caller as a deny', async () => {
    const { manager, judgePort } = rig(() => [{ lookup: './build' }, { text: verdict('deny', 'the target holds tracked sources') }])
    try {
      const result = await judgePort.judge({ input, cwd: process.cwd() })
      expect(result.failure).toBeUndefined()
      expect(result.verdict).toBe('deny')
      expect(result.category).toBe('destructive_action')
    } finally {
      await manager.cleanup()
    }
  })

  it('CONTROL: a judge that answers at once still answers (the arm that passed before the fix)', async () => {
    const { runs, manager, judgePort } = rig(() => [{ text: verdict('no_objection') }])
    try {
      const result = await judgePort.judge({ input, cwd: process.cwd() })
      expect(result.failure).toBeUndefined()
      expect(result.verdict).toBe('no_objection')
      expect(runs).toHaveLength(1)
      expect(runs[0]!.lookups).toBe(0)
    } finally {
      await manager.cleanup()
    }
  })
})

describe('F1.817 — controls: the judge still fails safe, stays read-only, and keeps its time budget', () => {
  it('a judge that NEVER stops looking is still capped, and the cap fails safe to unsure (a card), never an allow', async () => {
    const endless = Array.from({ length: 40 }, (_, n): RoundTrip => ({ lookup: `./file-${n}` }))
    const { runs, starts, manager, judgePort } = rig(() => [...endless, { text: verdict('no_objection') }])
    try {
      const result = await judgePort.judge({ input, cwd: process.cwd() })
      expect(result.verdict).toBe('unsure')
      expect(result.failure).toBe('malformed')
      // Both attempts ran into the cap, each after exactly `maxTurns` lookups.
      expect(runs).toHaveLength(2)
      for (const run of runs) {
        expect(run.turnLimitReached).toBe(true)
        expect(run.lookups).toBe(starts[0]!.restrictions.maxTurns!)
      }
    } finally {
      await manager.cleanup()
    }
  })

  it('an unsure verdict stays unsure, and a malformed answer still fails closed', async () => {
    const unsureRig = rig(() => [{ lookup: './build' }, { text: verdict('unsure', 'cannot tell what the cache holds') }])
    const malformedRig = rig(() => [{ lookup: './build' }, { text: 'I think this is probably fine.' }])
    try {
      const unsure = await unsureRig.judgePort.judge({ input, cwd: process.cwd() })
      expect(unsure.verdict).toBe('unsure')
      expect(unsure.failure).toBeUndefined()
      const malformed = await malformedRig.judgePort.judge({ input, cwd: process.cwd() })
      expect(malformed.verdict).toBe('unsure')
      expect(malformed.failure).toBe('malformed')
    } finally {
      await unsureRig.manager.cleanup()
      await malformedRig.manager.cleanup()
    }
  })

  it('the judge child is still read-only and cannot spawn, and its deadline is the core\'s own timeout (F1.857: 90 s)', async () => {
    const { starts, manager, judgePort } = rig(() => [{ lookup: './build' }, { text: verdict('no_objection') }])
    try {
      const before = Date.now()
      await judgePort.judge({ input, cwd: process.cwd() })
      const start = starts[0]!
      expect(start.restrictions.tools).toEqual(['read', 'grep', 'find', 'ls'])
      for (const tool of ['bash', 'write', 'edit', 'subagent', 'workflow', 'task', 'agent']) {
        expect(start.restrictions.tools).not.toContain(tool)
      }
      expect(start.restrictions.permissionMode).toBe('plan')
      // Cannot nest: its depth ceiling is its own level.
      expect(start.budgets.maxDepth).toBe(start.budgets.depth)
      // F1.857: the host's child deadline IS the core's one timer (GUARDIAN_DEFAULT_TIMEOUT_MS, 90 s,
      // pinned in guardian-runner.test.ts) — never shorter, or the host ends a slow judge before the
      // core's own timeout can report it (an `aborted` unsure instead of a `timeout` one); never unbounded.
      const window = start.budgets.deadlineAt - before
      expect(window).toBeGreaterThanOrEqual(GUARDIAN_DEFAULT_TIMEOUT_MS)
      expect(window).toBeLessThanOrEqual(GUARDIAN_DEFAULT_TIMEOUT_MS + 1_000)
    } finally {
      await manager.cleanup()
    }
  })
})

/**
 * F1.828 (owner decision 2026-09-26, option (a)) — the operator's turn cap does
 * not cut the judge. `env-vars.md#variables`: `CLAUDE_CODE_MAX_TURNS` caps "when
 * no explicit limit is passed", and the judge's definition passes one
 * (`GUARDIAN_JUDGE_MAX_TURNS`). Before the fix the Pi child took the LOWER of the
 * two, so an operator value of 1 brought F1.817's cards back.
 */
describe('F1.828 — an operator turn cap below the judge\'s own does not cut the judge', () => {
  const names = ['NESSY_MAX_AGENT_TURNS', 'CLAUDE_CODE_MAX_TURNS'] as const
  /** Bun 1.3.14: delete, then assign (AGENTS.md traps); restored from the values read first. */
  async function withOperatorCap(value: string, body: () => Promise<void>): Promise<void> {
    const saved = names.map(name => process.env[name])
    for (const name of names) delete process.env[name]
    process.env.CLAUDE_CODE_MAX_TURNS = value
    try {
      await body()
    } finally {
      names.forEach((name, index) => {
        delete process.env[name]
        if (saved[index] !== undefined) process.env[name] = saved[index]
      })
    }
  }

  it('CLAUDE_CODE_MAX_TURNS=1: the SIT-s shape (one lookup, then the verdict) still answers on the judge\'s own cap', async () => {
    await withOperatorCap('1', async () => {
      const { runs, starts, manager, judgePort } = rig(() => [{ lookup: './build/cache' }, { text: verdict('no_objection') }])
      try {
        const result = await judgePort.judge({ input, cwd: process.cwd() })
        expect(result.failure).toBeUndefined()
        expect(result.verdict).toBe('no_objection')
        expect(runs).toHaveLength(1)
        expect(runs[0]!.turnLimitReached).toBe(false)
        expect(runs[0]!.capInForce).toBe(starts[0]!.restrictions.maxTurns!)
        expect(runs[0]!.capInForce).toBeGreaterThan(1)
      } finally {
        await manager.cleanup()
      }
    })
  })

  it('CONTROL: under the same operator cap every child that is not the judge is still capped at 1', async () => {
    await withOperatorCap('1', async () => {
      // No prompt (a top-level session), an ordinary named child, a fork, and a
      // prompt that merely QUOTES the policy — each declaring the judge's own 8.
      for (const prompt of [undefined, 'You are scout, a fast read-only explorer.', '', `Summarise this policy:\n\n${GUARDIAN_POLICY_PROMPT}`]) {
        const { agent } = piChild(8, prompt)
        try {
          expect((agent as any).getMaxAgentTurns()).toBe(1)
        } finally {
          agent.destroy()
        }
      }
      // The positive control on the same instrument: the judge's prompt keeps its 8.
      const { agent } = piChild(8, GUARDIAN_POLICY_PROMPT)
      try {
        expect((agent as any).getMaxAgentTurns()).toBe(8)
      } finally {
        agent.destroy()
      }
    })
  })
})
