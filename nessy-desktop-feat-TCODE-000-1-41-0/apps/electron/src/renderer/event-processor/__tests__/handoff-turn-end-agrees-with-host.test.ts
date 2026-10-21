/**
 * F1.164 (origin WJ-a P-WJ-a-1) — at the moment a HANDOFF ends a turn, does the
 * renderer's `isProcessing` agree with the host's own `managed.isProcessing`?
 *
 * `handleComplete`'s docblock (`handlers/session.ts`) says four of the eight
 * production `complete` emit sites "end the turn while it is still processing".
 * The row read that as the renderer lowering a flag the host still holds —
 * D1.379's defect in the other direction. This file asks the HOST instead of
 * the docblock: one rig, the real `SessionManager` handoff paths, every event
 * they put on the wire rendered through the real `processEvent`, and the host's
 * flag read INSIDE the event sink — so "at the same instant" means the instant
 * the host sent the event, not a reading taken afterwards.
 *
 * Two questions, kept apart because they have different answers:
 *
 *  1. THE TURN END. What the host holds at the instant each handoff `complete`
 *     leaves it, and whether the renderer agrees after rendering it.
 *  2. THE DRAIN. The docblock's "still processing" is the chat GENERATOR, which
 *     keeps yielding after `interruptForHandoff` (the chat loop's own comment:
 *     "the generator … yield[s] remaining queued events and then complete[s]
 *     naturally"). The loop forwards every drained event through
 *     `SessionManager.processEvent`, which is NOT gated on `managed.isProcessing`,
 *     and then skips the generator's trailing `complete` because the handoff
 *     already lowered the flag. So a drained `text_delta` / `tool_start` /
 *     non-hook `status` reaches the renderer AFTER the turn ended — and F1.78's
 *     mid-turn raise (`processor.ts`, `impliesTurnInFlight`) turns each one
 *     into `isProcessing: true` with no terminal event left to lower it.
 *
 * The drained events are injected at `SessionManager.processEvent`, the exact
 * seam the chat loop calls for every generator step; nothing downstream of it
 * is planted.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { processEvent as renderEvent } from '../processor'
import type { SessionState } from '../types'
// Reaching across for the REAL emitter, placed on this side of the fence for
// the reason `delta-flush-emitter-to-renderer.test.ts` records.
import {
  createManagedSession,
  type SessionManager,
} from '../../../../../../packages/server-core/src/sessions/SessionManager'
import { createTestSessionManager } from '../../../../../../packages/server-core/src/sessions/__tests__/test-session-manager'

const managers: SessionManager[] = []
const scratch: string[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

type Internals = {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  beginAuthRequest(managed: unknown, request: Record<string, unknown>): Promise<void> | void
  projectPiPlanSubmission(managed: unknown, planPath: string): Promise<void>
}

/** One wire event and the host's own flag at the instant it was sent. */
type Sent = { event: SessionEvent; hostIsProcessing: boolean }

function setUp(sessionId: string) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const managed = createManagedSession({ id: sessionId }, {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: `/tmp/nessy-${sessionId}`,
    createdAt: 1,
  } as never, { messagesLoaded: true })
  const sent: Sent[] = []
  manager.setEventSink((_channel, _target, event) => {
    sent.push({ event: event as SessionEvent, hostIsProcessing: (managed as { isProcessing: boolean }).isProcessing })
  })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`ws_test:${sessionId}`, managed)
  ;(managed as { isProcessing: boolean }).isProcessing = true
  ;(managed as { agent: unknown }).agent = {
    interruptForHandoff: () => undefined,
    forceAbort: () => undefined,
    getSessionId: () => undefined,
  }
  return { manager, managed, sent, internals: manager as unknown as Internals }
}

function writePlan(): string {
  const dir = mkdtempSync(join(tmpdir(), 'f1-164-plan-'))
  scratch.push(dir)
  const planPath = join(dir, 'plan.md')
  writeFileSync(planPath, '# Plan\n\n1. do the thing\n')
  return planPath
}

/** Past `DELTA_BATCH_INTERVAL_MS` (50 ms): the batch timer has had its chance. */
const pastTheBatchTimer = () => new Promise(resolve => setTimeout(resolve, 80))

/**
 * The renderer's state before the handoff: a turn in flight, started by the
 * user's own prompt — what a window that watched the turn start holds.
 */
function turnInFlight(sessionId: string): SessionState {
  return {
    session: {
      id: sessionId,
      messages: [{ id: 'user-1', role: 'user', content: 'plan the thing', timestamp: 1 }],
      lastMessageAt: 1,
      isProcessing: true,
    } as never,
    streaming: null,
  }
}

/**
 * The events the renderer reads turn state from — the ones a handler lowers the
 * flag on, plus the three F1.78 raises on. Every other event on the wire (for
 * example the `pi_harness_runtime_invalidated` that `setProcessing` itself
 * emits) is rendered but not compared: the renderer cannot know the host
 * lowered its flag until an event that SAYS so arrives, so an unrelated event
 * sent in between carries no agreement to test.
 */
