/**
 * F1.934 (origin SIT-af, 2026-09-25) — a hidden guardian judge must not show in
 * the parent session's "Running agents" strip.
 *
 * Every judge consult leaves a durable child record on the parent (F1.256), and
 * the runtime snapshot's `childState.children` — the one list the strip
 * (`useAgentPanel` → `toAgentPanelRows`) and every other client reads — mapped
 * every record, a judge included, so each judged action added a
 * "scout · Judge the following planned action…" row that stayed until dismissed.
 * F1.855 hid the judge's SESSION from All Sessions; this is the second surface.
 * The snapshot's child summary carries no prompt, so no client can tell a judge
 * from a real `scout` subagent: the host drops it, with the same identity F1.739
 * uses (`isHostConsultRecord`).
 *
 * Decided with the same change: a RUNNING judge still counts as an active child
 * in the settlement (and the reaper/busy guards) — it is live work the turn waits
 * on, bounded by its deadline (90 s, F1.857), as F1.739 kept it in `concurrency`. Only the
 * displayed list drops it.
 *
 * The rig drives the REAL judge port (`SessionManager.createGuardianJudgePort`)
 * over the REAL `ChildSessionService`, so the judge records are the ones
 * production writes; only the child RUNTIME is scripted.
 */
import { describe, expect, it, mock, setDefaultTimeout } from 'bun:test'
import type { PiChildSessionPort, PiChildStartInput } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import type { GuardianJudgeInput } from '@nessy-agent/shared/prompts/guardian'
import { parsePiHarnessRuntimeSnapshotV1 } from '@nessy-agent/shared/protocol'
import { ChildSessionService } from '../../pi-harness/child-session-service.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The SessionManager module graph dominates this file's wall time on this rig.
setDefaultTimeout(120_000)

const parentKey = { workspaceId: 'workspace-a', sessionId: 'parent' }
const VERDICT = JSON.stringify({ verdict: 'no_objection', reason: 'read-only' })

function rig(options: { holdJudge?: Promise<void> } = {}) {
  const service = new ChildSessionService({
    parentSessionKey: parentKey,
    persist: async () => {},
    disabledByPolicy: () => false,
    runtime: {
      start: async record => {
        if (options.holdJudge && record.task?.startsWith('Judge')) await options.holdJudge
        return {
          childSessionKey: record.childSessionKey,
          transcriptId: `t-${record.agentId}`,
          status: 'completed',
          result: record.task?.startsWith('Judge') ? VERDICT : 'surveyed',
        }
      },
      resume: async () => ({ status: 'completed' }),
      steer: async () => {},
      stop: async () => {},
    },
  })
  const childPort = {
    start: async (input: PiChildStartInput) => service.start(input),
    stop: async (agentId: string) => service.stop(agentId),
  } as unknown as PiChildSessionPort
  const manager = createTestSessionManager() as any
  const managed: any = {
    id: parentKey.sessionId, model: 'session-model', ephemeral: true,
    workspace: { id: parentKey.workspaceId, rootPath: process.cwd(), name: 'w', createdAt: 1 },
    agent: null, messages: [], processingGeneration: 0, permissionMode: 'bypassPermissions', isProcessing: false,
    backgroundTaskOutputs: new Map(), piBackgroundTaskKinds: new Map(),
  }
  manager.sessions = new Map([[`${parentKey.workspaceId}:${parentKey.sessionId}`, managed]])
  manager.resolveManagedProvider = () => 'pi'
  manager.piProcessSupervisor = { snapshot: async () => [], countRunning: mock(async () => 0), listRunning: mock(async () => []), stop: mock(async () => {}) }
  manager.piTaskServices = new Map(); manager.piGoalServices = new Map(); manager.piAskUserServices = new Map(); manager.piPlanModeServices = new Map()
  manager.piWorktreeLeaseServices = new Map(); manager.piLspServices = new Map(); manager.piLspRegistrations = new Map(); manager.piLspAuthoritySignatures = new Map()
  manager.piChildSessionServices = new Map([[`${parentKey.workspaceId}:${parentKey.sessionId}`, service]])
  manager.pendingPermissionRequests = new Map()
  const judgePort = manager.createGuardianJudgePort(managed, childPort, undefined)
  const snapshot = async () => {
    const raw = await manager.getPiHarnessRuntimeSnapshot(parentKey)
    // The real boundary: clients parse what the host produced.
    return { raw, parsed: parsePiHarnessRuntimeSnapshotV1(JSON.parse(JSON.stringify(raw))) }
  }
  // The stub session owns no real runtime; the manager's own cleanup would try to drain it.
  const teardown = async () => { manager.sessions = new Map(); await manager.cleanup() }
  return { service, manager, judgePort, snapshot, teardown }
}

