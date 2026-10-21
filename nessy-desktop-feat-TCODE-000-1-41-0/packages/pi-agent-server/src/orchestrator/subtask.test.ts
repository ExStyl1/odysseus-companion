/**
 * R29b Task 1 — `/subtask`, the fork the user starts.
 *
 * The gate is that the command reaches the REAL spawn path and produces a
 * conversation fork: `restrictions.fork === true`, the parent's model and the
 * parent's exact tool pool, and never a named subagent. The three assertions
 * that matter are the ones a wrong wiring would flip:
 *  - a fork, not a named subagent (`sub-agents.md:1004`);
 *  - started with fork mode OFF (`:1013`, "with or without the variable set");
 *  - refused inside a fork (`:1052`), with the fork reason rather than a depth
 *    error.
 */
import { describe, expect, it } from 'bun:test'

import type { PiChildSessionPort, PiChildStartInput } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import type { AgentDefinition } from '../../../shared/src/agents/index.ts'
import { FORK_AGENT_DEFINITION } from '../../../shared/src/agents/index.ts'
import { configureSpawner, spawnChildSession, type SpawnerRuntime } from './spawner.ts'
import { normalizeSubagentRequest } from './subagent-tool.ts'
import { startSubtaskFork, subtaskForkName } from './subtask.ts'

function port(overrides: Partial<PiChildSessionPort> = {}): PiChildSessionPort {
  return {
    start: async input => ({ agentId: input.requestedAgentId ?? 'child', status: 'completed', output: 'fork result', result: 'fork result' }),
    resume: async agentId => ({ agentId, status: 'completed', output: '' }),
    steer: async () => {}, getResult: async agentId => ({ agentId, status: 'completed', output: '' }),
    stop: async () => {}, stopTask: async () => {}, sealOwnerTask: async () => {},
    searchOutput: async agentId => ({ agentId, cursor: 0, status: 'completed', results: [] }),
    attach: async agentId => ({ agentId, cursor: 0, output: '', status: 'completed' }),
    monitor: async agentId => ({ agentId, status: 'completed', output: 'fork result', result: 'fork result' }),
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

describe('/subtask starts a conversation fork', () => {
  it('spawns a fork child with the parent model and the parent tool pool, not a named subagent', async () => {
    const captured: PiChildStartInput[] = []
    configure(port({
      start: async input => {
        captured.push(structuredClone(input))
        return { agentId: input.requestedAgentId!, status: 'running', output: '' }
      },
    }))

    const started = await startSubtaskFork({ task: 'draft unit tests for the parser changes so far', cwd: '/tmp/ws' })

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      agent: 'fork',
      task: 'draft unit tests for the parser changes so far',
      background: true,
      restrictions: {
        fork: true,
        prompt: '',
        model: 'parent-session-model',
        tools: ['read', 'bash', 'subagent', 'ask_user'],
        worktreePolicy: 'shared',
      },
    })
    // A named subagent would carry its definition's composed prompt; a fork
    // must not, or its prefix diverges from the parent's.
    expect(captured[0]!.restrictions.prompt).toBe('')
    expect(captured[0]!.restrictions.permissionMode).toBeUndefined()
    expect(started.agentId).toBe(captured[0]!.requestedAgentId!)
    expect(started.name).toBe('draft unit tests for the parser')
  })

  it('starts with fork mode off, because :1013 is not gated on the variable', async () => {
    // `isForkModeEnabled` only exists on the `subagent` TOOL; the spawner has no
    // such gate, which is exactly why `/subtask` does not go through the tool.
    const captured: PiChildStartInput[] = []
    configure(port({
      start: async input => {
        captured.push(structuredClone(input))
        return { agentId: input.requestedAgentId!, status: 'running', output: '' }
      },
    }))
    await startSubtaskFork({ task: 'try the other approach', cwd: '/tmp/ws' })
    expect(captured[0]!.restrictions.fork).toBe(true)
  })

  it('registers as a background task, because the host refuses a background child without one', async () => {
    // `pi-background-child-task-id-required`: the delegating child-session port
    // rejects a background start with no task id, so a fork that skipped this
    // registration was refused before any child session existed — and the agents
    // panel, which reads the resulting child list, never saw a fork.
    const captured: PiChildStartInput[] = []
    const events: Array<{ type: string; taskId: string; kind?: string; status?: string }> = []
    configure(port({
      start: async input => {
        captured.push(structuredClone(input))
        return { agentId: input.requestedAgentId!, status: 'running', output: '' }
      },
    }))

    let markSettled!: () => void
    const settled = new Promise<void>(resolve => { markSettled = resolve })
    await startSubtaskFork({
      task: 'draft the tests',
      cwd: '/tmp/ws',
      requestId: 'subtask-7',
      emitEvent: event => events.push(event),
      makeRunId: () => 'run-1',
      onSettled: () => markSettled(),
    })
    // The command returns at ADMISSION (`:1019`); the terminal report lands when
    // the fork itself finishes.
    await settled

    expect(captured[0]).toMatchObject({ background: true, backgroundTaskId: 'task-fork-run-1' })
    // Announced before the run and reported after it: the host retains the
    // fork's capability authority on the first and releases it on the second.
    expect(events).toMatchObject([
      { type: 'task_backgrounded', toolUseId: 'subtask-7', taskId: 'task-fork-run-1', kind: 'subagent' },
      { type: 'task_completed', taskId: 'task-fork-run-1', status: 'completed' },
    ])
  })

  it('keeps a fork in the foreground under the background off switch, with nothing to register', async () => {
    // `:783` — `NESSY_DISABLE_BACKGROUND_TASKS` takes precedence and keeps
    // subagents in the foreground. A foreground fork settles inside the
    // command's own turn, so it is not a background task and must not announce
    // itself as one.
    const previous = process.env.NESSY_DISABLE_BACKGROUND_TASKS
    process.env.NESSY_DISABLE_BACKGROUND_TASKS = '1'
    try {
      const captured: PiChildStartInput[] = []
      const events: unknown[] = []
      configure(port({
        start: async input => {
          captured.push(structuredClone(input))
          return { agentId: input.requestedAgentId!, status: 'completed', output: 'done', result: 'done' }
        },
      }))
      await startSubtaskFork({ task: 'foreground fork', cwd: '/tmp/ws', emitEvent: event => events.push(event) })
      expect(captured[0]!.background).toBe(false)
      expect(captured[0]!.backgroundTaskId).toBeUndefined()
      expect(events).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.NESSY_DISABLE_BACKGROUND_TASKS
      else process.env.NESSY_DISABLE_BACKGROUND_TASKS = previous
    }
  })

  it('refuses inside a fork with the no-nested-fork reason, not a depth error', async () => {
    configure(port(), { isForkSession: true, maxDepth: 3 })
    await expect(startSubtaskFork({ task: 'fork again', cwd: '/tmp/ws' }))
      .rejects.toThrow(/a fork cannot spawn another fork/)
  })

  it('refuses an empty task instead of forking on nothing', async () => {
    configure(port())
    await expect(startSubtaskFork({ task: '   ', cwd: '/tmp/ws' }))
      .rejects.toThrow(/subtask-requires-a-task/)
  })

  it('surfaces the inheritance failure rather than reporting a started fork', async () => {
    configure(port({ start: async () => { throw new Error('fork-not-started: this fork could not inherit the parent conversation') } }))
    await expect(startSubtaskFork({ task: 'inherit me', cwd: '/tmp/ws' }))
      .rejects.toThrow(/fork-not-started/)
  })
})

