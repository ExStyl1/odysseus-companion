/**
 * F1.487 (P-WJqqa-4, origin WJ-qq-a) — a Stop's 5 s safety timer must not outlive
 * the manager that armed it.
 *
 * `cancelProcessing` arms a bare `setTimeout(…, 5000)` that force-ends a turn whose
 * generator did not finish after the Stop (`onProcessingStopped(…, 'timeout')`).
 * Nothing kept its handle, so `SessionManager.cleanup()` could not clear it: a rig
 * session stopped and left processing replayed its queue INSIDE a later test file
 * of the same bun process (measured by WJ-qq-a: `steer-identity-requeue`'s codex
 * arm timed out at 5 662 ms beside a batch that stopped without defusing). The fix
 * keeps the handle, clears it in `cleanup()`, and unrefs it so a stray one never
 * holds a process open.
 *
 * CONTROL: without `cleanup()` the timer still fires once, 5 s after the Stop, with
 * `'timeout'` — the safety net itself is unchanged.
 */
import { describe, expect, it } from 'bun:test'
// F1.639 — the per-CASE budget: each case waits 5.4 s past a Stop by construction, and the SessionManager graph is
// a static import loaded before any case timer starts; the hook name here made `check-module-graph-hooks --check` refuse.
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { createTestSessionManager } from './test-session-manager.ts'

type Internals = {
  getManaged(id: string, ws?: string): { isProcessing: boolean; stopRequested?: boolean }
  onProcessingStopped(sessionId: string, reason: string, workspaceId?: string): Promise<void> | void
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function stoppedAndLeftProcessing(ws: string) {
  const manager = createTestSessionManager()
  const session = await manager.createSession(ws, { permissionMode: 'default' } as never)
  const internals = manager as unknown as Internals
  const fired: string[] = []
  internals.onProcessingStopped = (_sessionId, reason) => { fired.push(reason) }
  // A turn whose generator never finishes: processing, and nothing will end it.
  internals.getManaged(session.id, ws).isProcessing = true
  await manager.cancelProcessing(session.id, false, ws)
  return { manager, fired }
}

describe('F1.487 (P-WJqqa-4) · a Stop\'s safety timer goes with the manager', () => {
  it('cleanup() right after the Stop: the 5 s timer never fires', async () => {
    const { manager, fired } = await stoppedAndLeftProcessing('ws-p-wjqqa-4-cleanup')
    // This rig's cleanup REJECTS (a session left processing is a drain residual,
    // `pi-session-foreground-owner-lost`) — the shape WJ-qq-a met, whose rigs did not
    // defuse. The timer must be gone either way: cleanup() clears it before anything
    // that can throw.
    await manager.cleanup().catch(() => {})
    await sleep(5_400)
    // Only the safety timer answers 'timeout'; whatever cleanup's own teardown reports is not the subject.
    expect(fired.filter(reason => reason === 'timeout')).toEqual([])
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  it('CONTROL: without cleanup() it still force-ends the stuck turn, once, with "timeout"', async () => {
    const { manager, fired } = await stoppedAndLeftProcessing('ws-p-wjqqa-4-control')
    try {
      await sleep(5_400)
      expect(fired).toEqual(['timeout'])
    } finally {
      // The stub kept the turn "processing"; let cleanup's drain see it ended.
      const internals = manager as unknown as { sessions: Map<string, { isProcessing: boolean }> }
      for (const managed of internals.sessions.values()) managed.isProcessing = false
      await manager.cleanup()
    }
  }, MODULE_GRAPH_CASE_BUDGET_MS)
})