const TURN_STATE_EVENTS = new Set([
  'plan_submitted', 'auth_request', 'complete', 'interrupted', 'error',
  'text_delta', 'tool_start', 'status',
])

/**
 * Render the wire one event at a time and pair each turn-state event with BOTH
 * readings: the host's flag when it sent the event, and the renderer's after it.
 */
function readings(sessionId: string, sent: Sent[], from: SessionState = turnInFlight(sessionId)) {
  let state = from
  const rows: { type: string; host: boolean; renderer: boolean }[] = []
  for (const { event, hostIsProcessing } of sent) {
    state = renderEvent(state, event as never).state
    if (!TURN_STATE_EVENTS.has(event.type)) continue
    rows.push({ type: event.type, host: hostIsProcessing, renderer: state.session.isProcessing === true })
  }
  return rows
}

const disagreements = (rows: ReturnType<typeof readings>) => rows.filter(row => row.host !== row.renderer)

/** What the chat loop hands `processEvent` while the aborted generator drains. */
async function drain(internals: Internals, managed: unknown) {
  await internals.processEvent(managed, { type: 'text_delta', text: 'and then I will ', turnId: 'T' })
  await internals.processEvent(managed, { type: 'tool_start', toolUseId: 'drained-1', toolName: 'Bash', input: { command: 'ls' } })
  await internals.processEvent(managed, { type: 'status', message: 'Thinking' })
  await pastTheBatchTimer()
}

describe('F1.164 · the turn END of a handoff: the host has already lowered its flag', () => {
  it('the auth request lowers the host flag BEFORE its `complete` — the renderer agrees at every event', async () => {
    const { managed, sent, internals } = setUp('f1164-auth')
    await internals.beginAuthRequest(managed, {
      type: 'oauth',
      provider: 'github',
      requestId: 'req-f1164',
      sessionId: 'f1164-auth',
      sourceSlug: 'github',
      sourceName: 'GitHub',
    })
    await pastTheBatchTimer()

    const rows = readings('f1164-auth', sent)
    expect(rows.map(row => row.type)).toEqual(['complete', 'auth_request'])
    expect(rows.find(row => row.type === 'complete')).toEqual({ type: 'complete', host: false, renderer: false })
    expect(disagreements(rows)).toEqual([])
  })

  it('the adjacent plan submission lowers the host flag BEFORE its `complete` — agreement at every event', async () => {
    const { managed, sent, internals } = setUp('f1164-plan-adjacent')
    await internals.projectPiPlanSubmission(managed, writePlan())
    await pastTheBatchTimer()

    const rows = readings('f1164-plan-adjacent', sent)
    expect(rows.map(row => row.type)).toEqual(['plan_submitted', 'complete'])
    expect(rows.find(row => row.type === 'complete')).toEqual({ type: 'complete', host: false, renderer: false })
    expect(disagreements(rows)).toEqual([])
  })

  it('the Pi plan-mode projection lowers the host flag BEFORE its `complete` — agreement at every event (F1.214)', async () => {
    // This was the one handoff site that lowered AFTER the event: it awaited
    // `releaseBrowserOwnershipOnForcedStop` and `sendTurnEndEvent` and only then
    // called `setProcessing(false)`, so this arm pinned `complete host=true` as a
    // stated host-ordering residue (WJ-t, P-WJ-t-1). F1.214 moved the lowering
    // above both awaits, as the adjacent and auth paths already had it, and the
    // arm now asks for the same agreement they get.
    const { managed, sent, internals } = setUp('f1164-plan-projected')
    ;(managed as { piPlanProjectionId?: string }).piPlanProjectionId = 'pi-plan-1'
    await internals.projectPiPlanSubmission(managed, writePlan())
    await pastTheBatchTimer()

    const rows = readings('f1164-plan-projected', sent)
    expect(rows.map(row => row.type)).toEqual(['plan_submitted', 'complete'])
    expect(rows.find(row => row.type === 'complete')).toEqual({ type: 'complete', host: false, renderer: false })
    expect(disagreements(rows)).toEqual([])
    expect((managed as { isProcessing: boolean }).isProcessing).toBe(false)
  })
})

