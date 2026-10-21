/**
 * F1.241 — the host half of Accept & Compact: a boolean claim, and readiness only from a
 * MANUAL compaction.
 *
 * Three defects, each measured here on the production seams (`sendMessage`,
 * `processEvent`, `markPendingPlanExecutionDispatched`) before the fix:
 *
 * 1. `sendMessage` cleared the pending plan on EVERY user message — including the very
 *    `/compact` Accept & Compact sends right after `setPendingPlanExecution`. So by the time
 *    the compaction finished there was nothing to mark ready, the reload-recovery path was
 *    dead, and the plan only ever left through the renderer's claim-less live callback.
 *    Upstream (craft-agents-oss v0.13.4, `SessionManager.sendMessage`) exempts `/compact`.
 * 2. The `info` case marked the plan ready on ANY message starting with "Compacted" — Pi's
 *    threshold compaction and claude's automatic `compact_boundary` included — so an
 *    automatic compaction could release a plan before, or instead of, the requested one.
 * 3. The claim returned `void` and could not refuse: not while the session was busy, not a
 *    second time.
 *
 * 4. The record lived ONLY in the session file's header, and `persistSession` rewrites that
 *    header from managed state, which never carried it — so the first persist after
 *    `setPendingPlanExecution` (the `/compact` turn's own user message) erased it.
 *
 * The harness is `session-command-host-path.test.ts`'s, with the session NON-ephemeral —
 * the pending-plan record only exists for a persisted session — and with the REAL
 * `persistSession`/`flushSession` (that harness stubs them, which is the one thing that
 * would hide defect 4).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import {
  getPendingPlanExecution,
  markCompactionComplete,
  saveSession,
  setPendingPlanExecution,
} from '@nessy-agent/shared/sessions/storage'
import type { StoredSession } from '@nessy-agent/shared/sessions'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { SessionManager, createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
const workspaceIds: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const id of workspaceIds.splice(0)) rmSync(join(SESSIONS_DIR, id), { recursive: true, force: true })
})

const SESSION_ID = 'pending-plan-claim'

async function createHarness() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-pending-plan-claim-'))
  roots.push(stateRoot)
  const workspaceId = `ws-pending-plan-${Math.random().toString(36).slice(2, 10)}`
  workspaceIds.push(workspaceId)
  const workspace = {
    id: workspaceId,
    name: 'Pending Plan Workspace',
    slug: 'pending-plan',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager: SessionManager = createTestSessionManager()
  const managed = createManagedSession({ id: SESSION_ID }, workspace as never, { messagesLoaded: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)
  manager.setEventSink((() => {}) as Parameters<SessionManager['setEventSink']>[0])

  const internals = manager as unknown as {
    persistSession(managed: unknown): void
    acquireCapabilityTurn(managed: unknown): Promise<() => void>
    createCapabilityTurn(managed: unknown): Promise<unknown>
    createRetainedCapabilityLease(leaseId: string): unknown
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
    processEvent(managed: unknown, event: AgentEvent): Promise<void>
  }
  // persistSession / flushSession stay REAL: every sendMessage writes the session header from
  // managed state, and that write is exactly what wiped the pending-plan record before F1.241.
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async (target: unknown) => {
    const runtime = { view: { sources: [] }, materializer: {} }
    const bound = target as { capabilityLeaseId?: string; capabilityRuntime?: unknown }
    bound.capabilityLeaseId = 'pending-plan-lease'
    bound.capabilityRuntime = runtime
    return { snapshot: { leaseId: 'pending-plan-lease' }, runtime }
  }
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  // The persisted session the pending-plan record lives in, with a plan awaiting compaction.
  await saveSession({
    id: SESSION_ID,
    workspaceId,
    createdAt: 1000,
    lastUsedAt: 1000,
    messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  } as StoredSession)
  await setPendingPlanExecution(workspaceId, SESSION_ID, '/tmp/plan.md', 'draft')

  const pending = () => getPendingPlanExecution(workspaceId, SESSION_ID)
  return { manager, managed, workspaceId, internals, pending }
}

async function sendTurn(h: Awaited<ReturnType<typeof createHarness>>, message: string, backendEvents: AgentEvent[]) {
  const agent = {
    isProcessing: () => true,
    setAllSources: () => {},
    setSourceServers: async () => {},
    getModel: () => 'test-model',
    getSessionId: () => undefined,
    setAutomationSystem: () => {},
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {},
    forceAbort: () => {},
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* () {
      for (const event of backendEvents) yield event
    },
  }
  h.internals.getOrCreateAgent = async () => {
    h.managed.agent = agent as never
    return agent
  }
  try {
    await h.manager.sendMessage(h.managed.id, message, undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: h.workspaceId })
  } finally {
    h.manager.cleanup()
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 200))

describe('Accept & Compact — the host half (F1.241)', () => {
  it('the /compact that Accept & Compact sends keeps the pending plan, and its manual compaction makes it ready', async () => {
    const h = await createHarness()
    await sendTurn(h, '/compact', [
      { type: 'info', message: 'Compacted context to fit within limits (from ~12,345 tokens)', compactionTrigger: 'manual' },
      { type: 'complete' },
    ])
    await settle()
    expect(h.pending()).toMatchObject({ awaitingCompaction: false, executionDispatched: false })
  })

  // The row's note (upstream-refresh readers): a FAILED compaction must not make the plan ready.
  // A failed Pi `requestCompact` REJECTS (`handleCompactResult`), so no "Compacted…" info is ever
  // emitted and the `info` case never runs. F1.881 — and the plan no longer waits out the
  // composer's 330 s: the failure clears it at once, as upstream's `compaction_failed` does.
  it('a /compact that FAILS never makes the plan ready — F1.881: the failure clears it', async () => {
    const h = await createHarness()
    await sendTurn(h, '/compact', [
      { type: 'error', message: 'Compaction failed' },
      { type: 'complete' },
    ])
    await settle()
    expect(h.pending()).toBeNull()
  })

  it('a session write from managed state does not erase the pending plan', async () => {
    const h = await createHarness()
    h.internals.persistSession(h.managed)
    await h.manager.flushSession(SESSION_ID, h.workspaceId)
    expect(h.pending()).toMatchObject({ awaitingCompaction: true, executionDispatched: false })
  })

  it('an ordinary message still clears the pending plan (the safety valve stands)', async () => {
    const h = await createHarness()
    await sendTurn(h, 'hello', [{ type: 'complete' }])
    await settle()
    expect(h.pending()).toBeNull()
  })

  it('an AUTOMATIC compaction leaves the plan awaiting', async () => {
    const h = await createHarness()
    await h.internals.processEvent(h.managed, { type: 'info', message: 'Compacted context to fit within limits', compactionTrigger: 'auto' })
    await h.internals.processEvent(h.managed, { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'auto' })
    // The queue serializes writes per session, so this waits out any readiness write the two
    // events queued — a bare timer is not enough on a slow disk (the first red run passed this
    // arm on a 200 ms settle while the old code's un-awaited write was still in flight).
    await h.manager.flushSession(SESSION_ID, h.workspaceId)
    await settle()
    expect(h.pending()).toMatchObject({ awaitingCompaction: true })
  })

  it('a MANUAL compaction marks the plan ready before the event that announces it is sent', async () => {
    const h = await createHarness()
    await h.internals.processEvent(h.managed, { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' })
    // No settle: the renderer's dispatcher reads the persisted state the moment the event lands.
    expect(h.pending()).toMatchObject({ awaitingCompaction: false })
  })

  it('the claim is refused while the session is busy, granted once idle, and refused a second time', async () => {
    const h = await createHarness()
    await markCompactionComplete(h.workspaceId, SESSION_ID)
    h.managed.isProcessing = true
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(false)
    expect(h.pending()).toMatchObject({ executionDispatched: false })
    h.managed.isProcessing = false
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(true)
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(false)
    expect(h.pending()).toMatchObject({ executionDispatched: true })
  })

  it('the claim is refused for a plan still awaiting its compaction', async () => {
    const h = await createHarness()
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(false)
  })
})

/**
 * F1.856 — Accept & Compact on a SHORT Pi session dead-ended (SIT-x, SIT-y on the 1.41.0 RC).
 * Pi refuses a compaction with nothing to summarise — `Nothing to compact (session too small)` —
 * and that refusal reached the host as an `error`, exactly like a compaction that failed, so the
 * plan stayed awaiting and was never sent. `PiAgent.runSessionCommand` now answers that refusal
 * with a MANUAL-stamped info that is not "Compacted…"; the host reads it as "the compaction the
 * user asked for is settled with nothing to do", which counts as done. The FAILS arm above stays
 * the control: a real failure is still an `error` — and since F1.881 it clears the plan at once instead of leaving it awaiting.
 */