describe('subtaskForkName', () => {
  it('names the fork from the first words of the task', () => {
    expect(subtaskForkName('draft unit tests for the parser changes so far'))
      .toBe('draft unit tests for the parser')
    expect(subtaskForkName('  one  two  ')).toBe('one two')
  })
})

describe('isolation: "worktree" (sub-agents.md:1048)', () => {
  it('a fork spawned with isolation gets an isolated worktree, and without it the parent tree', async () => {
    const captured: PiChildStartInput[] = []
    const start = async (input: PiChildStartInput) => {
      captured.push(structuredClone(input))
      return { agentId: input.requestedAgentId!, status: 'running' as const, output: '' }
    }

    configure(port({ start }))
    await spawnChildSession({ agentDef: FORK_AGENT_DEFINITION, task: 'isolated', cwd: '/tmp/ws', isolation: 'worktree' })
    configure(port({ start }))
    await spawnChildSession({ agentDef: FORK_AGENT_DEFINITION, task: 'shared', cwd: '/tmp/ws' })

    expect(captured[0]!.restrictions).toMatchObject({ fork: true, worktreePolicy: 'isolated-worktree' })
    expect(captured[1]!.restrictions).toMatchObject({ fork: true, worktreePolicy: 'shared' })
  })

  it('refuses the call-site argument for a named subagent instead of dropping it', async () => {
    configure(port())
    const named: AgentDefinition = {
      name: 'scout', description: 'Scout', systemPrompt: 'Scout prompt',
      toolset: 'read-only', tools: ['read'], tier: 'small',
    }
    const result = await spawnChildSession({ agentDef: named, task: 'survey', cwd: '/tmp/ws', isolation: 'worktree' })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/isolation is only available on a fork/)
  })

  it('accepts the argument on the tool request and rejects any other value', () => {
    expect(normalizeSubagentRequest({ agent: 'fork', task: 'go', isolation: 'worktree' }).tasks[0])
      .toMatchObject({ agent: 'fork', isolation: 'worktree' })
    expect(normalizeSubagentRequest({ agent: 'fork', task: 'go' }).tasks[0]!.isolation).toBeUndefined()
    expect(() => normalizeSubagentRequest({ agent: 'fork', task: 'go', isolation: 'sandbox' }))
      .toThrow(/isolation must be "worktree"/)
  })
})
