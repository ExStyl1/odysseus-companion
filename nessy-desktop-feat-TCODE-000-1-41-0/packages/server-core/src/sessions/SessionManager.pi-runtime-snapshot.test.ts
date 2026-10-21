import { describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileCheckpoint, finalizeFileCheckpoint } from '@nessy-agent/shared/sessions'
import { parsePiHarnessRuntimeSnapshotV1 } from '@nessy-agent/shared/protocol'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

function managerFor(provider: 'pi' | 'anthropic' | 'codex-runtime' | 'nestor-cloud-agent', agent: any = null) {
  const manager = createTestSessionManager() as any
  const managed: any = {
    id: 's', workspace: { id: 'w', rootPath: '/tmp', name: 'w', createdAt: 1 }, ephemeral: true,
    agent, messages: [], processingGeneration: 0, permissionMode: 'default', taskState: { schemaVersion: 1, revision: 1, tasks: [], tombstones: [] },
    childSessionState: { schemaVersion: 1, revision: 1, sealedOwnerTaskIds: [], children: [] },
    backgroundTaskOutputs: new Map(), piBackgroundTaskKinds: new Map(), isProcessing: false,
    // TFP1 (2026-10-10): the real ManagedSession always carries this map
    // (non-optional in the type, constructed `new Map()` at the session
    // factory), and UA12.101's task_completed arm (eb84bef6d) reads it —
    // `managed.backgroundShellCommands.delete(event.taskId)` — on the settled
    // drive below. The stub predates the field.
    backgroundShellCommands: new Map(),
    mailboxState: { schemaVersion: 1, revision: 1, messages: [{ body: 'mail-secret' }] },
    worktreeLeaseState: { schemaVersion: 1, revision: 1, leases: [{ schemaVersion: 1, worktreeLeaseId: 'lease', workspaceId: 'w', ownerAgentId: 'agent', path: '/secret/server/path', branch: 'feature', baseSha: 'sha', status: 'active' }] },
  }
  manager.sessions = new Map([['w:s', managed]])
  manager.resolveManagedProvider = () => provider
  // P2.523 — `listRunning` is what the non-Pi branch reads now, and
  // `countRunning` stays on the stub because the PI branch and other callers
  // still use it. A stub missing the port the code under test calls fails as
  // `not a function`, which reads like a product defect.
  manager.piProcessSupervisor = { snapshot: async () => [], countRunning: mock(async () => 0), listRunning: mock(async () => []), stop: mock(async () => {}) }
  manager.piTaskServices = new Map(); manager.piGoalServices = new Map(); manager.piAskUserServices = new Map(); manager.piPlanModeServices = new Map()
  manager.piChildSessionServices = new Map(); manager.piWorktreeLeaseServices = new Map(); manager.piLspServices = new Map()
  manager.piLspRegistrations = new Map()
  manager.piLspAuthoritySignatures = new Map()
  manager.pendingPermissionRequests = new Map([['request', { workspaceId: 'w', sessionId: 's', type: 'bash' }], ['other', { workspaceId: 'other', sessionId: 's', type: 'bash' }]])
  manager.directPermissionResolvers = new Map()
  manager.taskOutputIndex = new Map(); manager.eventSink = () => {}
  manager.persistSession = mock(() => {})
  manager.schedulePiGoalContinuation = mock(() => {})
  return { manager, managed }
}