describe('Accept & Compact — a compaction refused as nothing to compact counts as done (F1.856)', () => {
  it('the refusal makes the plan ready, and the claim is then granted once the session is idle', async () => {
    const h = await createHarness()
    await sendTurn(h, '/compact', [
      { type: 'info', message: 'Nothing to compact (session too small)', compactionTrigger: 'manual' },
      { type: 'complete' },
    ])
    await settle()
    expect(h.pending()).toMatchObject({ awaitingCompaction: false, executionDispatched: false })
    h.managed.isProcessing = false
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(true)
  })

  it('the refusal is kept as a plain info row — never the "Conversation Compacted" rule', async () => {
    const h = await createHarness()
    await h.internals.processEvent(h.managed, { type: 'info', message: 'Nothing to compact (session too small)', compactionTrigger: 'manual' })
    const rows = (h.managed as unknown as { messages: Array<{ role: string; content: string; statusType?: string }> }).messages
      .filter(message => message.content === 'Nothing to compact (session too small)')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'info' })
    expect(rows[0]!.statusType).toBeUndefined()
  })

  it('CONTROL: an unstamped info that is not "Compacted…" leaves the plan awaiting', async () => {
    const h = await createHarness()
    await h.internals.processEvent(h.managed, { type: 'info', message: 'Nothing to compact (session too small)' })
    await h.manager.flushSession(SESSION_ID, h.workspaceId)
    expect(h.pending()).toMatchObject({ awaitingCompaction: true })
  })
})

