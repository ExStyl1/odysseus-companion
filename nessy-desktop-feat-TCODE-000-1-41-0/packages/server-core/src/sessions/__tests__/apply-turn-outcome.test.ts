/**
 * UB6.15 — the turn-outcome SESSION half (`applyTurnOutcome`), driven on a real
 * `SessionManager` with the classifier stubbed at the module seam (the toggle
 * arms run the REAL `classifyTurnOutcome`: with the layer off the decision point
 * answers disabled and nothing moves — the default-toggle control is REAL).
 *
 * Arms:
 *  - positive: a `needs_input` outcome at ≥ 0.7 moves an open session to
 *    Needs Review and the visible reason rides the session and the event;
 *  - default toggle off → nothing moves (the real classifier answers null);
 *  - a closed session and a user-set (non-needs-review) status are never changed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedSession, type SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager'

describe('applyTurnOutcome session half (UB6.15)', () => {
  let tmpRoot: string
  let sm: any
  let events: unknown[][]

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-turn-outcome-'))
    sm = createTestSessionManager()
    events = []
    sm.setEventSink(((...args: unknown[]) => { events.push(args) }) as never)
    ;(sm as any).persistSession = () => {}
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function makeManaged(sessionStatus?: string): any {
    const workspace = { id: 'ws-test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id: 'outcome-session', name: 'Fix the bug' }, workspace as never, { messagesLoaded: true })
    if (sessionStatus) managed.sessionStatus = sessionStatus
    managed.messages = [
      { id: 'm1', role: 'user', content: 'fix the login bug' },
      { id: 'm2', role: 'assistant', content: 'I need the login page URL to proceed.', isIntermediate: false },
    ] as never
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('outcome-session', managed)
    return managed
  }

  it('positive — a needs_input outcome at >= 0.7 moves an open session and the reason rides it', async () => {
    const managed = makeManaged()
    // The classifier seam: needs_input at 0.9 (the module's own thresholds are
    // pinned by upstream's cases; this row's arms are the session move).
    sm.classifyForTurnOutcome = async () => ({ outcome: 'needs_input', confidence: 0.9 })

    await sm.applyTurnOutcome(managed, 'm2')

    expect(managed.sessionStatus).toBe('needs-review')
    expect(managed.statusSetByDecision).toEqual({ outcome: 'needs_input', probability: 0.9 })
    // The sink receives (channel, payload); unwrap before reading.
const moved = (events as Array<[string, Record<string, unknown>, Record<string, unknown>]>)
  .map(([, , payload]) => payload)
  .find(payload => payload?.type === 'session_status_changed')
    expect(moved).toBeTruthy()
    console.log('MOVED:', JSON.stringify(moved)); expect(moved!.statusSetByDecision).toEqual({ outcome: 'needs_input', probability: 0.9 })
  })

  it('default toggle off → the real classifier answers null and nothing moves', async () => {
    const managed = makeManaged()
    // No decision provider configured here: the REAL classifyTurnOutcome answers
    // null and applyTurnOutcome must return without moving anything.
    await sm.applyTurnOutcome(managed, 'm2')
    expect(managed.sessionStatus).toBeUndefined()
    expect(managed.statusSetByDecision).toBeUndefined()
  })

  it('a finished outcome never moves the session', async () => {
    const managed = makeManaged()
    sm.classifyForTurnOutcome = async () => ({ outcome: 'finished', confidence: 0.95 })
    await sm.applyTurnOutcome(managed, 'm2')
    expect(managed.sessionStatus).toBeUndefined()
  })

  it('a closed session is never changed', async () => {
    const managed = makeManaged('done') // category closed in the default status set
    sm.classifyForTurnOutcome = async () => ({ outcome: 'needs_input', confidence: 0.9 })
    await sm.applyTurnOutcome(managed, 'm2')
    expect(managed.sessionStatus).toBe('done')
    expect(managed.statusSetByDecision).toBeUndefined()
  })

  it('an already-needs-review session is not re-moved, and setSessionStatus clears the reason on any other write', async () => {
    const managed = makeManaged('needs-review')
    managed.statusSetByDecision = { outcome: 'needs_input', probability: 0.8 }
    sm.classifyForTurnOutcome = async () => ({ outcome: 'needs_input', confidence: 0.9 })
    await sm.applyTurnOutcome(managed, 'm2')
    // The apply arm declines; the reason stays as it was.
    expect(managed.sessionStatus).toBe('needs-review')

    // A user or automation pick (no byDecision) clears the reason.
    await sm.setSessionStatus('outcome-session', 'in-progress')
    expect(managed.statusSetByDecision).toBeUndefined()
  })
})