describe('F1.164 · the DRAIN after a handoff: nothing may put the turn back', () => {
  it('THE DEFECT — auth handoff, then the draining generator: the renderer must stay idle with the host', async () => {
    const { managed, sent, internals } = setUp('f1164-auth-drain')
    await internals.beginAuthRequest(managed, {
      type: 'oauth',
      provider: 'github',
      requestId: 'req-f1164-drain',
      sessionId: 'f1164-auth-drain',
      sourceSlug: 'github',
      sourceName: 'GitHub',
    })
    await drain(internals, managed)

    const rows = readings('f1164-auth-drain', sent)
    // The host forwards the drained events with its own flag DOWN…
    expect(rows.filter(row => row.type !== 'complete' && row.type !== 'auth_request').every(row => row.host === false)).toBe(true)
    expect(rows.map(row => row.type)).toEqual(expect.arrayContaining(['text_delta', 'tool_start', 'status']))
    // …so the renderer must not raise its own back up.
    expect(disagreements(rows)).toEqual([])
    expect((managed as { isProcessing: boolean }).isProcessing).toBe(false)
  })

  it('THE DEFECT — plan handoff (adjacent path), then the draining generator', async () => {
    const { managed, sent, internals } = setUp('f1164-plan-drain')
    await internals.projectPiPlanSubmission(managed, writePlan())
    await drain(internals, managed)

    const rows = readings('f1164-plan-drain', sent)
    expect(rows.map(row => row.type)).toEqual(expect.arrayContaining(['text_delta', 'tool_start', 'status']))
    expect(disagreements(rows)).toEqual([])
  })

  it('THE DEFECT — plan handoff (Pi projection path), then the draining generator', async () => {
    const { managed, sent, internals } = setUp('f1164-plan-projected-drain')
    ;(managed as { piPlanProjectionId?: string }).piPlanProjectionId = 'pi-plan-2'
    await internals.projectPiPlanSubmission(managed, writePlan())
    await drain(internals, managed)

    const rows = readings('f1164-plan-projected-drain', sent)
    // Since F1.214 the projection lowers before its `complete` too: nothing may
    // disagree, the handoff marker included.
    expect(disagreements(rows).map(row => row.type)).toEqual([])
  })
})

describe('F1.164 · controls — the raise F1.78 exists for is untouched', () => {
  it('CONTROL — mid-turn events with the host still processing (no handoff) keep the renderer raised', async () => {
    // A window that believes the session idle while the host runs a turn: the
    // D1.379 case. Nothing here is a handoff, so every raise must survive.
    const { managed, sent, internals } = setUp('f1164-no-handoff')
    await drain(internals, managed)

    const believedIdle = turnInFlight('f1164-no-handoff')
    const rows = readings('f1164-no-handoff', sent, {
      ...believedIdle,
      session: { ...believedIdle.session, isProcessing: false },
    })
    expect(rows.map(row => row.type)).toEqual(expect.arrayContaining(['text_delta', 'tool_start', 'status']))
    expect(rows.every(row => row.host === true && row.renderer === true)).toBe(true)
  })

  it('CONTROL — after the handoff, the NEXT turn (a new user message) raises again on its own activity', async () => {
    const { managed, sent, internals } = setUp('f1164-next-turn')
    await internals.projectPiPlanSubmission(managed, writePlan())
    await pastTheBatchTimer()

    let state = turnInFlight('f1164-next-turn')
    for (const { event } of sent) state = renderEvent(state, event as never).state
    expect(state.session.isProcessing).toBe(false)

    // A user row newer than the plan is the NEXT turn, whatever put it there
    // (the renderer's own optimistic send, a `user_message`, a transcript
    // refresh). The flag is left down here so the raise itself is under test.
    state = {
      ...state,
      session: {
        ...state.session,
        messages: [...state.session.messages, { id: 'user-2', role: 'user', content: 'approved', timestamp: Date.now() + 1 }],
      } as never,
    }
    state = renderEvent(state, { type: 'text_delta', sessionId: 'f1164-next-turn', delta: 'working' } as never).state
    expect(state.session.isProcessing).toBe(true)
  })

  it('CONTROL — an ANSWERED auth request stops being a boundary: the resumed turn raises again', async () => {
    const { managed, sent, internals } = setUp('f1164-auth-answered')
    await internals.beginAuthRequest(managed, {
      type: 'oauth',
      provider: 'github',
      requestId: 'req-f1164-answered',
      sessionId: 'f1164-auth-answered',
      sourceSlug: 'github',
      sourceName: 'GitHub',
    })
    await pastTheBatchTimer()

    let state = turnInFlight('f1164-auth-answered')
    for (const { event } of sent) state = renderEvent(state, event as never).state
    expect(state.session.isProcessing).toBe(false)
    // Still pending: a drained event leaves it down (the defect arm above).
    const pendingDelta = renderEvent(state, { type: 'text_delta', sessionId: 'f1164-auth-answered', delta: 'x' } as never).state
    expect(pendingDelta.session.isProcessing).toBe(false)

    // Answered: `auth_completed` moves the row off `pending`, the host resumes,
    // and that turn's activity is a turn in flight again.
    state = renderEvent(state, {
      type: 'auth_completed',
      sessionId: 'f1164-auth-answered',
      requestId: 'req-f1164-answered',
      success: true,
    } as never).state
    state = renderEvent(state, { type: 'text_delta', sessionId: 'f1164-auth-answered', delta: 'resumed' } as never).state
    expect(state.session.isProcessing).toBe(true)
  })
})