/**
 * UA4.9 (the 1.42.0 upstream-adoption plan) — the claim arms F1.241 left unpinned at the HOST seam.
 * Upstream's second claim case (craft-agents-oss v0.13.4, `server-core/src/sessions/midstream-queue.test.ts`,
 * "does not release pending plan execution for auto or failed compaction outcomes", Apache-2.0)
 * asks the CLAIM after the compaction, with the session idle; the arms above ask only the record.
 * And `markPendingPlanExecutionDispatched`'s missing and ephemeral refusals had no arm at all.
 * Each refusal sits beside a CONTROL on the same harness that is granted, so the arm can fail.
 */
describe('Accept & Compact — the claim after an auto or failed compaction, and for a missing or ephemeral session (UA4.9)', () => {
  it('an AUTOMATIC compaction never releases the claim, even once the session is idle', async () => {
    const h = await createHarness()
    await h.internals.processEvent(h.managed, { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'auto' })
    await h.manager.flushSession(SESSION_ID, h.workspaceId)
    h.managed.isProcessing = false
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(false)
    expect(h.pending()).toMatchObject({ awaitingCompaction: true, executionDispatched: false })
  })

  it('a FAILED /compact never releases the claim, even once the session is idle', async () => {
    const h = await createHarness()
    await sendTurn(h, '/compact', [
      { type: 'error', message: 'Compaction failed' },
      { type: 'complete' },
    ])
    await settle()
    h.managed.isProcessing = false
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(false)
    expect(h.pending()).toBeNull() // F1.881 — cleared by the failure, so nothing is left to claim
  })

  it('CONTROL: the same path with a MANUAL compaction grants the claim, once', async () => {
    const h = await createHarness()
    await h.internals.processEvent(h.managed, { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' })
    h.managed.isProcessing = false
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(true)
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(false)
  })

  it('an EPHEMERAL session is refused a ready plan, which stays unclaimed; CONTROL: the same session persisted is granted', async () => {
    const h = await createHarness()
    await markCompactionComplete(h.workspaceId, SESSION_ID)
    h.managed.isProcessing = false
    const managed = h.managed as unknown as { ephemeral?: boolean }
    managed.ephemeral = true
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(false)
    expect(h.pending()).toMatchObject({ awaitingCompaction: false, executionDispatched: false })
    managed.ephemeral = false
    expect(await h.manager.markPendingPlanExecutionDispatched(SESSION_ID, h.workspaceId)).toBe(true)
  })

  it('a MISSING session is refused without a throw, and the ready plan of another stays unclaimed', async () => {
    const h = await createHarness()
    await markCompactionComplete(h.workspaceId, SESSION_ID)
    h.managed.isProcessing = false
    expect(await h.manager.markPendingPlanExecutionDispatched('no-such-session', h.workspaceId)).toBe(false)
    expect(h.pending()).toMatchObject({ awaitingCompaction: false, executionDispatched: false })
  })
})

/**
 * F1.881 (origin WJ-crit-ww P-3) — a compaction that really FAILS clears the pending plan at once.
 *
 * It used to stay `awaitingCompaction` until the composer's 330 s wait (`COMPACTION_WAIT_TIMEOUT_MS`)
 * timed out and cleared it; upstream clears it on its `compaction_failed` event (craft-agents-oss
 * v0.13.4, `SessionManager.processEvent`). This tree has no such event, so the host reads the
 * failure each runtime already reports DURING the `/compact` turn: an `error` (Pi's rejected
 * compaction, codex's failed `thread/compact/start`) or claude's `Compaction failed…` warning
 * (`ClaudeEventAdapter.adaptStatusMessage`). Only while the plan still awaits its compaction.
 */
describe('Accept & Compact — a failed compaction clears the pending plan at once (F1.881)', () => {
  it('claude\'s "Compaction failed" warning during the /compact turn clears it', async () => {
    const h = await createHarness()
    await sendTurn(h, '/compact', [
      { type: 'info', message: 'Compaction failed: prompt too long', level: 'warning' },
      { type: 'complete' },
    ])
    await settle()
    expect(h.pending()).toBeNull()
  })

  it('NEGATIVE — an error with no /compact turn in flight leaves the plan awaiting', async () => {
    const h = await createHarness()
    h.managed.isProcessing = true
    await h.internals.processEvent(h.managed, { type: 'error', message: 'some unrelated failure' })
    await h.manager.flushSession(SESSION_ID, h.workspaceId)
    expect(h.pending()).toMatchObject({ awaitingCompaction: true })
  })

  it('BOUNDARY — an error AFTER the manual compaction made the plan ready leaves it ready', async () => {
    const h = await createHarness()
    await sendTurn(h, '/compact', [
      { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' },
      { type: 'error', message: 'a later failure in the same turn' },
      { type: 'complete' },
    ])
    await settle()
    expect(h.pending()).toMatchObject({ awaitingCompaction: false, executionDispatched: false })
  })
})
