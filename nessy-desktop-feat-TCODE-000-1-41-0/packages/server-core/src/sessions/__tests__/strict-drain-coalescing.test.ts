/**
 * P2.175 — what a second caller may claim from a strict Pi drain already in
 * flight.
 *
 * `strictDrainPiSession` coalesces on the session key. Before this row it handed
 * the in-flight promise to whoever asked next, so a joiner reported an outcome
 * that was never computed for it. Two ways that is wrong, and the suite drives
 * both:
 *
 *  - **the boundary, and it is LIVE.** Every one of the eight
 *    `strictDrainSessionForMutation` call sites drains with `boundaryHeld =
 *    true`, as does `auth retry`; only `agent view stop` and the parent-child
 *    stop own their boundary. A borrowed-boundary drain is a STEP of an outer
 *    mutation that goes on mutating afterwards, so its completion is not a
 *    statement that the session is quiescent — and `agent view stop`, which
 *    would have been refused at `acquireSessionMutationBoundary` without the
 *    shortcut, awaited it and answered `ok: true`.
 *  - **the keep set, and it is a GUARD.** No strict drain carries one at HEAD
 *    (the three exempted teardowns call `disposeManagedAgentRuntime` directly
 *    and never take this lock), which the suite asserts as a fact rather than
 *    assuming. It is the arm an auth-retry exemption would have made live, and
 *    the owner decision of 2026-09-02 asks for it before any such exemption.
 *
 * Driven on a real manager with the collaborators stubbed, the shape
 * `SessionManager.agent-view.test.ts` established and D1.242 converted on both
 * sides: the method under test is the REAL one, and only what it reaches is
 * faked.
 */

import { describe, expect, mock, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { canClaimStrictPiDrain, type StrictPiDrainInFlight } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE = { id: 'workspace-drain', name: 'Drain', rootPath: '/tmp/drain' }
const session = (id: string, provider = 'pi') => ({ id, workspace: WORKSPACE, provider })
const keyOf = (id: string) => encodeSessionKey({ workspaceId: WORKSPACE.id, sessionId: id })

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/**
 * Bound a call that must ANSWER, not merely settle eventually.
 *
 * Every mutant of the coalescing rule turns a refusal into "you now hold the
 * in-flight drain's promise", and that promise is a deferred this suite has not
 * released yet — so an unbounded assertion HANGS instead of failing. Measured:
 * the first campaign's M1 ran 4 minutes at 98% CPU and had to be killed, which
 * is the trap register's hung-mutant shape read as a survivor. The rejection
 * message is distinguishable, so a mutant fails on the assertion rather than on
 * a timeout with no cause.
 */
function answered<T>(operation: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('never-answered: the call inherited a drain that has not settled')), ms).unref?.()
    }),
  ])
}

/**
 * A manager whose `strictDrainPiSessionOwned` is a controllable stub, so a drain
 * can be held open while a second caller arrives.
 */
function fixture() {
  const manager = createTestSessionManager() as any
  const gates: Array<ReturnType<typeof deferred>> = []
  manager.piSessionDrainLocks = new Map<string, StrictPiDrainInFlight>()
  manager.projectMutationSessions = new Set<string>()
  manager.resolveManagedProvider = (item: any) => item.provider ?? 'pi'
  manager.strictDrainPiSessionOwned = mock(async () => {
    const gate = deferred()
    gates.push(gate)
    await gate.promise
  })
  return { manager, gates }
}

describe('P2.175 · canClaimStrictPiDrain', () => {
  const record = (over: Partial<StrictPiDrainInFlight> = {}): StrictPiDrainInFlight => ({
    operation: Promise.resolve(),
    reason: 'in flight',
    keeps: [],
    ownsBoundary: true,
    ...over,
  })

  test('a drain that takes everything and owns its boundary may be claimed', () => {
    expect(canClaimStrictPiDrain(record())).toBe(true)
  })

  test('a borrowed boundary is never claimable — the outer mutation continues after it', () => {
    expect(canClaimStrictPiDrain(record({ ownsBoundary: false }))).toBe(false)
  })

  test('a keep set is never claimable — the joiner needs what the drain is sparing', () => {
    expect(canClaimStrictPiDrain(record({ keeps: ['monitor'] }))).toBe(false)
    expect(canClaimStrictPiDrain(record({ keeps: ['monitor'], ownsBoundary: false }))).toBe(false)
  })
})

