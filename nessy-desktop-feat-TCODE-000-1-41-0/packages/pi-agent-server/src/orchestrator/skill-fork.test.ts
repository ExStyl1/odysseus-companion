/**
 * R69b Task 1 — `context: fork`, the subagent a SKILL starts.
 *
 * The gate is the one `/subtask`'s own test has, inverted. `subtask.test.ts`
 * proves the command reaches a CONVERSATION fork (`restrictions.fork === true`,
 * an empty prompt, the parent's exact tool pool). A forked skill must reach the
 * opposite: `skills.md:569` — "It won't have access to your conversation
 * history" — and `:580`, "the skill's subagent is a regular agent type". So the
 * assertions that matter are the ones a wrong wiring would flip:
 *  - a NAMED subagent, never `fork: true` and never an empty prompt;
 *  - the skill body as the child's task;
 *  - a background run registered as a background task, because that registration
 *    is the whole delivery path a `background: true` skill's result travels.
 */
import { describe, expect, it } from 'bun:test'

import type { PiChildSessionPort, PiChildStartInput } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import { configureSpawner, type SpawnerRuntime } from './spawner.ts'
import { DEFAULT_SKILL_FORK_AGENT, skillForkCompletionSummary, startSkillFork } from './skill-fork.ts'

const SKILL_BODY = 'Research the parser change and report the three riskiest call sites.'

function port(overrides: Partial<PiChildSessionPort> = {}): PiChildSessionPort {
  return {
    start: async input => ({ agentId: input.requestedAgentId ?? 'child', status: 'completed', output: 'child result', result: 'child result' }),
    resume: async agentId => ({ agentId, status: 'completed', output: '' }),
    steer: async () => {}, getResult: async agentId => ({ agentId, status: 'completed', output: '' }),
    stop: async () => {}, stopTask: async () => {}, sealOwnerTask: async () => {},
    searchOutput: async agentId => ({ agentId, cursor: 0, status: 'completed', results: [] }),
    attach: async agentId => ({ agentId, cursor: 0, output: '', status: 'completed' }),
    monitor: async agentId => ({ agentId, status: 'completed', output: 'child result', result: 'child result' }),
    ...overrides,
  }
}

function configure(childSessionPort: PiChildSessionPort, overrides: Partial<SpawnerRuntime> = {}): void {
  configureSpawner({
    childSessionPort,
    modelId: 'parent-session-model',
    retryBaseDelayMs: () => 0,
    sessionToolNames: ['read', 'bash', 'subagent', 'ask_user'],
    ...overrides,
  })
}

