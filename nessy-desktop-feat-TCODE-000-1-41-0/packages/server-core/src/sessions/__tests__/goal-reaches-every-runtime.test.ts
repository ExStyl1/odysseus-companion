/**
 * P2.488 — the goal has been HOST-SIDE on all three coding runtimes since P2.2,
 * and both paths that carry it to the renderer were still Pi-gated:
 *
 *  - `getPiHarnessRuntimeSnapshot` took its `provider !== 'pi'` early return with
 *    NO `goal` field at all, so the only shape the renderer reads never carried
 *    one on claude or codex.
 *  - `emitPiHarnessInvalidation` opened with a non-Pi return, so the `['goal']`
 *    emit the goal service's own persist callback fires on every runtime was
 *    dropped before it reached the wire — and the continuation re-arm in the same
 *    method's second half was dropped with it.
 *
 * A goal surface built on that pair would have rendered on Pi and SILENTLY never
 * rendered on the other two. These tests pin BOTH halves per runtime, with the Pi
 * row present as the positive control in every table: a mutant that re-breaks the
 * gate must fail the claude and codex rows while Pi stays green, which is what
 * distinguishes this from a suite that would pass against an all-runtimes-broken
 * projection.
 *
 * Harness shape follows `SessionManager.pi-runtime-snapshot.test.ts` — a real
 * manager overridden with the collaborators the two methods actually touch.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { PiGoalBudgetsV1 } from '@nessy-agent/shared/sessions'
import { parsePiHarnessRuntimeSnapshotV1 } from '@nessy-agent/shared/protocol'
import { GoalService, GOAL_CHECKIN_ENV } from '../../pi-harness/goal-service'
import { createTestSessionManager } from './test-session-manager.ts'

type Provider = 'pi' | 'anthropic' | 'codex-runtime' | 'nestor-cloud-agent'

/** The three runtimes P2.2 put the goal service, its port and its continuation on. */
const CODING_RUNTIMES: Provider[] = ['pi', 'anthropic', 'codex-runtime']

function managerFor(provider: Provider) {
  const manager = createTestSessionManager() as any
  const managed: any = {
    id: 's', workspace: { id: 'w', rootPath: '/tmp', name: 'w', createdAt: 1 }, ephemeral: true,
    agent: null, messages: [], processingGeneration: 0, permissionMode: 'default',
    isProcessing: false, messageQueue: [], queuePaused: false,
    backgroundTaskOutputs: new Map(), piBackgroundTaskKinds: new Map(),
  }
  manager.sessions = new Map([['w:s', managed]])
  manager.resolveManagedProvider = () => provider
  // P2.523 — `listRunning` is what the non-Pi branch reads now, and
  // `countRunning` stays on the stub because the PI branch and other callers
  // still use it. A stub missing the port the code under test calls fails as
  // `not a function`, which reads like a product defect.
  manager.piProcessSupervisor = { snapshot: async () => [], countRunning: mock(async () => 0), listRunning: mock(async () => []), stop: mock(async () => {}) }
  manager.piTaskServices = new Map(); manager.piGoalServices = new Map(); manager.piAskUserServices = new Map()
  manager.piPlanModeServices = new Map(); manager.piChildSessionServices = new Map()
  manager.piWorktreeLeaseServices = new Map(); manager.piLspServices = new Map()
  manager.piLspRegistrations = new Map(); manager.piLspAuthoritySignatures = new Map()
  manager.pendingPermissionRequests = new Map()
  manager.directPermissionResolvers = new Map()
  manager.taskOutputIndex = new Map()
  manager.projectMutationSessions = new Set()
  manager.persistSession = mock(() => {})
  manager.eventSink = () => {}
  return { manager, managed }
}

/** A real `GoalService` holding one active goal, installed under the session key. */
async function withActiveGoal(
  manager: any,
  options: { now?: () => number; budgets?: Partial<PiGoalBudgetsV1> } = {},
): Promise<GoalService> {
  const service = new GoalService(
    { workspaceId: 'w', sessionId: 's' },
    { ...(options.now ? { now: options.now } : {}), newId: () => 'goal-1' },
  )
  await service.execute({
    action: 'create',
    condition: 'the suite is green',
    source: 'user',
    creator: 'operator',
    ...(options.budgets ? { budgets: options.budgets } : {}),
  })
  manager.piGoalServices.set('w:s', service)
  return service
}