/** One supervisor record, in the shape `ProcessSupervisor.snapshot` returns. */
function supervisedProcess(status: 'running' | 'exited'): Record<string, unknown> {
  return {
    handle: 'p', semanticId: 'bash', startedAt: 1, deadlineAt: 2, status,
    exitCode: status === 'exited' ? 0 : null, signal: null,
    isolationProfile: 'workspace', nextCursor: 0,
  }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('until-timeout')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

describe('SessionManager Pi runtime snapshot contract', () => {
  test('classifies cold Pi and adjacent sessions from resolved provider truth', async () => {
    const coldPi = managerFor('pi')
    await expect(coldPi.manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })).resolves.toMatchObject({ provider: 'pi', available: false, unavailableReason: 'pi-runtime-not-started' })
    for (const provider of ['anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      const diagnostics = mock(() => { throw new Error('must-not-query') })
      const adjacent = managerFor(provider, { getHarnessDiagnostics: diagnostics })
      await expect(adjacent.manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })).resolves.toMatchObject({ provider, available: false, unavailableReason: 'provider-not-pi' })
      expect(diagnostics).not.toHaveBeenCalled()
    }
  })

  /**
   * R2: the worktree floor's own prompt type has to survive the WIRE, not just
   * the TypeScript union. `parsePiHarnessRuntimeSnapshotV1` validates
   * `pendingPermissions[].type` against a literal enum list and throws on
   * anything outside it, so a new prompt type added to the types but not to that
   * list would make the whole runtime snapshot unparseable for any session with
   * such a prompt pending — the renderer would lose the panel, not just the card.
   */
  //
  // P3.30 added `worktree_setup` — the setup-script consent card — which is
  // exactly such a type, so the list is a table rather than one case: the next
  // prompt type gets one line here instead of a fifth silent way to break the
  // panel.
  for (const type of ['worktree_approval', 'worktree_setup'] as const) {
    test(`a pending ${type} survives the runtime-snapshot wire validator`, async () => {
      const { manager } = managerFor('pi')
      manager.pendingPermissionRequests = new Map([
        ['request', { workspaceId: 'w', sessionId: 's', type }],
      ])
      const snapshot = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
      expect(snapshot.security.pendingPermissions).toEqual([
        { requestId: 'request', type, source: 'session-permission' },
      ])
      // The real boundary: the renderer parses what the host produced.
      expect(parsePiHarnessRuntimeSnapshotV1(JSON.parse(JSON.stringify(snapshot))).security.pendingPermissions)
        .toEqual([{ requestId: 'request', type, source: 'session-permission' }])
    })
  }

  /**
   * L5. A fork stops on a permission prompt filed under a `hidden: true` child
   * session, so the parent's snapshot said `[]` while the fork sat unanswerable
   * (measured live 2026-07-30: child `pendingPermissions` held the request for
   * ten minutes while the parent's row still read `running`).
   *
   * Both directions are asserted here because widening the filter is the
   * dangerous half: a registered child's prompt must appear WITH its agent id,
   * and a session that is not a registered child must still be invisible.
   */
  test("a registered child's pending prompt reaches the parent snapshot, and a stranger's does not", async () => {
    const { manager, managed } = managerFor('pi', { getHarnessDiagnostics: () => Object.freeze({ surfaceVersion: 2, generation: 'g', manifestHash: 'h', provenance: [], contextProfile: 'normal', responseEpoch: 1 }) })
    managed.childSessionState = {
      schemaVersion: 1, revision: 1, sealedOwnerTaskIds: [],
      children: [{ agentId: 'fork-1', agent: 'fork', status: 'running', background: true, childSessionKey: { workspaceId: 'w', sessionId: 'child' } }],
    }
    manager.pendingPermissionRequests = new Map([
      ['own', { workspaceId: 'w', sessionId: 's', type: 'bash' }],
      ['child-write', { workspaceId: 'w', sessionId: 'child', type: 'file_write' }],
      ['stranger', { workspaceId: 'w', sessionId: 'unrelated', type: 'file_write' }],
    ])
    const snapshot = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
    expect(snapshot.security.pendingPermissions).toEqual([
      { requestId: 'own', type: 'bash', source: 'session-permission' },
      { requestId: 'child-write', type: 'file_write', agentId: 'fork-1', source: 'session-permission' },
    ])
    expect(snapshot.security.risk).toBe('pending-approval')
    // The renderer parses what the host produced; `agentId` has to survive the
    // wire validator or the whole snapshot becomes unparseable for such a session.
    expect(parsePiHarnessRuntimeSnapshotV1(JSON.parse(JSON.stringify(snapshot))).security.pendingPermissions)
      .toEqual([
        { requestId: 'own', type: 'bash', source: 'session-permission' },
        { requestId: 'child-write', type: 'file_write', agentId: 'fork-1', source: 'session-permission' },
      ])
  })

  /**
   * Surfacing a prompt the user cannot answer would convert a silent hang into a
   * visible one, so the answer has to route to the child that asked — and only
   * for a child THIS session registered.
   */
  test("an answer given in the parent settles a registered child's prompt, and never a stranger's", () => {
    const respond = mock(() => {})
    const { manager, managed } = managerFor('pi', { respondToPermission: mock(() => {}) })
    managed.childSessionState = {
      schemaVersion: 1, revision: 1, sealedOwnerTaskIds: [],
      children: [{ agentId: 'fork-1', agent: 'fork', status: 'running', background: true, childSessionKey: { workspaceId: 'w', sessionId: 'child' } }],
    }
    const child: any = {
      id: 'child', workspace: { id: 'w', rootPath: '/tmp', name: 'w', createdAt: 1 }, ephemeral: true,
      hidden: true, agent: { respondToPermission: respond }, messages: [], permissionMode: 'default',
    }
    manager.sessions.set('w:child', child)
    manager.pendingPermissionRequests = new Map([
      ['child-write', { workspaceId: 'w', sessionId: 'child', type: 'file_write' }],
      ['stranger', { workspaceId: 'w', sessionId: 'unrelated', type: 'file_write' }],
    ])

    expect(manager.respondToPermission('s', 'child-write', true, false, undefined, 'w')).toBeTrue()
    expect(respond).toHaveBeenCalledTimes(1)
    expect(manager.pendingPermissionRequests.has('child-write')).toBeFalse()

    expect(manager.respondToPermission('s', 'stranger', true, false, undefined, 'w')).toBeFalse()
    expect(respond).toHaveBeenCalledTimes(1)
    expect(manager.pendingPermissionRequests.has('stranger')).toBeTrue()
  })

  test('projects detached bounded summaries without private payloads or paths', async () => {
    const { manager, managed } = managerFor('pi', { getHarnessDiagnostics: () => Object.freeze({ surfaceVersion: 2, generation: 'g'.repeat(300), manifestHash: 'h', provenance: Array.from({ length: 60 }, () => 'p'.repeat(300)), contextProfile: 'normal', responseEpoch: 1 }) })
    managed.capabilityRuntime = { projectTrustState: 'trusted', view: { generation: 'g', sources: [], skills: [], mcpServers: [], hooks: [], promptLayers: [], memory: [] } }
    manager.piLspServices.set('w:s', new Map([['native', { health: () => ({ status: 'failed', reason: 'r'.repeat(700) }) }]]))
    const snapshot = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
    expect(snapshot).toMatchObject({ provider: 'pi', available: true, mailbox: { messageCount: 1 }, worktrees: [{ branch: 'feature' }], security: { risk: 'pending-approval', projectTrustState: 'trusted' } })
    expect(snapshot.security.pendingPermissions.map((value: any) => value.requestId)).toEqual(['request'])
    expect(snapshot.manifest?.provenance).toHaveLength(50)
    expect(snapshot.manifest?.generation).toHaveLength(256)
    expect(snapshot.lspHealth).toEqual({ status: 'unavailable', reason: 'lsp-unavailable' })
    expect(JSON.stringify(snapshot)).not.toContain('mail-secret')
    expect(JSON.stringify(snapshot)).not.toContain('/secret/server/path')
  })

  test('projects the existing session receipt ring without bodies or paths', async () => {
    const { manager, managed } = managerFor('pi', { getHarnessDiagnostics: () => Object.freeze({ surfaceVersion: 2, generation: 'g', manifestHash: 'h', provenance: [], contextProfile: 'normal', responseEpoch: 1 }) })
    managed.piExecutionReceipts = { snapshot: () => Object.freeze([Object.freeze({
      sequence: 1, executionId: 'call-1', semanticId: 'mcp_dynamic', outcome: 'success',
      startedAt: 1, completedAt: 2, manifestGeneration: 'g', responseEpoch: 1,
      effect: 'externalMutation', isolationProfile: 'plugin-mcp', decisionId: 'decision-1',
      environmentProfile: 'explicit', environmentDigest: 'a'.repeat(64),
      mcpServer: 'gitlab', mcpTool: 'get_repo',
    })]) }
    const snapshot = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
    expect(snapshot.executionReceipts).toHaveLength(1)
    expect(snapshot.executionReceipts[0]).toMatchObject({ sequence: 1, semanticId: 'mcp_dynamic', mcpServer: 'gitlab', environmentProfile: 'explicit', environmentDigest: 'a'.repeat(64) })
    expect(JSON.stringify(snapshot.executionReceipts)).not.toContain('/tmp')
  })

  test('owns one persisted goal and exposes stale-safe runtime controls', async () => {
    const { manager, managed } = managerFor('pi')
    const created = await manager.controlPiHarnessRuntime({
      schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'goal_create',
      condition: 'Ship verified change', budgets: { turnLimit: 4 },
    })
    expect(JSON.parse(created.output)).toMatchObject({ goal: { status: 'active', source: 'user', creator: 'desktop', revision: 1 } })
    expect(managed.goalState).toMatchObject({ schemaVersion: 1, goal: { condition: 'Ship verified change' } })
    expect((await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })).goal).toMatchObject({
      condition: 'Ship verified change', budgets: { turnLimit: 4 },
    })

    const goalId = managed.goalState.goal.id
    expect(manager.piGoalReceiptReference(managed)).toEqual({ goalId, goalRevision: 1 })
    expect(managed.permissionMode).toBe('default')
    await expect(manager.controlPiHarnessRuntime({
      schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'goal_complete',
      goalId, revision: 2, reason: 'done', evidence: ['green gate'],
    })).rejects.toThrow('goal-stale-revision')
    managed.isProcessing = true
    managed.processingGeneration = 1
    manager.capturePiGoalTurnReference(managed)
    const completed = await manager.controlPiHarnessRuntime({
      schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'goal_complete',
      goalId, revision: 1, reason: 'done', evidence: ['green gate'],
    })
    expect(JSON.parse(completed.output)).toMatchObject({ goal: { status: 'complete', revision: 2 } })
    await manager.processEvent(managed, { type: 'complete', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.1 } })
    expect(managed.goalState).toMatchObject({ goal: { status: 'complete', revision: 3, accounting: { turns: 1, tokens: 12, costUsd: 0.1 } } })
    expect(manager.piGoalReceiptReference(managed)).toBeUndefined()
    expect(managed.permissionMode).toBe('default')
  })

  /**
   * R47 (f175) — goal.md:129: "**Yes**: Claude Code clears the goal and
   * records an achieved entry in the transcript." Runs the REAL
   * schedulePiGoalContinuation (managerFor mocks it; the own property is
   * deleted to restore the prototype method): an evaluator yes must push and
   * persist the role:'info' achieved entry, and dispatch NO continuation turn
   * — stopped by the EXISTING status guard + canContinue, with no second guard
   * in the manager.
   */
  test('an evaluator yes records the achieved transcript entry and stops continuation dispatch', async () => {
    const { manager, managed } = managerFor('pi', {
      runMiniCompletion: mock(async () => JSON.stringify({ complete: true, reason: 'condition proven', evidence: ['gate green'] })),
    })
    manager.pendingPermissionRequests = new Map()
    manager.projectMutationSessions = new Set()
    manager.lastTimestamp = 0
    manager.sendMessage = mock(async () => {})
    const persistedInfoCounts: number[] = []
    manager.persistSession = mock(() => { persistedInfoCounts.push(managed.messages.filter((m: any) => m.role === 'info').length) })
    managed.messageQueue = []
    delete manager.schedulePiGoalContinuation
    await manager.getOrCreatePiGoalService(managed).execute({
      action: 'create', condition: 'Ship verified change', source: 'user', creator: 'desktop',
    })

    manager.schedulePiGoalContinuation(managed)
    await until(() => managed.goalState?.goal?.status === 'complete' && managed.piGoalContinuationRunning === false)
    // Let the post-finally dispatch block run before asserting its absence.
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(managed.goalState.goal).toMatchObject({ status: 'complete', lastEvaluation: { source: 'evaluator', verdict: 'completed' } })
    const achieved = managed.messages.filter((m: any) => m.role === 'info' && m.content.includes('Goal achieved'))
    expect(achieved).toHaveLength(1)
    expect(achieved[0].infoLevel).toBe('success')
    expect(achieved[0].content).toContain('Ship verified change')
    expect(achieved[0].content).toContain('gate green')
    // The entry was pushed BEFORE its persist: the last persistSession call saw it.
    expect(persistedInfoCounts.at(-1)).toBe(1)
    // No second continuation guard exists — the existing status guard +
    // canContinue stop the dispatch.
    expect(manager.sendMessage).not.toHaveBeenCalled()
  })

  /**
   * Positive control for the absence above: the SAME path with a not-complete
   * verdict keeps dispatching the continuation turn and records no achieved
   * entry — so the no-dispatch assertion measures the guards, not a broken rig.
   */
  test('a not-complete evaluation keeps dispatching the continuation turn', async () => {
    const { manager, managed } = managerFor('pi', {
      runMiniCompletion: mock(async () => JSON.stringify({ complete: false, reason: 'tests still failing', evidence: [] })),
    })
    manager.pendingPermissionRequests = new Map()
    manager.projectMutationSessions = new Set()
    manager.lastTimestamp = 0
    manager.sendMessage = mock(async () => {})
    managed.messageQueue = []
    delete manager.schedulePiGoalContinuation
    await manager.getOrCreatePiGoalService(managed).execute({
      action: 'create', condition: 'Ship verified change', source: 'user', creator: 'desktop',
    })

    manager.schedulePiGoalContinuation(managed)
    await until(() => manager.sendMessage.mock.calls.length === 1)

    expect(manager.sendMessage.mock.calls[0][1]).toContain('Continue active goal')
    expect(managed.goalState.goal).toMatchObject({ status: 'active', lastEvaluation: { source: 'evaluator', verdict: 'not_complete' } })
    expect(managed.messages.filter((m: any) => m.role === 'info' && m.content.includes('Goal achieved'))).toHaveLength(0)
  })

  /**
   * P2.2 — the continuation gate on all three coding runtimes.
   *
   * The two rows above own the Pi case in detail. These own the CROSS-RUNTIME
   * claim the task exists for, in both directions per runtime: a turn that ends
   * with the condition unmet dispatches the next continuation, and one that
   * ends with it met dispatches nothing.
   *
   * `evaluateAtSettlement` runs the evaluator through `agent.runMiniCompletion`,
   * which is `abstract` on `BaseAgent` and implemented by all three backends —
   * so a single fake agent is the honest stand-in for each of them here, and
   * the thing that actually differs between the three (whether the host binds
   * the port and lets the gate through) is what these rows measure.
   */
  describe('the goal continuation runs on every scheduled runtime', () => {
    const runtimes: Array<'pi' | 'anthropic' | 'codex-runtime'> = ['pi', 'anthropic', 'codex-runtime']

    const withActiveGoal = async (
      provider: (typeof runtimes)[number],
      verdict: { complete: boolean; reason: string; evidence: string[] },
    ) => {
      const { manager, managed } = managerFor(provider, {
        runMiniCompletion: mock(async () => JSON.stringify(verdict)),
      })
      // The fixture seeds one pending permission for this session; a card the
      // user has not answered is a REASON not to dispatch, so it is cleared for
      // the dispatch rows and re-asserted as its own row below.
      manager.pendingPermissionRequests = new Map()
      manager.projectMutationSessions = new Set()
      manager.lastTimestamp = 0
      manager.sendMessage = mock(async () => {})
      managed.messageQueue = []
      delete manager.schedulePiGoalContinuation
      await manager.getOrCreatePiGoalService(managed).execute({
        action: 'create', condition: 'Ship verified change', source: 'user', creator: 'desktop',
      })
      return { manager, managed }
    }

    test.each(runtimes)('%s dispatches a continuation when the condition is not met', async provider => {
      const { manager, managed } = await withActiveGoal(provider, {
        complete: false, reason: 'tests still failing', evidence: [],
      })

      manager.schedulePiGoalContinuation(managed)
      await until(() => manager.sendMessage.mock.calls.length === 1)

      expect(manager.sendMessage.mock.calls[0][1]).toContain('Continue active goal')
      // The hidden prompt is the goal's own continuation text, not the display
      // line — the last positional argument of `sendMessage`.
      expect(manager.sendMessage.mock.calls[0].at(-1)).toContain('Continue the active Nessy goal')
      expect(managed.goalState.goal).toMatchObject({ status: 'active', lastEvaluation: { verdict: 'not_complete' } })
    })

    test.each(runtimes)('%s dispatches nothing when the condition is met', async provider => {
      const { manager, managed } = await withActiveGoal(provider, {
        complete: true, reason: 'condition proven', evidence: ['gate green'],
      })

      manager.schedulePiGoalContinuation(managed)
      await until(() => managed.goalState?.goal?.status === 'complete' && managed.piGoalContinuationRunning === false)
      // Let the post-finally dispatch block run before asserting its absence.
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(managed.goalState.goal).toMatchObject({ status: 'complete', lastEvaluation: { verdict: 'completed' } })
      expect(manager.sendMessage).not.toHaveBeenCalled()
    })

    /**
     * The detector behind the two rows above, asserted directly.
     *
     * The non-Pi branch of `getPiHarnessRuntimeSnapshot` used to report
     * `settled: true` from all-zero literals, which would have made "settled"
     * meaningless on exactly the two runtimes this task adds — an unattended
     * turn dispatched over a permission card the user is still looking at. The
     * runtime-neutral counts are what stop it, and this is the row that proves
     * they are read rather than merely written.
     */
    test.each(runtimes)('%s does not dispatch while a permission card is pending', async provider => {
      const { manager, managed } = await withActiveGoal(provider, {
        complete: false, reason: 'tests still failing', evidence: [],
      })
      manager.pendingPermissionRequests = new Map([['request', { workspaceId: 'w', sessionId: 's', type: 'bash' }]])

      manager.schedulePiGoalContinuation(managed)
      await until(() => managed.piGoalContinuationRunning === false)
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(manager.sendMessage).not.toHaveBeenCalled()
      expect(managed.goalState.goal.status).toBe('active')
    })

    /**
     * P2.17 — the same detector, one domain over, and the one P2.2 left open.
     *
     * `SessionMonitorService` is constructed with `processSupervisorPort`, a
     * port over the SAME `piProcessSupervisor` Pi's branch reads, and
     * `Monitor`/`ProcessStop` are projected onto claude and codex since T3/T5
     * (T6 measured a real OS process on codex) — while the non-Pi settlement
     * kept `activeProcesses: 0`. So a claude or codex session with a running
     * supervised process dispatched an unattended continuation turn where a Pi
     * one would not: "settled" meant two different things per runtime.
     *
     * The settlement is asserted directly beside the dispatch, because the
     * dispatch alone would also stay silent for a gate that never armed.
     */
    test.each(runtimes)('%s does not dispatch while a supervised process is running', async provider => {
      const { manager, managed } = await withActiveGoal(provider, {
        complete: false, reason: 'tests still failing', evidence: [],
      })
      // Pi projects the record list and derives the count from it; the other
      // two ask the running INDEX (P2.22, then P2.523). All three halves are
      // stubbed so the row measures the gate rather than which reader the branch
      // happens to use — which is what let this row survive P2.523 moving the
      // non-Pi reader from `countRunning` to `listRunning` unchanged in meaning.
      manager.piProcessSupervisor.snapshot = async () => [supervisedProcess('running')]
      manager.piProcessSupervisor.countRunning = mock(async () => 1)
      manager.piProcessSupervisor.listRunning = mock(async () => [supervisedProcess('running')])

      manager.schedulePiGoalContinuation(managed)
      await until(() => managed.piGoalContinuationRunning === false)
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(manager.sendMessage).not.toHaveBeenCalled()
      expect(managed.goalState.goal.status).toBe('active')
      const running = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
      expect(running.settlement).toEqual({ schemaVersion: 1, settled: false, pending: ['process'] })
      // P2.523 — THE row that makes the projection non-vacuous, and it has to sit
      // where the reader returns something. P2.499 left `processes` a frozen `[]`
      // beside a settlement figure counting the same session's running processes;
      // both could not be true. Asserting emptiness on a fixture that returns
      // nothing cannot catch that (measured: a mutant restoring the frozen `[]`
      // SURVIVED such a row), so the list is asserted HERE, against the one
      // fixture with a record in it, in the projection shape
      // `ProcessSupervisor.snapshot` uses for the Pi branch.
      expect(running.processes).toEqual([supervisedProcess('running')])
    })

    /**
     * P2.22, and P2.17's review minor with it.
     *
     * The count the non-Pi settlement reads used to be `snapshot()`, i.e.
     * `ProcessStore.list()`: a `readdir` of the single global `.pi-processes`
     * plus a JSON parse of EVERY record before the owner filter ran — measured
     * at 897 records / 175-204 ms on the owner's profile, twice per continuation
     * attempt. This row is the detector for the whole-store scan coming back:
     * the projection reader is armed to THROW, so a settlement that reaches for
     * it fails the snapshot outright instead of merely getting slower.
     *
     * The second assertion is the scoping pin. The rows above replace the port
     * wholesale with an arg-ignoring stub, so a regression that asked for the
     * WRONG session's count — the workspace key, a child's key, a swapped pair —
     * passed them all. `toHaveBeenCalledWith` is what makes that redden, and
     * ownership scoping is exactly what this read exists to preserve.
     */
    test.each(['anthropic', 'codex-runtime'] as const)('%s counts running processes by session key without scanning the store', async provider => {
      const { manager } = await withActiveGoal(provider, {
        complete: false, reason: 'tests still failing', evidence: [],
      })
      manager.piProcessSupervisor.snapshot = mock(async () => { throw new Error('whole-store-scan') })
      manager.piProcessSupervisor.countRunning = mock(async () => 0)
      manager.piProcessSupervisor.listRunning = mock(async () => [])

      const snapshot = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })

      expect(snapshot.settlement).toEqual({ schemaVersion: 1, settled: true, pending: [] })
      // P2.523 moved this branch's reader from `countRunning` to `listRunning`,
      // and BOTH of this row's claims are unchanged in substance because the two
      // are one walk: `ProcessStore.countRunning` is `.length` over
      // `listRunning`, and each supervisor method is the same one-line delegate.
      // The scoping pin is the half that matters most — the rows around this one
      // replace the port with an arg-ignoring stub, so a regression that asked
      // for the WRONG session's processes passes them all.
      expect(manager.piProcessSupervisor.listRunning).toHaveBeenCalledWith({ workspaceId: 'w', sessionId: 's' })
      expect(manager.piProcessSupervisor.snapshot).not.toHaveBeenCalled()
      // And the list is rendered from that same read rather than left frozen
      // empty beside it, which is the contradiction P2.523 closed.
      expect(snapshot.processes).toEqual([])
    })

    /**
     * The other half of P2.22's contract, and the half a cheaper read is most
     * tempting to break: a count that CANNOT BE READ must not settle the session.
     *
     * The old path threw — `snapshot()` had no catch here and the continuation's
     * own catch turned the throw into a skipped dispatch, which is the
     * fail-closed answer. A `.catch(() => 0)` anywhere between the store's
     * `readdir` and this line converts an unreadable index into `settled: true`
     * and dispatches an unattended turn over a process the host still believes is
     * alive. This row is that catch's detector: the settlement must propagate,
     * and the continuation must skip rather than dispatch.
     *
     * P2.523 — armed on BOTH index readers, deliberately. The branch reads
     * `listRunning` now, but breaking only the reader of the day would let a
     * later swap back to `countRunning` restore the fail-OPEN hole with this row
     * still green. The claim is about the INDEX being unreadable, not about
     * which method asked.
     */
    test.each(['anthropic', 'codex-runtime'] as const)('%s skips the continuation when the running count cannot be read', async provider => {
      const { manager, managed } = await withActiveGoal(provider, {
        complete: false, reason: 'tests still failing', evidence: [],
      })
      const unreadableIndex = async () => {
        // The shape `retention-sweep.ts` measured on this very directory.
        const error: NodeJS.ErrnoException = new Error('EMFILE: too many open files, scandir .pi-processes/.running')
        error.code = 'EMFILE'
        throw error
      }
      manager.piProcessSupervisor.countRunning = mock(unreadableIndex)
      manager.piProcessSupervisor.listRunning = mock(unreadableIndex)

      manager.schedulePiGoalContinuation(managed)
      await until(() => managed.piGoalContinuationRunning === false)
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(manager.sendMessage).not.toHaveBeenCalled()
      expect(managed.goalState.goal.status).toBe('active')
      // Asserted beside the dispatch, because silence alone is also what a gate
      // that never armed looks like.
      await expect(manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })).rejects.toThrow('EMFILE')
    })

    /**
     * The positive control for the three rows above: the SAME session, the SAME
     * supervisor, one record whose status is terminal. Without it those rows
     * would pass against a count that never comes back down — the exact shape
     * L7's background-shell latch had.
     *
     * One runtime is enough because both non-Pi runtimes take the identical
     * branch, and Pi's own recovery is already pinned by the live-settlement row.
     */
    test('anthropic dispatches again once the supervised process has exited', async () => {
      const { manager, managed } = await withActiveGoal('anthropic', {
        complete: false, reason: 'tests still failing', evidence: [],
      })
      manager.piProcessSupervisor.snapshot = async () => [supervisedProcess('exited')]
      manager.piProcessSupervisor.countRunning = mock(async () => 0)
      // The running INDEX holds no marker for a terminal record, which is why
      // the empty list here is the honest fixture rather than a convenience:
      // `ProcessStore.listRunning` retires the marker of any record that is no
      // longer `running` on the same walk that counts.
      manager.piProcessSupervisor.listRunning = mock(async () => [])

      manager.schedulePiGoalContinuation(managed)
      await until(() => manager.sendMessage.mock.calls.length === 1)

      expect(manager.sendMessage.mock.calls[0][1]).toContain('Continue active goal')
      expect((await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })).settlement)
        .toEqual({ schemaVersion: 1, settled: true, pending: [] })
    })

    // The gate's remaining job: a runtime with no host tool loop has nothing a
    // continuation turn could wake, so it must not arm at all. This is the
    // negative control for every per-runtime row above (P2.17 added three more
    // to the six this line was written for) — without it they would pass
    // against a gate that was deleted rather than widened.
    test('nestor-cloud-agent does not arm the continuation at all', async () => {
      const { manager, managed } = await withActiveGoal('pi' as never, {
        complete: false, reason: 'tests still failing', evidence: [],
      })
      manager.resolveManagedProvider = () => 'nestor-cloud-agent'

      manager.schedulePiGoalContinuation(managed)
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(managed.piGoalContinuationRunning).toBeUndefined()
      expect(manager.sendMessage).not.toHaveBeenCalled()
    })
  })

  test('projects safe checkpoint adapter and digest metadata without full paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-runtime-checkpoint-'))
    try {
      const sessionPath = join(root, 'session')
      const target = join(root, 'private', 'target.txt')
      await mkdir(join(root, 'private'), { recursive: true })
      await writeFile(target, 'before')
      const [checkpoint] = await createFileCheckpoint({
        sessionPath, adapter: 'file', toolName: 'format', toolCallId: 'format-call', input: { path: target },
      })
      await writeFile(target, 'after')
      await finalizeFileCheckpoint({ sessionPath, checkpointId: checkpoint!.id, succeeded: true })
      const { manager, managed } = managerFor('pi', { getHarnessDiagnostics: () => Object.freeze({ surfaceVersion: 2, generation: 'g', manifestHash: 'h', provenance: [], contextProfile: 'normal', responseEpoch: 1 }) })
      managed.ephemeral = false
      manager.sessionStore = { getSessionPath: () => sessionPath }

      const snapshot = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
      expect(snapshot.checkpoints[0]).toMatchObject({
        adapter: 'file', toolName: 'format', fileName: 'target.txt', outcome: 'applied',
        changed: true, conflict: false, currentExists: true,
      })
      expect(snapshot.checkpoints[0]?.preimageDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(snapshot.checkpoints[0]?.postimageDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(snapshot.checkpoints)).not.toContain(join(root, 'private'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('projects one live settlement contract and clears background evaluators on terminal events', async () => {
    const { manager, managed } = managerFor('pi', { getHarnessDiagnostics: () => Object.freeze({ surfaceVersion: 2, generation: 'g', manifestHash: 'h', provenance: [], contextProfile: 'normal', responseEpoch: 1 }) })
    managed.isProcessing = true
    managed.pendingAskUser = { requestId: 'ask', question: 'q', options: [], allowFreeText: true }
    managed.childSessionState.children.push({ agentId: 'child', agent: 'worker', status: 'running', background: true })
    manager.piProcessSupervisor.snapshot = async () => [{ handle: 'p', semanticId: 'bash', startedAt: 1, deadlineAt: 2, status: 'running', exitCode: null, signal: null, isolationProfile: 'workspace', nextCursor: 0 }]
    await manager.processEvent(managed, { type: 'task_backgrounded', toolUseId: 'call', taskId: 'task-workflow', kind: 'workflow' })
    const active = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
    expect(active.settlement).toEqual({
      schemaVersion: 1,
      settled: false,
      pending: ['foreground_model_turn', 'workflow_evaluator', 'child', 'process', 'permission', 'ask_user'],
    })

    await manager.processEvent(managed, { type: 'task_completed', taskId: 'task-workflow', status: 'completed' })
    managed.isProcessing = false
    managed.pendingAskUser = undefined
    managed.childSessionState.children = []
    manager.pendingPermissionRequests.clear()
    manager.piProcessSupervisor.snapshot = async () => []
    const settled = await manager.getPiHarnessRuntimeSnapshot({ workspaceId: 'w', sessionId: 's' })
    expect(settled.settlement).toEqual({ schemaVersion: 1, settled: true, pending: [] })
  })

  test('rejects adjacent controls and emits no Pi invalidations for adjacent events', async () => {
    const { manager } = managerFor('anthropic', {})
    const events: unknown[] = []
    manager.eventSink = (...args: unknown[]) => events.push(args)
    // P6.116 (`027d678dc`) made the gate per ACTION: `stop_process` and
    // `read_process` are SUPERVISOR-scoped and a claude session may now reach
    // them, so this case was asserting a refusal the product deliberately
    // dropped — and the commit that dropped it updated
    // `SessionManager.process-supervisor.test.ts` and not this suite. The
    // subject here is a Pi-harness CONSTRUCT, which is still refused, so the
    // case tests what its own name says. (Repaired 2026-09-08, W9-n.)
    await expect(manager.controlPiHarnessRuntime({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'stop_child', agentId: 'child' })).rejects.toThrow('pi-runtime-provider-required')
    // And the widened pair really is widened, which is what stops this case
    // from silently going back to testing the old gate.
    await expect(manager.controlPiHarnessRuntime({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'stop_process', handle: 'process' })).resolves.toBeDefined()
    // That call legitimately invalidates the `processes` domain. The assertion
    // below is about an adjacent EVENT emitting none, so it starts clean.
    events.length = 0
    manager.sendEvent({ type: 'task_created', sessionId: 's', taskId: 'task' }, 'w')
    expect(JSON.stringify(events)).not.toContain('pi_harness_runtime_invalidated')
  })

  /**
   * W1 — AGT-2's stale fork row. `useAgentPanel` reloads ONLY on a `children`
   * domain change, and stop_child/steer_child emitted `['runtime']`, so a
   * stopped child's row kept `data-status=running` until some unrelated
   * children invalidation arrived (measured live 2026-07-31: "rows still
   * present after 20s: 1", race-dependent). The child-affecting control
   * actions must carry the domain themselves.
   */
  test('stop_child and steer_child invalidations carry the children domain', async () => {
    const { manager } = managerFor('pi', {})
    const events: any[] = []
    manager.eventSink = (...args: unknown[]) => events.push(args)
    const service = { stop: mock(async () => {}), steer: mock(async () => {}) }
    manager.piChildSessionServices.set('w:s', service)
    await manager.controlPiHarnessRuntime({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'stop_child', agentId: 'child-1' })
    await manager.controlPiHarnessRuntime({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'steer_child', agentId: 'child-1', message: 'steer note' })
    expect(service.stop).toHaveBeenCalledWith('child-1')
    expect(service.steer).toHaveBeenCalledWith('child-1', 'steer note')
    const invalidations = events.map((value: any) => value[2]).filter((value: any) => value.type === 'pi_harness_runtime_invalidated')
    expect(invalidations.map((value: any) => value.changedDomains)).toEqual([
      ['runtime', 'children'],
      ['runtime', 'children'],
    ])
    // stop_process keeps its narrower processes-only domain — the fix is
    // per-action, not a blanket widening of every control invalidation.
    await manager.controlPiHarnessRuntime({ schemaVersion: 1, session: { workspaceId: 'w', sessionId: 's' }, action: 'stop_process', handle: 'proc-1' })
    const last = events.map((value: any) => value[2]).filter((value: any) => value.type === 'pi_harness_runtime_invalidated').at(-1)
    expect(last.changedDomains).toEqual(['processes'])
  })

  test('emits bounded Pi invalidations for runtime owner changes', () => {
    const { manager } = managerFor('pi', {})
    const events: any[] = []
    manager.eventSink = (...args: unknown[]) => events.push(args)
    manager.sendEvent({ type: 'task_created', sessionId: 's', taskId: 'task' }, 'w')
    manager.sendEvent({ type: 'usage_update', sessionId: 's' }, 'w')
    manager.sendEvent({ type: 'tool_result', sessionId: 's', toolUseId: 'tool', toolName: 'write', result: '' }, 'w')
    for (const domain of ['children', 'worktrees', 'tools'] as const) manager.emitPiHarnessInvalidation(manager.getManaged('s', 'w'), [domain])
    const invalidations = events.map(value => value[2]).filter(value => value.type === 'pi_harness_runtime_invalidated')
    expect(invalidations.map(value => value.changedDomains[0])).toEqual(['tasks', 'context', 'recovery', 'children', 'worktrees', 'tools'])
  })

  test('settles permission metadata by full SessionKey and invalidates only actual removals', () => {
    const respond = mock(() => {})
    const { manager } = managerFor('pi', { respondToPermission: respond })
    const events: any[] = []
    manager.eventSink = (...args: unknown[]) => events.push(args)
    manager.pendingPermissionRequests = new Map([
      ['local', { workspaceId: 'w', sessionId: 's', type: 'ask_user' }],
      ['other', { workspaceId: 'other', sessionId: 's', type: 'ask_user' }],
    ])
    manager.clearSettledAskUserPermission('s', 'w', 'local')
    expect([...manager.pendingPermissionRequests.keys()]).toEqual(['other'])
    expect(manager.respondToPermission('s', 'other', false, false, undefined, 'w')).toBeFalse()
    expect(manager.pendingPermissionRequests.has('other')).toBeTrue()
    expect(respond).not.toHaveBeenCalled()
    manager.pendingPermissionRequests.set('ordinary', { workspaceId: 'w', sessionId: 's', type: 'bash' })
    expect(manager.respondToPermission('s', 'ordinary', false, false, undefined, 'w')).toBeTrue()
    expect(respond).toHaveBeenCalledTimes(1)
    const invalidations = events.map(value => value[2]).filter(value => value.type === 'pi_harness_runtime_invalidated')
    expect(invalidations.map(value => value.changedDomains)).toEqual([['interactions', 'security'], ['interactions', 'security']])
    manager.clearPendingPermissionRequestsForSession('s', 'w')
    expect([...manager.pendingPermissionRequests.keys()]).toEqual(['other'])
  })
})