describe('P2.175 · strictDrainPiSession coalescing', () => {
  test('two boundary-owning callers share ONE drain', async () => {
    const { manager, gates } = fixture()
    const managed = session('session-share')
    const first = manager.strictDrainPiSession(managed, 'agent view stop')
    const second = manager.strictDrainPiSession(managed, 'parent p child stop')
    expect(manager.strictDrainPiSessionOwned).toHaveBeenCalledTimes(1)
    gates[0]!.resolve()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    // …and the lock is released, so the next caller drains for real rather than
    // inheriting a settled promise.
    expect(manager.piSessionDrainLocks.has(keyOf('session-share'))).toBe(false)
  })

  /**
   * THE LIVE ARM. `agent view stop` arriving during a runtime switch, an auth
   * retry, a rewind, a deletion or a quit — all of which drain with the boundary
   * held by an operation that keeps mutating afterwards.
   */
  test('refuses to claim a drain that is a step of someone else\'s mutation', async () => {
    const { manager, gates } = fixture()
    const managed = session('session-borrowed')
    const outer = manager.strictDrainPiSession(managed, 'runtime switch (connection-cross-runtime)', true)
    await expect(answered(manager.strictDrainPiSession(managed, 'agent view stop')))
      .rejects.toThrow('pi-session-drain-not-claimable:agent view stop:runtime switch (connection-cross-runtime)')
    // The refusal names BOTH sides: what was asked, and what is holding.
    // And it does not disturb the drain it declined to claim — one drain ran,
    // its lock entry survived the refusal, and it still settles for its owner.
    expect(manager.strictDrainPiSessionOwned).toHaveBeenCalledTimes(1)
    expect(manager.piSessionDrainLocks.has(keyOf('session-borrowed'))).toBe(true)
    gates[0]!.resolve()
    await expect(outer).resolves.toBeUndefined()
    expect(manager.piSessionDrainLocks.has(keyOf('session-borrowed'))).toBe(false)
  })

  /**
   * THE GUARD ARM — the shape an auth-retry exemption would create. Seeded
   * directly, because nothing produces it today and the next test asserts that.
   */
  test('refuses to claim a drain that is sparing something', async () => {
    const { manager } = fixture()
    const managed = session('session-keeps')
    const held = deferred()
    manager.piSessionDrainLocks.set(keyOf('session-keeps'), {
      operation: held.promise,
      reason: 'auth retry',
      keeps: ['monitor'],
      ownsBoundary: true,
    } satisfies StrictPiDrainInFlight)
    await expect(answered(manager.strictDrainPiSession(managed, 'agent view stop')))
      .rejects.toThrow('pi-session-drain-not-claimable:agent view stop:auth retry')
    expect(manager.strictDrainPiSessionOwned).not.toHaveBeenCalled()
    held.resolve()
    await held.promise
  })

  test('every drain this lock records today takes EVERYTHING and answers only to itself', async () => {
    const { manager, gates } = fixture()
    const managed = session('session-record')
    const drain = manager.strictDrainPiSession(managed, 'agent view stop')
    const record: StrictPiDrainInFlight = manager.piSessionDrainLocks.get(keyOf('session-record'))
    // The claim the guard rests on, asserted rather than assumed: no strict
    // drain carries a keep set, because `strictDrainPiSessionOwned` passes no
    // drain options at all. If a future exemption threads one through, this is
    // the assertion that has to be looked at.
    expect(record.keeps).toEqual([])
    expect(record.ownsBoundary).toBe(true)
    expect(record.reason).toBe('agent view stop')
    gates[0]!.resolve()
    await drain
  })

  test('a borrowed-boundary drain records itself as such', async () => {
    const { manager, gates } = fixture()
    const managed = session('session-borrowed-record')
    const drain = manager.strictDrainPiSession(managed, 'session deletion', true)
    expect(manager.piSessionDrainLocks.get(keyOf('session-borrowed-record')).ownsBoundary).toBe(false)
    gates[0]!.resolve()
    await drain
  })

  test('a non-Pi session never reaches the lock at all', async () => {
    const { manager } = fixture()
    await expect(manager.strictDrainPiSession(session('session-claude', 'anthropic'), 'auth retry'))
      .resolves.toBeUndefined()
    expect(manager.strictDrainPiSessionOwned).not.toHaveBeenCalled()
    expect(manager.piSessionDrainLocks.size).toBe(0)
  })

  test('a failed drain releases the lock, and its failure belongs to its own caller', async () => {
    const manager = createTestSessionManager() as any
    manager.piSessionDrainLocks = new Map<string, StrictPiDrainInFlight>()
    manager.resolveManagedProvider = () => 'pi'
    manager.strictDrainPiSessionOwned = mock(async () => { throw new Error('pi-session-drain-failed:agent view stop') })
    await expect(answered(manager.strictDrainPiSession(session('session-fail'), 'agent view stop')))
      .rejects.toThrow('pi-session-drain-failed')
    expect(manager.piSessionDrainLocks.has(keyOf('session-fail'))).toBe(false)
  })
})

/**
 * The user-visible half of the live arm: pressing STOP while an outer mutation
 * drains now answers `ok: false` instead of `ok: true` over a session that is
 * about to keep running.
 */
describe('P2.175 · agent view stop during someone else\'s mutation', () => {
  test('answers ok:false rather than reporting a stop it cannot guarantee', async () => {
    const { manager, gates } = fixture()
    const managed = session('session-stop')
    manager.getManaged = () => managed
    manager.persistSession = () => {}
    manager.emitPiHarnessInvalidation = () => {}
    const outer = manager.strictDrainPiSession(managed, 'auth retry', true)

    const result = await answered(manager.controlPiAgentView({
      schemaVersion: 1,
      action: 'stop',
      session: { workspaceId: WORKSPACE.id, sessionId: 'session-stop' },
    }))
    expect(result).toMatchObject({ ok: false, error: 'agent-view-stop-failed' })
    // The defect, stated as the thing that must no longer happen.
    expect((managed as any).piAgentViewOutcome).toBeUndefined()

    gates[0]!.resolve()
    await outer
  })
})
