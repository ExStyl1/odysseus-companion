import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '../../workspaces/paths.ts'
import type { StoredSession } from '../types.ts'
import {
  clearPendingPlanExecution,
  getPendingPlanExecution,
  getSessionFilePath,
  loadSession,
  markCompactionComplete,
  markPendingPlanExecutionDispatched,
  saveSession,
  sessionPersistenceQueue,
  setPendingPlanExecution,
} from '../storage.ts'

function makeWorkspaceId(): string {
  return `pending-plan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function makeStoredSession(workspaceId: string): StoredSession {
  return {
    id: 'session-1',
    workspaceId,
    createdAt: 1000,
    lastUsedAt: 1000,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  } as StoredSession
}

describe('pending plan execution persistence', () => {
  let workspaceId: string

  beforeEach(async () => {
    workspaceId = makeWorkspaceId()
    await saveSession(makeStoredSession(workspaceId))
  })

  afterEach(() => {
    const dir = join(SESSIONS_DIR, workspaceId)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('defaults executionDispatched to false and persists transitions', async () => {
    await setPendingPlanExecution(workspaceId, 'session-1', '/tmp/plan.md', 'draft snapshot')

    expect(getPendingPlanExecution(workspaceId, 'session-1')).toEqual({
      planPath: '/tmp/plan.md',
      draftInputSnapshot: 'draft snapshot',
      awaitingCompaction: true,
      executionDispatched: false,
    })

    await markCompactionComplete(workspaceId, 'session-1')
    expect(await markPendingPlanExecutionDispatched(workspaceId, 'session-1')).toBe(true)

    expect(getPendingPlanExecution(workspaceId, 'session-1')).toEqual({
      planPath: '/tmp/plan.md',
      draftInputSnapshot: 'draft snapshot',
      awaitingCompaction: false,
      executionDispatched: true,
    })
  })

  // F1.241 — the claim is a BOOLEAN the renderer's dispatcher must win before it sends.
  // It was `Promise<void>`: check-then-set with no answer, so it could never refuse.
  it('refuses the claim while the compaction is still awaited, and when nothing is pending', async () => {
    expect(await markPendingPlanExecutionDispatched(workspaceId, 'session-1')).toBe(false)
    await setPendingPlanExecution(workspaceId, 'session-1', '/tmp/plan.md')
    expect(await markPendingPlanExecutionDispatched(workspaceId, 'session-1')).toBe(false)
    expect(getPendingPlanExecution(workspaceId, 'session-1')?.executionDispatched).toBe(false)
  })

  it('grants exactly one of two concurrent claims, and none after that', async () => {
    await setPendingPlanExecution(workspaceId, 'session-1', '/tmp/plan.md')
    await markCompactionComplete(workspaceId, 'session-1')
    const answers = await Promise.all([
      markPendingPlanExecutionDispatched(workspaceId, 'session-1'),
      markPendingPlanExecutionDispatched(workspaceId, 'session-1'),
    ])
    expect(answers.filter(answer => answer === true)).toHaveLength(1)
    expect(answers.filter(answer => answer === false)).toHaveLength(1)
    expect(await markPendingPlanExecutionDispatched(workspaceId, 'session-1')).toBe(false)
    expect(getPendingPlanExecution(workspaceId, 'session-1')?.executionDispatched).toBe(true)
  })

  // UA12.35 — ported from craft-agents-oss v0.14.0 (Apache-2.0)
  // packages/shared/src/sessions/__tests__/pending-plan-execution.test.ts, with our
  // (workspaceId, sessionId) signature. clearPendingPlanExecution runs before every non-/compact
  // send (F1.241); it loaded the disk copy and saved it back whole even with nothing pending.
  it('clears a pending plan, and leaves the file alone when nothing is pending', async () => {
    const path = getSessionFilePath(workspaceId, 'session-1')
    const untouched = statSync(path).mtimeMs
    await new Promise(resolve => setTimeout(resolve, 15))
    await Promise.all([
      clearPendingPlanExecution(workspaceId, 'session-1'),
      clearPendingPlanExecution(workspaceId, 'session-1'),
    ])
    expect(statSync(path).mtimeMs).toBe(untouched)

    await setPendingPlanExecution(workspaceId, 'session-1', '/tmp/plan.md')
    expect(loadSession(workspaceId, 'session-1')?.pendingPlanExecution?.planPath).toBe('/tmp/plan.md')
    await clearPendingPlanExecution(workspaceId, 'session-1')
    expect(getPendingPlanExecution(workspaceId, 'session-1')).toBeNull()
    expect(loadSession(workspaceId, 'session-1')?.pendingPlanExecution).toBeUndefined()
  })

  // UA12.35 — the data-loss window: saveSession's enqueue REPLACES a pending debounced snapshot,
  // so a clear with nothing pending used to swap the newest unflushed write for the stale disk copy.
  it('keeps a pending debounced snapshot when a clear finds nothing pending', async () => {
    const newer = { ...makeStoredSession(workspaceId), name: 'newest unflushed write', lastUsedAt: 2000 }
    sessionPersistenceQueue.enqueue(newer as StoredSession)
    await clearPendingPlanExecution(workspaceId, 'session-1')
    await sessionPersistenceQueue.flush({ workspaceId, sessionId: 'session-1' })
    expect(loadSession(workspaceId, 'session-1')?.name).toBe('newest unflushed write')
  })
})
