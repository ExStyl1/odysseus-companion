/**
 * P2.5 — at the session's `--max-budget-usd` ceiling the SPAWNER refuses new
 * children, and says so in a sentence the model can act on.
 *
 * Where the two halves live. The cap's producer is host-side (the backend chat
 * loop ends the parent's turn with `terminalReason: 'max_budget_usd'`), and the
 * subprocess tracks no cost of its own — so the spawner cannot compute this
 * verdict, it can only be TOLD it, once per spawn, by the `start` call the
 * spawn already makes. It caches nothing: the host re-evaluates the ceiling
 * every turn, and this process has no turn boundary to invalidate a cached copy
 * against, so a cached refusal would outlive a raised cap and keep refusing
 * children the host is willing to admit.
 *
 * Both doors are covered here — the spawn path in `spawner.ts` and the resume
 * path in `subagent-tool.ts`, which the host gates for the same reason
 * (`sub-agents.md:903`) and which used to hand the raw host code to the model.
 */
import { describe, expect, it } from 'bun:test'

import { CHILD_SESSION_BUDGET_EXHAUSTED_ERROR } from '../../../server-core/src/pi-harness/child-session-service.ts'
import type { PiChildSessionPort } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import type { AgentDefinition } from '../../../shared/src/agents/index.ts'
import {
  BUDGET_EXHAUSTED_SPAWN_MESSAGE,
  configureSpawner,
  HOST_BUDGET_EXHAUSTED_ERROR,
  spawnChildSession,
} from './spawner.ts'
import { createSubagentTool } from './subagent-tool.ts'

const scout: AgentDefinition = {
  name: 'scout', description: 'Scout', systemPrompt: 'Scout prompt', toolset: 'read-only',
  tools: ['read', 'grep', 'find', 'ls'], tier: 'small',
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

function spawn() {
  return spawnChildSession({ agentDef: scout, task: 'inspect', cwd: '/tmp/ws', background: false })
}

describe('spawner — the session USD cap', () => {
  it('is the same literal the host refuses with', () => {
    // Re-declared rather than imported: server-core is host code and must never
    // enter the Pi subprocess bundle. This test is the only thing keeping the
    // two copies equal, so it imports both.
    expect(HOST_BUDGET_EXHAUSTED_ERROR).toBe(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR)
  })

  it('turns the host refusal into an honest message, without retrying it', async () => {
    let starts = 0
    configureSpawner({
      childSessionPort: port({
        start: async () => {
          starts += 1
          throw new Error(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR)
        },
      }),
      modelId: 'default-model',
      retryBaseDelayMs: () => 0,
    })

    const refused = await spawn()
    // Not a silent no-op and not a fake success: the model is told the budget
    // is gone, in the failure shape it already reads.
    expect(refused.status).toBe('error')
    expect(refused.error).toBe(BUDGET_EXHAUSTED_SPAWN_MESSAGE)
    expect(refused.text).toBe('')
    // ONE attempt, not three: a spending ceiling is not a transient, so the
    // retry arm below it never sees this error.
    expect(starts).toBe(1)
  })

  it('asks the host again on the next spawn instead of caching the refusal', async () => {
    // The host clears its own latch at turn start (`SessionManager`), mirroring
    // the producer's per-turn config read — so a cap the user raised stops
    // binding on the very next turn. A subprocess-side cache would silently
    // outlive that: this port refuses once and then admits, exactly as the host
    // does across a raise, and the second spawn must SUCCEED.
    let starts = 0
    configureSpawner({
      childSessionPort: port({
        start: async input => {
          starts += 1
          if (starts === 1) throw new Error(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR)
          return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok', result: 'ok' }
        },
      }),
      modelId: 'default-model',
      retryBaseDelayMs: () => 0,
    })

    expect((await spawn()).error).toBe(BUDGET_EXHAUSTED_SPAWN_MESSAGE)
    const afterRaise = await spawn()
    expect(afterRaise.status).toBe('done')
    expect(afterRaise.text).toBe('ok')
    // The second spawn really did reach the host rather than being answered
    // from a stale local verdict.
    expect(starts).toBe(2)
  })

  it('leaves spawns under the cap untouched', async () => {
    let starts = 0
    configureSpawner({
      childSessionPort: port({
        start: async input => { starts += 1; return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok', result: 'ok' } },
      }),
      modelId: 'default-model',
      retryBaseDelayMs: () => 0,
    })

    const first = await spawn()
    const second = await spawn()
    expect([first.status, second.status]).toEqual(['done', 'done'])
    expect([first.text, second.text]).toEqual(['ok', 'ok'])
    expect(starts).toBe(2)
  })
})

describe('subagent tool — a resume refused at the USD cap', () => {
  type ResumeResult = Awaited<ReturnType<ReturnType<typeof createSubagentTool>['execute']>>

  const resumeTool = (resume: PiChildSessionPort['resume']) => createSubagentTool({
    getCwd: () => '/tmp/ws',
    childSessionPort: port({ resume }) as never,
  })

  /** What the MODEL reads back — the only surface this refusal is judged on. */
  const modelText = (result: ResumeResult): string => {
    const block = result.content[0]
    return block && 'text' in block ? block.text : ''
  }

  it('speaks the same sentence the spawn path does', async () => {
    const tool = resumeTool(async () => { throw new Error(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR) })
    const result = await tool.execute('r', { resume: 'agent-1', input: 'continue' }, undefined, undefined, {} as never)

    // The model-visible shape: the sentence, and the error flag that makes it a
    // refusal rather than a report. Before this fix the host's internal code
    // reached the model verbatim.
    expect(modelText(result)).toBe(BUDGET_EXHAUSTED_SPAWN_MESSAGE)
    expect(result.details?.isError).toBe(true)
    expect(result.details?.error).toBe(BUDGET_EXHAUSTED_SPAWN_MESSAGE)
    expect(modelText(result)).not.toContain(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR)
  })

  it('leaves every other resume failure alone', async () => {
    // The catch is narrow on purpose: only the cap is translated, so an
    // unrelated failure keeps reaching the caller as itself.
    const tool = resumeTool(async () => { throw new Error('child-session-unknown-agent') })
    await expect(
      tool.execute('r', { resume: 'agent-1', input: 'continue' }, undefined, undefined, {} as never),
    ).rejects.toThrow('child-session-unknown-agent')
  })

  it('leaves a resume under the cap untouched', async () => {
    const tool = resumeTool(async agentId => ({ agentId, status: 'completed', output: 'resumed', result: 'resumed' }))
    const result = await tool.execute('r', { resume: 'agent-1', input: 'continue' }, undefined, undefined, {} as never)
    expect(modelText(result)).toContain('resumed')
    expect(result.details?.isError).toBeUndefined()
  })
})