describe('context: fork spawns a named subagent, not a conversation fork', () => {
  it('drives a named child with the skill body and no inherited history', async () => {
    const captured: PiChildStartInput[] = []
    configure(port({
      start: async input => {
        captured.push(structuredClone(input))
        return { agentId: input.requestedAgentId!, status: 'running', output: '' }
      },
    }))

    const started = await startSkillFork({
      skillName: 'research',
      agent: 'reviewer',
      prompt: SKILL_BODY,
      background: true,
      cwd: '/tmp/ws',
      makeRunId: () => 'run-1',
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      agent: 'reviewer',
      task: SKILL_BODY,
      background: true,
      backgroundTaskId: 'task-skill-run-1',
      restrictions: { skillFork: { name: 'research' } },
    })
    // THE no-history assertion. `restrictions.fork` is the single flag that
    // makes `startPiChildRuntime` branch the parent's conversation into the
    // child; its absence is what "won't have access to your conversation
    // history" means at this layer. Its companion — a non-empty prompt composed
    // from the AGENT DEFINITION — is the positive half: a conversation fork is
    // required to carry `prompt: ''` so its prefix matches the parent's, so a
    // composed prompt is proof this is not one.
    expect(captured[0]!.restrictions.fork).toBeUndefined()
    expect(captured[0]!.restrictions.prompt).toContain('You are a reviewer agent.')
    expect(started).toMatchObject({ agent: 'reviewer', background: true, taskId: 'task-skill-run-1' })
  })

  it('falls back to the default agent type when the skill names none', async () => {
    const captured: PiChildStartInput[] = []
    configure(port({
      start: async input => {
        captured.push(structuredClone(input))
        return { agentId: input.requestedAgentId!, status: 'running', output: '' }
      },
    }))
    await startSkillFork({ skillName: 'research', prompt: SKILL_BODY, background: true, cwd: '/tmp/ws' })
    expect(captured[0]!.agent).toBe(DEFAULT_SKILL_FORK_AGENT)
  })

  it('sets the CHILD model from the skill, not the invoking session model', async () => {
    // `skills.md:265` — "With `context: fork`, the value sets the forked
    // subagent's model instead."
    const captured: PiChildStartInput[] = []
    configure(port({
      start: async input => {
        captured.push(structuredClone(input))
        return { agentId: input.requestedAgentId!, status: 'running', output: '' }
      },
    }))
    await startSkillFork({
      skillName: 'research', model: 'fast-model', prompt: SKILL_BODY, background: true, cwd: '/tmp/ws',
    })
    expect(captured[0]!.restrictions.model).toBe('fast-model')
  })

  it('refuses agent: fork, because that IS the conversation fork', async () => {
    configure(port())
    await expect(startSkillFork({
      skillName: 'research', agent: 'fork', prompt: SKILL_BODY, background: true, cwd: '/tmp/ws',
    })).rejects.toThrow(/skill-fork-agent-must-be-named/)
  })

  it('refuses a skill with no body instead of forking on nothing', async () => {
    // `skills.md:585` — a skill with no actionable task "returns without
    // meaningful output"; an EMPTY one cannot even start, and the child-session
    // service would reject it with `child-session-agent-task-required` anyway.
    configure(port())
    await expect(startSkillFork({
      skillName: 'research', prompt: '   ', background: true, cwd: '/tmp/ws',
    })).rejects.toThrow(/skill-fork-requires-content/)
  })

  it('registers a background fork, which is how its result reaches the conversation', async () => {
    // `:571` — "its result arrives in your conversation when it completes". The
    // `task_backgrounded`/`task_completed` pair below is that delivery: the host
    // records the kind on the first and, on the second, hands the summary to
    // `deliverMonitorEvent` (R86). A fork that skipped this registration would
    // also be refused outright by the host (`pi-background-child-task-id-required`).
    const events: Array<{ type: string; taskId: string; kind?: string; status?: string; summary?: string }> = []
    configure(port({
      start: async input => ({ agentId: input.requestedAgentId!, status: 'running', output: '' }),
      monitor: async agentId => ({ agentId, status: 'completed', output: 'three call sites', result: 'three call sites' }),
    }))

    let markSettled!: () => void
    const settled = new Promise<void>(resolve => { markSettled = resolve })
    await startSkillFork({
      skillName: 'research',
      prompt: SKILL_BODY,
      background: true,
      cwd: '/tmp/ws',
      requestId: 'skill-fork-3',
      makeRunId: () => 'run-2',
      emitEvent: event => {
        events.push(event)
        if (event.type === 'task_completed') markSettled()
      },
    })
    await settled

    expect(events).toMatchObject([
      { type: 'task_backgrounded', toolUseId: 'skill-fork-3', taskId: 'task-skill-run-2', kind: 'subagent' },
      { type: 'task_completed', taskId: 'task-skill-run-2', status: 'completed' },
    ])
    // The host's own notice names the KIND and the task id, so the SKILL has to
    // be named here or the model is told a "background subagent task" finished
    // with no way to connect it to the skill it invoked.
    expect(events[1]!.summary).toContain('Forked skill "research" completed')
    expect(events[1]!.summary).toContain('three call sites')
  })

  it('returns the settled result for background: false, with nothing registered', async () => {
    // `:571` — "wait for the forked subagent's result in the turn that invoked
    // the skill". A foreground fork is not a background task, so it must not
    // announce itself as one; the R69b transcript entry is gated on the same
    // fact so the result is not reported twice.
    const events: unknown[] = []
    configure(port({
      start: async input => ({ agentId: input.requestedAgentId!, status: 'completed', output: 'answer', result: 'answer' }),
    }))

    const started = await startSkillFork({
      skillName: 'research', prompt: SKILL_BODY, background: false, cwd: '/tmp/ws',
      emitEvent: event => events.push(event),
    })

    expect(started).toMatchObject({ background: false, status: 'done', result: 'answer' })
    expect(events).toEqual([])
  })

  it('keeps a fork in the foreground under the background off switch', async () => {
    // `skills.md:576` — Claude Code also waits "When you set
    // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS to 1". Ours is the same predicate
    // every other detach site reads, and it outranks the frontmatter.
    const previous = process.env.NESSY_DISABLE_BACKGROUND_TASKS
    process.env.NESSY_DISABLE_BACKGROUND_TASKS = '1'
    try {
      const captured: PiChildStartInput[] = []
      configure(port({
        start: async input => {
          captured.push(structuredClone(input))
          return { agentId: input.requestedAgentId!, status: 'completed', output: 'answer', result: 'answer' }
        },
      }))
      const started = await startSkillFork({
        skillName: 'research', prompt: SKILL_BODY, background: true, cwd: '/tmp/ws',
      })
      expect(started.background).toBe(false)
      expect(captured[0]!.background).toBe(false)
      expect(captured[0]!.backgroundTaskId).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.NESSY_DISABLE_BACKGROUND_TASKS
      else process.env.NESSY_DISABLE_BACKGROUND_TASKS = previous
    }
  })

  it('surfaces a spawn failure rather than reporting a started fork', async () => {
    configure(port({ start: async () => { throw new Error('runtime-agent-definition-unavailable') } }))
    await expect(startSkillFork({
      skillName: 'research', prompt: SKILL_BODY, background: true, cwd: '/tmp/ws',
    })).rejects.toThrow(/runtime-agent-definition-unavailable/)
  })
})

describe('skillForkCompletionSummary', () => {
  it('names the skill and the outcome for every terminal status', () => {
    const base = { agent: 'worker', tokensIn: 0, tokensOut: 0 }
    expect(skillForkCompletionSummary('research', { ...base, status: 'done', text: 'found it' }))
      .toBe('Forked skill "research" completed.\nfound it')
    expect(skillForkCompletionSummary('research', { ...base, status: 'error', text: '', error: 'boom' }))
      .toBe('Forked skill "research" failed.\nboom')
    expect(skillForkCompletionSummary('research', { ...base, status: 'aborted', text: '' }))
      .toBe('Forked skill "research" was stopped.\nIt returned no output.')
  })
})