function judgeInput(n: number): GuardianJudgeInput {
  return {
    action: { command: `seq ${n} ${n + 1} >/dev/null`, cwd: process.cwd() },
    trustedIntent: 'count quietly',
    facts: { mode: 'bypassPermissions', workspaceRoot: process.cwd() },
  }
}

/** An Agent-tool spawn of the built-in `scout` — the judge's own definition, a real subagent. */
function subagentStart(n: number): PiChildStartInput {
  return {
    agent: 'scout',
    task: `survey part ${n}`,
    background: false,
    restrictions: { prompt: 'You are scout, a read-only explorer.', model: 'session-model', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
    budgets: { depth: 1, maxDepth: 2, fanout: 100, concurrency: 10, tokenLimit: 100_000, costLimitUsd: 100, deadlineAt: Date.now() + 60_000, ancestry: [] },
  }
}

describe('F1.934 — a guardian judge is not an agent row', () => {
  it('a judged action adds no child to the runtime snapshot, and a real scout subagent still shows', async () => {
    const { service, judgePort, snapshot, teardown } = rig()
    try {
      const verdict = await judgePort.judge({ input: judgeInput(0), cwd: process.cwd() })
      expect(verdict.failure).toBeUndefined()
      expect(verdict.verdict).toBe('no_objection')
      const subagent = await service.start(subagentStart(0))
      expect(subagent.status).toBe('completed')
      // The durable judge record is kept (every transcript survives); it is only not listed.
      expect(service.snapshot().children).toHaveLength(2)
      const { raw, parsed } = await snapshot()
      for (const view of [raw, parsed]) {
        expect(view.childState?.children.map((child: { agentId: string }) => child.agentId)).toEqual([subagent.agentId])
        expect(view.childState?.children[0]).toMatchObject({ agent: 'scout', task: 'survey part 0', status: 'completed' })
      }
    } finally {
      await teardown()
    }
  })

  it('BOUNDARY — sixty judges after a real subagent do not push it out of the bounded list', async () => {
    // The list keeps the LAST `PI_RUNTIME_MAX_ITEMS` (50) records; filtering after
    // that cut would leave a strip with no rows at all behind a run of judges.
    const { service, judgePort, snapshot, teardown } = rig()
    try {
      const subagent = await service.start(subagentStart(0))
      for (let n = 0; n < 60; n += 1) {
        expect((await judgePort.judge({ input: judgeInput(n), cwd: process.cwd() })).verdict).toBe('no_objection')
      }
      expect(service.snapshot().children).toHaveLength(61)
      const { parsed } = await snapshot()
      expect(parsed.childState?.children.map(child => child.agentId)).toEqual([subagent.agentId])
    } finally {
      await teardown()
    }
  })

  it('DECIDED — a RUNNING judge is unlisted yet still keeps the session unsettled', async () => {
    let release!: () => void
    const holdJudge = new Promise<void>(resolve => { release = resolve })
    const { service, judgePort, snapshot, teardown } = rig({ holdJudge })
    try {
      const pending = judgePort.judge({ input: judgeInput(0), cwd: process.cwd() })
      const deadline = Date.now() + 5_000
      while (!service.snapshot().children.some(child => child.status === 'starting' || child.status === 'running')) {
        if (Date.now() > deadline) throw new Error('judge never started')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const during = (await snapshot()).parsed
      expect(during.childState?.children).toEqual([])
      expect(during.settlement).toMatchObject({ settled: false, pending: ['child'] })
      release()
      expect((await pending).verdict).toBe('no_objection')
      expect((await snapshot()).parsed.settlement.settled).toBe(true)
    } finally {
      release()
      await teardown()
    }
  })
})
