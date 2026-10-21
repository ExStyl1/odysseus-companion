/**
 * F1.256 (release sitting SIT-i, 2026-09-25) — the guardian judge must be
 * admitted on EVERY consult of a session, not only the first.
 *
 * Measured in the sitting: a Pi `bypassPermissions` session raised seven cards,
 * and only ONE judge child session ever existed. The judge port
 * (`SessionManager.createGuardianJudgePort`) asked the host child-session
 * service for `fanout: 1, concurrency: 1`. Those two numbers are not the judge's
 * own ceiling only: `ChildSessionService.start` checks them against the PARENT's
 * durable child list — `children.length >= fanout`, every child the parent ever
 * had, finished ones included (pinned by the service's own suite), and
 * `active.length >= concurrency`. So after the first judge left its record,
 * every later judge was refused at admission with `child-session-fanout-limit`,
 * the core turned that into `unsure` + `spawn-error`, and every action in the
 * deny-net band became a card for the rest of the session; a running background
 * subagent refused it the same way through `concurrency`.
 *
 * The rig drives the REAL judge port over the REAL `ChildSessionService` — only
 * the child RUNTIME is scripted (it answers the verdict the judge would), so the
 * admission check under test is the production one.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import type { PiChildSessionPort, PiChildStartInput } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import type { GuardianJudgeInput } from '@nessy-agent/shared/prompts/guardian'
import { ChildSessionService } from '../../pi-harness/child-session-service.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The SessionManager module graph dominates this file's wall time on this rig
// (a timing lottery on a cold cache); the bodies themselves are milliseconds.
setDefaultTimeout(120_000)

const parentKey = { workspaceId: 'workspace-a', sessionId: 'parent' }

function rig(options: { siblingRunning?: boolean } = {}) {
  const service = new ChildSessionService({
    parentSessionKey: parentKey,
    persist: async () => {},
    disabledByPolicy: () => false,
    runtime: {
      start: async record => {
        // A background sibling (e.g. a reviewer subagent) stays running; every
        // judge child answers its verdict and completes.
        if (record.agent === 'reviewer') {
          return { childSessionKey: record.childSessionKey, transcriptId: `t-${record.agentId}`, status: 'running' }
        }
        return {
          childSessionKey: record.childSessionKey,
          transcriptId: `t-${record.agentId}`,
          status: 'completed',
          result: JSON.stringify({ verdict: 'no_objection', reason: 'read-only' }),
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
    { id: 'parent', model: 'session-model', workspace: { id: 'workspace-a', rootPath: process.cwd() } },
    childPort,
    undefined,
  )
  const siblingStarted = options.siblingRunning
    ? service.start({
      agent: 'reviewer', task: 'review the diff', background: true,
      restrictions: { prompt: 'p', model: 'session-model', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 100, concurrency: 4, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [] },
    })
    : Promise.resolve(undefined)
  return { service, starts, manager, judgePort, siblingStarted }
}

function input(command: string): GuardianJudgeInput {
  return {
    action: { command, cwd: process.cwd() },
    trustedIntent: '/code-review',
    facts: { mode: 'bypassPermissions', workspaceRoot: process.cwd() },
  }
}

describe('F1.256 — the guardian judge is admitted on every consult', () => {
  it('a SECOND judge in the same session runs (seq N M >/dev/null after a git compound command)', async () => {
    const { service, starts, manager, judgePort } = rig()
    try {
      const first = await judgePort.judge({ input: input('git status 2>&1'), cwd: process.cwd() })
      expect(first.verdict).toBe('no_objection')
      const second = await judgePort.judge({ input: input('seq 3001 6000 >/dev/null'), cwd: process.cwd() })
      expect(second.failure).toBeUndefined()
      expect(second.verdict).toBe('no_objection')
      // Five more, the sitting's run of `seq` cards: every one is judged.
      for (let n = 0; n < 5; n += 1) {
        const next = await judgePort.judge({ input: input(`seq ${n} ${n + 1} >/dev/null`), cwd: process.cwd() })
        expect(next.verdict).toBe('no_objection')
      }
      expect(starts).toHaveLength(7)
      expect(service.snapshot().children).toHaveLength(7)
    } finally {
      await manager.cleanup()
    }
  })

  it('a judge runs while a background subagent of the same session is still running', async () => {
    const { service, manager, judgePort, siblingStarted } = rig({ siblingRunning: true })
    try {
      const sibling = await siblingStarted
      expect(sibling?.status).toBe('running')
      const verdict = await judgePort.judge({ input: input('seq 1 3000 >/dev/null'), cwd: process.cwd() })
      expect(verdict.failure).toBeUndefined()
      expect(verdict.verdict).toBe('no_objection')
      expect(service.snapshot().children.filter(child => child.status === 'running')).toHaveLength(1)
    } finally {
      await manager.cleanup()
    }
  })

  // F1.739 — this control first proved the backstop with a JUDGE record spending a `fanout: 1` spawn;
  // a judge record no longer counts toward fanout, so the backstop is now proven on a REAL child.
  it('CONTROL — the service still refuses a spawn whose own fanout is spent (the backstop is not removed, only the judge\'s 1)', async () => {
    const { service, manager, judgePort } = rig()
    const worker = (task: string) => service.start({
      agent: 'worker', task, background: false,
      restrictions: { prompt: 'p', model: 'session-model', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [] },
    })
    try {
      await judgePort.judge({ input: input('git status 2>&1'), cwd: process.cwd() })
      expect((await worker('the first real child')).status).toBe('completed')
      await expect(worker('one more')).rejects.toThrow('child-session-fanout-limit')
    } finally {
      await manager.cleanup()
    }
  })
})