describe('P2.488 the goal reaches the renderer on every runtime that can hold one', () => {
  test.each(CODING_RUNTIMES)('the runtime snapshot carries an active goal on %s', async provider => {
    const { manager } = managerFor(provider)
    await withActiveGoal(manager)

    const snapshot = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })

    // The assertion that dies when the non-Pi branch drops the field again.
    expect(snapshot.goal).toBeDefined()
    expect(snapshot.goal).toMatchObject({ id: 'goal-1', revision: 1, status: 'active', condition: 'the suite is green' })
    // The branch itself is unchanged in every other respect: the projection still
    // declares the Pi harness absent on the two adjacent runtimes.
    if (provider !== 'pi') expect(snapshot).toMatchObject({ available: false, unavailableReason: 'provider-not-pi' })
    // The real boundary is the wire, not the TypeScript union: the renderer parses
    // what the host produced, and the validator is provider-blind about `goal`.
    expect(parsePiHarnessRuntimeSnapshotV1(JSON.parse(JSON.stringify(snapshot))).goal)
      .toMatchObject({ id: 'goal-1', status: 'active' })
  })

  /**
   * The `??` fallback arm, which is the one a restored session takes: `goalState`
   * is in `SESSION_PERSISTENT_FIELDS`, so a claude session reloaded from disk has
   * the state before any service exists in the map.
   */
  test('a restored claude session projects its goal from persisted state alone', async () => {
    const seed = new GoalService({ workspaceId: 'w', sessionId: 's' }, { newId: () => 'goal-restored' })
    await seed.execute({ action: 'create', condition: 'survive a reload', source: 'agent', creator: 'claude' })

    const { manager, managed } = managerFor('anthropic')
    managed.goalState = seed.snapshot()
    expect(manager.piGoalServices.size).toBe(0)

    const snapshot = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
    expect(snapshot.goal).toMatchObject({ id: 'goal-restored', status: 'active', condition: 'survive a reload' })
  })

  /**
   * Budgets are enforced on the SAME read the Pi branch enforces them on. Without
   * the `enforceBudgets()` call the surface would keep reporting `active` for a
   * goal `schedulePiGoalContinuation` had already retired — a field disagreeing
   * with the mechanism behind it, which is worse than the absent field this row
   * is fixing.
   */
  test.each(CODING_RUNTIMES)('an exhausted budget is enforced by the snapshot read on %s', async provider => {
    let clock = 1_000
    const { manager } = managerFor(provider)
    await withActiveGoal(manager, { now: () => clock, budgets: { elapsedLimitMs: 50 } })

    const beforeExpiry = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
    expect(beforeExpiry.goal).toMatchObject({ status: 'active' })

    clock += 5_000
    const afterExpiry = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
    expect(afterExpiry.goal).toMatchObject({ status: 'budget_exhausted' })
  })

  test.each(CODING_RUNTIMES)('a goal invalidation reaches the wire on %s', async provider => {
    const { manager, managed } = managerFor(provider)
    const events: any[] = []
    manager.eventSink = (...args: unknown[]) => events.push(args)
    manager.schedulePiGoalContinuation = mock(() => {})

    manager.emitPiHarnessInvalidation(managed, ['goal'])

    const invalidations = events.map(value => value[2]).filter(value => value.type === 'pi_harness_runtime_invalidated')
    expect(invalidations.map(value => value.changedDomains)).toEqual([['goal']])
    expect(invalidations[0]).toMatchObject({ sessionId: 's', session: { workspaceId: 'w', sessionId: 's' } })
  })

  /**
   * `nestor-cloud-agent` is the runtime the widened gate still buys something on:
   * it runs no host tool loop, so `schedulePiGoalContinuation` refuses it and it
   * can hold no goal that advances. The emitter must stop there, or the widening
   * would be a blanket removal rather than the precedent's set.
   */
  test('a goal invalidation stops at nestor-cloud-agent', () => {
    const { manager, managed } = managerFor('nestor-cloud-agent')
    const events: any[] = []
    manager.eventSink = (...args: unknown[]) => events.push(args)
    manager.schedulePiGoalContinuation = mock(() => {})

    manager.emitPiHarnessInvalidation(managed, ['goal'])

    expect(JSON.stringify(events)).not.toContain('pi_harness_runtime_invalidated')
    expect(manager.schedulePiGoalContinuation).not.toHaveBeenCalled()
  })

  /**
   * The emitter's SECOND half. P2.2 armed the goal continuation between turns off
   * exactly these domains; the Pi gate above it meant claude and codex reached the
   * mechanism only through `onProcessingStopped` and the background-task handler.
   */
  test.each(CODING_RUNTIMES)('a settled permission change re-arms the goal continuation on %s', async provider => {
    const { manager, managed } = managerFor(provider)
    manager.schedulePiGoalContinuation = mock(() => {})

    manager.emitPiHarnessInvalidation(managed, ['interactions', 'security'])
    expect(manager.schedulePiGoalContinuation).toHaveBeenCalledTimes(1)

    // Still not while a turn is running — the re-arm's own precondition is
    // untouched by the widened provider gate.
    managed.isProcessing = true
    manager.emitPiHarnessInvalidation(managed, ['interactions', 'security'])
    expect(manager.schedulePiGoalContinuation).toHaveBeenCalledTimes(1)
  })
})

