/**
 * F1.739 (origin WJ-crit-v, 2026-09-25) — a guardian judge consult must not use
 * up the session's SUBAGENT limit.
 *
 * F1.256 (`784690ce4`) let every judge in a session be admitted, so every
 * consult now leaves a durable child record on the parent. The host's per-parent
 * backstop in `ChildSessionService.start` counts EVERY child the parent ever had
 * against the spawn's `fanout` — which for an Agent-tool spawn is
 * `orchestrator.maxAgents` (`spawner.ts`, `cfg.maxFanout ?? 100`) — so after about
 * one hundred judged actions a Pi session could no longer start a subagent: the
 * spawn was refused `child-session-fanout-limit` while the judges themselves,
 * whose own fanout is unbounded, stayed admitted.
 *
 * The rig drives the REAL judge port (`SessionManager.createGuardianJudgePort`)
 * over the REAL `ChildSessionService`, so the judge records under test are the
 * ones production writes; only the child RUNTIME is scripted. The subagent starts
 * carry the spawner's own budget shape.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import type { PiChildSessionPort, PiChildStartInput } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import type { GuardianJudgeInput } from '@nessy-agent/shared/prompts/guardian'
import { childSessionConcurrencyBackstop } from '@nessy-agent/shared/config/subagent-limits'
import { ChildSessionService } from '../../pi-harness/child-session-service.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The SessionManager module graph dominates this file's wall time on this rig;
// the bodies themselves are milliseconds per consult.
setDefaultTimeout(120_000)

const parentKey = { workspaceId: 'workspace-a', sessionId: 'parent' }
// `orchestrator.maxAgents` unset — the spawner's own default fanout.
const SPAWNER_DEFAULT_FANOUT = 100

function rig() {
  const service = new ChildSessionService({
    parentSessionKey: parentKey,
    persist: async () => {},
    disabledByPolicy: () => false,
    runtime: {
      start: async record => ({
        childSessionKey: record.childSessionKey,
        transcriptId: `t-${record.agentId}`,
        status: 'completed',
        result: JSON.stringify({ verdict: 'no_objection', reason: 'read-only' }),
      }),
      resume: async () => ({ status: 'completed' }),
      steer: async () => {},
      stop: async () => {},
    },
  })
  const childPort = {
    start: async (input: PiChildStartInput) => service.start(input),
    stop: async (agentId: string) => service.stop(agentId),
  } as unknown as PiChildSessionPort
  const manager = createTestSessionManager()
  const judgePort = (manager as any).createGuardianJudgePort(
    { id: 'parent', model: 'session-model', workspace: { id: 'workspace-a', rootPath: process.cwd() } },
    childPort,
    undefined,
  )
  return { service, manager, judgePort }
}

function judgeInput(n: number): GuardianJudgeInput {
  return {
    action: { command: `seq ${n} ${n + 1} >/dev/null`, cwd: process.cwd() },
    trustedIntent: 'count quietly',
    facts: { mode: 'bypassPermissions', workspaceRoot: process.cwd() },
  }
}

/** An Agent-tool spawn of the built-in `scout`, with the spawner's budget shape. */
function subagentStart(n: number): PiChildStartInput {
  return {
    agent: 'scout',
    task: `survey part ${n}`,
    background: false,
    restrictions: { prompt: 'You are scout, a read-only explorer.', model: 'session-model', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
    budgets: {
      depth: 1,
      maxDepth: 2,
      fanout: SPAWNER_DEFAULT_FANOUT,
      concurrency: childSessionConcurrencyBackstop({ subagentCeiling: 10, workflowCeiling: 4 }),
      tokenLimit: 100_000,
      costLimitUsd: 100,
      deadlineAt: Date.now() + 60_000,
      ancestry: [],
    },
  }
}

describe('F1.739 — judge consults do not use up the session\'s subagent limit', () => {
  it('after 100 judge consults, a subagent spawn is still admitted', async () => {
    const { service, manager, judgePort } = rig()
    try {
      for (let n = 0; n < 100; n += 1) {
        const verdict = await judgePort.judge({ input: judgeInput(n), cwd: process.cwd() })
        expect(verdict.failure).toBeUndefined()
        expect(verdict.verdict).toBe('no_objection')
      }
      expect(service.snapshot().children).toHaveLength(100)
      const started = await service.start(subagentStart(0))
      expect(started.status).toBe('completed')
      expect(service.snapshot().children).toHaveLength(101)
    } finally {
      await manager.cleanup()
    }
  })

  it('CONTROL — the 101st REAL subagent is still refused, judges interleaved or not, and a judge after it is still admitted', async () => {
    const { service, manager, judgePort } = rig()
    try {
      for (let n = 0; n < SPAWNER_DEFAULT_FANOUT; n += 1) {
        const verdict = await judgePort.judge({ input: judgeInput(n), cwd: process.cwd() })
        expect(verdict.verdict).toBe('no_objection')
        const started = await service.start(subagentStart(n))
        expect(started.status).toBe('completed')
      }
      // A real `scout` subagent is counted even though the judge is built from
      // the same built-in definition: the exemption is the judge's role, not its name.
      await expect(service.start(subagentStart(SPAWNER_DEFAULT_FANOUT))).rejects.toThrow('child-session-fanout-limit')
      const after = await judgePort.judge({ input: judgeInput(1_000), cwd: process.cwd() })
      expect(after.failure).toBeUndefined()
      expect(after.verdict).toBe('no_objection')
      expect(service.snapshot().children).toHaveLength(2 * SPAWNER_DEFAULT_FANOUT + 1)
    } finally {
      await manager.cleanup()
    }
  })
})
