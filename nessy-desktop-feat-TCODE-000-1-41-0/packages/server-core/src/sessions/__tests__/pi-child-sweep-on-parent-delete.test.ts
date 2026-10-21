/**
 * UA12.159 — a pi child session (the permission-judge sub-session a judged card raised, a subagent,
 * a skill fork, a hook agent) is a REAL hidden session in the workspace store
 * (`startPiChildRuntime` → `createSession({ hidden: true })`), yet deleting its parent left its
 * store dir on disk (measured by UA-bo: deleting the pi-wakeup child left its judge sub-session's
 * store dir alive). The row: sweep judge sub-sessions with their parent.
 *
 * The rig is production on the host half: the record is written by the REAL `ChildSessionService`
 * (the same service `getOrCreatePiChildSessionService` builds, keyed the same way, persisting
 * through `managed.childSessionState`), with judge-shaped restrictions so the record reads as a
 * host consult (`isHostConsultRecord`); only the child RUNTIME half is scripted — and even there
 * the session half is real (`createSession({ hidden: true })`), exactly what the production runtime
 * does before the subprocess work starts.
 *
 * Arms: positive — deleting the parent deletes the judge's store dir; negative/control — a hidden
 * session that is NOT in any child record of the parent survives the parent's delete (the sweep is
 * the parent's child list, never a blanket hidden-session wipe).
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GUARDIAN_POLICY_PROMPT } from '@nessy-agent/shared/prompts/guardian'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { PiChildSessionRecordV1, PiChildSessionStateV1 } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import { ChildSessionService, isHostConsultRecord } from '../../pi-harness/child-session-service.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The SessionManager module graph dominates this file's wall time on this rig.
setDefaultTimeout(120_000)

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function rig(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `ua12-159-${tag}-`))
  roots.push(root)
  const workspaceId = `ws-ua12-159-${tag}-${Math.random().toString(36).slice(2, 8)}`
  const workspaceService = {
    resolve: (id: string) => ({
      id,
      workspaceRootPath: join(root, 'workspaces', id),
      sessionRootPath: join(root, 'sessions', id),
      config: { id, name: id, createdAt: 1, updatedAt: 1 },
      lastAccessedAt: 1,
    }),
    listResolved: () => [],
  } as unknown as WorkspaceService
  const sm = createTestSessionManager({ workspaceService })
  sm.setEventSink((() => undefined) as never)
  const store = (sm as unknown as { sessionStore: { getSessionPath(key: { workspaceId: string; sessionId: string }): string } }).sessionStore
  const dirOf = (sessionId: string) => store.getSessionPath({ workspaceId, sessionId })
  return { sm, workspaceId, dirOf }
}

/** The judge-shaped restrictions `createGuardianJudgePort` sends (the identity `isHostConsultRecord` reads). */
function judgeRestrictions() {
  return {
    prompt: GUARDIAN_POLICY_PROMPT,
    model: 'fast-model',
    tools: ['read', 'grep', 'glob'],
    thinkingLevel: 'off' as const,
    worktreePolicy: 'shared' as const,
    maxTurns: 8,
    permissionMode: 'plan' as const,
    skillKeys: [] as string[],
    mcpServerKeys: [] as string[],
  }
}

function judgeBudgets(now: number) {
  return {
    depth: 1,
    maxDepth: 1,
    fanout: Number.MAX_SAFE_INTEGER,
    concurrency: Number.MAX_SAFE_INTEGER,
    tokenLimit: 100_000,
    costLimitUsd: 100,
    deadlineAt: now + 90_000,
    ancestry: [] as string[],
  }
}

interface Internals {
  getManaged(sessionId: string, workspaceId?: string): { childSessionState?: PiChildSessionStateV1 } | undefined
  piChildSessionServices: Map<string, ChildSessionService>
}

describe('UA12.159 — deleting a session sweeps its pi child sessions', () => {
  it('positive: the judge sub-session a judged card raised is deleted with its parent, store dir and all', async () => {
    const { sm, workspaceId, dirOf } = rig('judge')
    const parent = await sm.createSession(workspaceId, { name: 'wake-loop' })

    // The record half is production: the REAL service, keyed the way the manager keys it,
    // persisting through managed.childSessionState. The runtime half is scripted, but its
    // session half is real — createSession({hidden:true}), what startPiChildRuntime does first.
    const parentManaged = (sm as unknown as Internals).getManaged(parent.id, workspaceId)!
    const service = new ChildSessionService({
      parentSessionKey: { workspaceId, sessionId: parent.id },
      initialState: parentManaged.childSessionState,
      persist: async state => { parentManaged.childSessionState = state },
      disabledByPolicy: () => false,
      runtime: {
        start: async record => {
          const child = await sm.createSession(workspaceId, { name: `${record.agent}: ${record.task.slice(0, 80)}`, hidden: true } as never)
          return {
            childSessionKey: { workspaceId, sessionId: child.id },
            transcriptId: `t-${record.agentId}`,
            status: 'completed' as const,
            output: 'verdict: no_objection',
          }
        },
        resume: async () => ({ status: 'completed' as const }),
        steer: async () => {},
        stop: async () => {},
      },
    })
    ;(sm as unknown as Internals).piChildSessionServices.set(encodeSessionKey({ workspaceId, sessionId: parent.id }), service)

    // Raise ONE judged card mid-turn, the row's setup: a judge consult starts through the real service.
    const now = Date.now()
    await service.start({
      agent: 'scout',
      task: 'judge the planned write',
      background: false,
      restrictions: judgeRestrictions(),
      budgets: judgeBudgets(now),
      requestedAgentId: 'judge-ua12-159',
    })
    const record: PiChildSessionRecordV1 | undefined = service.snapshot().children.find(child => child.agentId === 'judge-ua12-159')
    expect(record).toBeDefined()
    expect(isHostConsultRecord(record!)).toBe(true) // the sweep must read this as a judge, not a subagent
    const judgeSessionId = record!.childSessionKey.sessionId
    expect(existsSync(dirOf(judgeSessionId))).toBe(true)
    expect(existsSync(dirOf(parent.id))).toBe(true)

    await sm.deleteSession(parent.id, workspaceId)

    expect(existsSync(dirOf(parent.id))).toBe(false)
    expect(existsSync(dirOf(judgeSessionId))).toBe(false) // the row's control
    expect(sm.getSessions(workspaceId).some(session => session.id === judgeSessionId)).toBe(false)
  })

  it('control: a hidden session that is in NO child record of the parent survives the delete', async () => {
    const { sm, workspaceId, dirOf } = rig('control')
    const parent = await sm.createSession(workspaceId, { name: 'plain' })
    // Hidden, but nobody's child: mini-edit sessions and the like live here.
    const bystander = await sm.createSession(workspaceId, { name: 'mini edit', hidden: true } as never)
    expect(existsSync(dirOf(bystander.id))).toBe(true)

    await sm.deleteSession(parent.id, workspaceId)

    expect(existsSync(dirOf(parent.id))).toBe(false)
    expect(existsSync(dirOf(bystander.id))).toBe(true)
    expect(sm.getSessions(workspaceId).some(session => session.id === bystander.id)).toBe(true)
  })
})