/**
 * P6.322 (H49) · the goal check-in NOTICE, on the host.
 *
 * The ladder (when one is due) is unit-tested in `pi-harness/goal-service.test.ts`.
 * What is only observable here is that the sweep writes a transcript entry and
 * an `info` event rather than starting a turn — the controller decision this row
 * was dispatched with — and that a `blocked` goal's notice SAYS it cannot be
 * answered from inside the app.
 */
describe('P6.322 the goal check-in is a host-side notice, not a turn', () => {
  const previous = process.env[GOAL_CHECKIN_ENV]
  afterEach(() => {
    if (previous === undefined) delete process.env[GOAL_CHECKIN_ENV]
    else process.env[GOAL_CHECKIN_ENV] = previous
  })

  function sweepHarness() {
    const { manager, managed } = managerFor('pi')
    const appended: any[] = []
    const events: any[] = []
    manager.monotonic = () => 1_000
    manager.appendManagedMessage = (_session: unknown, message: unknown) => { appended.push(message) }
    manager.sendEvent = (event: unknown) => { events.push(event) }
    manager.managedKey = () => 'w:s'
    return { manager, managed, appended, events }
  }

  test('an idle goal past the interval produces one info entry and NO turn', async () => {
    process.env[GOAL_CHECKIN_ENV] = '1'
    const h = sweepHarness()
    const service = await withActiveGoal(h.manager)
    const at = service.snapshot().goal!.updatedAt

    // The negative first: nothing is due before the interval.
    expect(h.manager.sweepGoalCheckIns(at + 30_000)).toBe(0)
    expect(h.appended).toEqual([])

    expect(h.manager.sweepGoalCheckIns(at + 60_000)).toBe(1)
    expect(h.appended).toHaveLength(1)
    expect(h.appended[0].role).toBe('info')
    expect(String(h.appended[0].content)).toContain('has not moved')
    expect(h.events[0]).toMatchObject({ type: 'info', sessionId: 's', level: 'info' })
    // The whole point of the controller decision: nothing was queued for the
    // model and nothing woke the session.
    expect(h.managed.messageQueue).toEqual([])
    expect(h.managed.pendingTaskNotifications).toBeUndefined()
  })

  test('a BLOCKED goal is told, in the notice, that the app cannot answer it', async () => {
    process.env[GOAL_CHECKIN_ENV] = '1'
    const h = sweepHarness()
    const service = await withActiveGoal(h.manager)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const goal = service.snapshot().goal!
      await service.execute({
        action: 'blocked',
        id: goal.id,
        revision: goal.revision,
        blockingCondition: 'the migration job has not finished',
        blockedBy: 'external',
        reason: 'still queued',
        evidence: ['job 41 queued'],
      })
    }
    expect(service.snapshot().goal!.status).toBe('blocked')
    const at = service.snapshot().goal!.updatedAt

    expect(h.manager.sweepGoalCheckIns(at + 60_000)).toBe(1)
    const text = String(h.appended[0].content)
    expect(text).toContain('Goal blocked')
    expect(text).toContain('the migration job has not finished')
    // W7-g's measured deadlock, stated where the person who meets it is looking.
    expect(text).toContain('cannot be answered here')
    expect(h.events[0].level).toBe('warning')
  })

  test('0 turns it off, and a busy session is never told its goal has not moved', async () => {
    process.env[GOAL_CHECKIN_ENV] = '0'
    const off = sweepHarness()
    const service = await withActiveGoal(off.manager)
    const at = service.snapshot().goal!.updatedAt
    expect(off.manager.sweepGoalCheckIns(at + 600_000)).toBe(0)

    process.env[GOAL_CHECKIN_ENV] = '1'
    const busySession = sweepHarness()
    const busyService = await withActiveGoal(busySession.manager)
    busySession.managed.isProcessing = true
    expect(busySession.manager.sweepGoalCheckIns(busyService.snapshot().goal!.updatedAt + 600_000)).toBe(0)
    expect(busySession.appended).toEqual([])
  })
})
