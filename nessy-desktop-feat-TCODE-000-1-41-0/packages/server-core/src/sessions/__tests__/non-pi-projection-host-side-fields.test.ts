/**
 * P2.499 + P2.500 — the fields that were still constants behind
 * `getPiHarnessRuntimeSnapshot`'s `provider !== 'pi'` early return, each moved
 * for the reason P2.17 and P2.488 moved theirs: the thing stopped being (or
 * never was) a Pi construct.
 *
 * The shape of every table here is deliberate and follows
 * `goal-reaches-every-runtime.test.ts`: the Pi row is present as a POSITIVE
 * CONTROL in each one, so a mutant that re-breaks the early return fails the
 * non-Pi rows while Pi stays green. A suite without that control would pass just
 * as happily against a projection that was broken on every runtime.
 *
 * What is NOT here, and why, because an absent test is otherwise indistinguishable
 * from an overlooked one:
 *
 *  - `compaction`'s `isCompacting`/`autoCompactionEnabled`/
 *    `remainingBeforeAutoCompact`. All three read `managed.contextUsage`, and no
 *    snapshot a non-Pi runtime writes carries them. F1.460 (13) corrected the
 *    reason this line first gave ("a snapshot is produced by `PiAgent` alone"):
 *    since F1.240 claude writes one on `/context` and at a compaction boundary —
 *    a count, a window and `stale`, no compaction state — so `context`'s TOKEN
 *    fields moved (the table below), and these three still have no producer.
 *    `tokenUsage` stays out: a different source with a different meaning.
 *  - `processes`. It is still a frozen `[]`, and it still disagrees with the
 *    settlement beside it. Filling it needs `piProcessSupervisor.snapshot`, which
 *    is the `ProcessStore.list` read P2.22 removed from this exact path.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { StoredSession } from '@nessy-agent/shared/sessions'
import { createFileCheckpoint } from '@nessy-agent/shared/sessions'
import { saveSession, setPendingPlanExecution } from '@nessy-agent/shared/sessions/storage'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces/paths'
import { parsePiHarnessRuntimeSnapshotV1 } from '@nessy-agent/shared/protocol'
import { createTestSessionManager } from './test-session-manager.ts'

type Provider = 'pi' | 'anthropic' | 'codex-runtime' | 'nestor-cloud-agent'

/**
 * Every runtime this projection can be asked about, Pi first so the control row
 * reads first in the output too.
 */
const ALL_RUNTIMES: Provider[] = ['pi', 'anthropic', 'codex-runtime', 'nestor-cloud-agent']
const NON_PI_RUNTIMES: Provider[] = ['anthropic', 'codex-runtime', 'nestor-cloud-agent']

/**
 * A real manager carrying exactly the collaborators
 * `getPiHarnessRuntimeSnapshot` touches. Same harness as
 * `goal-reaches-every-runtime.test.ts`; the `sessionStore` stub is the one
 * addition, because the checkpoint arm reads a real session path.
 */
function managerFor(provider: Provider, options: { sessionPath?: string; workspaceId?: string } = {}) {
  const workspaceId = options.workspaceId ?? 'w'
  const manager = createTestSessionManager() as any
  const managed: any = {
    id: 's', workspace: { id: workspaceId, rootPath: '/tmp', name: 'w', createdAt: 1 }, ephemeral: true,
    agent: null, messages: [], processingGeneration: 0, permissionMode: 'default',
    isProcessing: false, messageQueue: [], queuePaused: false,
    backgroundTaskOutputs: new Map(), piBackgroundTaskKinds: new Map(),
  }
  manager.sessions = new Map([[`${workspaceId}:s`, managed]])
  manager.resolveManagedProvider = () => provider
  // `listRunning` joined the production call in `07e047eaa` (the empty process
  // list beside a figure counting the same processes) and this hand-built stub
  // was not extended, so `getPiHarnessRuntimeSnapshot` threw
  // `listRunning is not a function` and took 25 cases with it — a stale double,
  // not a product defect: `ProcessSupervisor.listRunning` exists and delegates
  // to the store exactly as `countRunning` does.
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
  manager.sessionStore = { getSessionPath: () => options.sessionPath ?? '/nonexistent-session-path' }
  // The Pi branch reads these two before it reaches the fields under test; the
  // non-Pi branch never gets there. Stubbed so the Pi CONTROL row can run at all.
  manager.projectHandleService = { resolveHandle: async () => null }
  manager.piLspPort = () => undefined
  return { manager, managed }
}

const snapshotOf = (manager: any, workspaceId = 'w') =>
  manager.getPiHarnessRuntimeSnapshot({ workspaceId, sessionId: 's' })

describe('P2.499 the shared MCP pool health crosses the early return', () => {
  /**
   * `managed.mcpPool` and `managed.mcpLeaserId` are assigned in
   * `getOrCreateAgentUnchecked` with no provider gate, over a pool whose own
   * lease site says "all backends use it". The projection omitted the field
   * entirely off Pi.
   */
  test.each(ALL_RUNTIMES)('a leased pool reports its own health on %s', async provider => {
    const { manager, managed } = managerFor(provider)
    const health = mock((leaserId?: string) => ({
      status: 'degraded' as const,
      connected: leaserId === 'leaser-1' ? ['alpha'] : ['not-this-leasers'],
      failed: ['beta'],
    }))
    managed.mcpPool = { health }
    managed.mcpLeaserId = 'leaser-1'

    const snapshot = await snapshotOf(manager)

    // The assertion that dies when the non-Pi branch drops the field again.
    expect(snapshot.mcpHealth).toBeDefined()
    expect(snapshot.mcpHealth).toMatchObject({ status: 'degraded', connected: ['alpha'], failed: ['beta'] })
    // Scoped to THIS session's leaser, not the workspace union — the property
    // that makes a shared pool safe to report per session.
    expect(health).toHaveBeenCalledWith('leaser-1')
    // The wire, not the TypeScript union: the renderer parses what the host produced.
    expect(parsePiHarnessRuntimeSnapshotV1(JSON.parse(JSON.stringify(snapshot))).mcpHealth)
      .toMatchObject({ status: 'degraded', connected: ['alpha'] })
  })

  /**
   * The negative that keeps the field honest rather than merely present: a
   * session that never constructed an agent has NO pool view, and the optional
   * field stays absent instead of reporting an empty one. Absent and "connected
   * to nothing" are different answers.
   */
  test.each(NON_PI_RUNTIMES)('a session with no pool omits mcpHealth on %s', async provider => {
    const { manager } = managerFor(provider)
    const snapshot = await snapshotOf(manager)
    expect(snapshot.mcpHealth).toBeUndefined()
    expect('mcpHealth' in snapshot).toBe(false)
  })
})

describe('P2.499 the capability counts cross the early return', () => {
  const view = {
    generation: 'gen-7',
    sources: [1, 2, 3],
    skills: [1, 2],
    mcpServers: [1, 2, 3, 4],
    hooks: [1],
    promptLayers: [1, 2, 3, 4, 5],
    memory: [1, 2, 3, 4, 5, 6],
  }

  /**
   * `createCapabilityTurn` is provider-blind, so a claude or codex turn builds a
   * real view. The projection reported six zeros for it.
   */
  test.each(ALL_RUNTIMES)('an active capability view is counted on %s', async provider => {
    const { manager, managed } = managerFor(provider)
    managed.capabilityRuntime = { view }

    const snapshot = await snapshotOf(manager)

    expect(snapshot.context).toMatchObject({
      capabilityGeneration: 'gen-7',
      sourceCount: 3, skillCount: 2, mcpServerCount: 4,
      hookCount: 1, promptLayerCount: 5, memoryCount: 6,
    })
  })

  /**
   * The per-turn lifetime is the same on both branches — `withCapabilityRuntime`
   * clears `capabilityRuntime` in its `finally` on every runtime — so a resting
   * session reads zeros HERE and on Pi. One meaning, which is the point.
   */
  test.each(ALL_RUNTIMES)('a session between turns reports zeros on %s', async provider => {
    const { manager } = managerFor(provider)
    const snapshot = await snapshotOf(manager)
    expect(snapshot.context).toMatchObject({
      sourceCount: 0, skillCount: 0, mcpServerCount: 0,
      hookCount: 0, promptLayerCount: 0, memoryCount: 0,
    })
    expect(snapshot.context.capabilityGeneration).toBeUndefined()
  })
})

describe('P2.499 compaction.pendingPlan is host-side on every runtime', () => {
  const workspaces: string[] = []

  afterEach(() => {
    for (const workspaceId of workspaces.splice(0)) {
      const dir = join(SESSIONS_DIR, workspaceId)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  async function workspaceWithPendingPlan(): Promise<string> {
    const workspaceId = `p2499-pending-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`
    workspaces.push(workspaceId)
    await saveSession({
      id: 's', workspaceId, createdAt: 1000, lastUsedAt: 1000, messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as StoredSession)
    await setPendingPlanExecution(workspaceId, 's', '/tmp/p2499-plan.md')
    return workspaceId
  }

  /**
   * `onPlanSubmitted` is wired ungated and, with no Pi plan-mode service to set
   * `piPlanProjectionId`, falls through to `projectAdjacentPlanSubmission` — a
   * real `role: 'plan'` message on claude and codex. "Accept & Compact" then
   * reaches `setPendingPlanExecution`, which has no provider gate either. So the
   * state is reachable off Pi and the projection hard-coded `false` over it.
   */
  test.each(ALL_RUNTIMES)('a stored pending plan execution is reported on %s', async provider => {
    const workspaceId = await workspaceWithPendingPlan()
    const { manager, managed } = managerFor(provider, { workspaceId })
    managed.ephemeral = false

    const snapshot = await snapshotOf(manager, workspaceId)

    // The assertion that dies against the `pendingPlan: false` literal.
    expect(snapshot.compaction.pendingPlan).toBe(true)
  })

  /**
   * The ephemeral arm, mirrored from the Pi branch: an in-memory session is not
   * asked about disk at all.
   */
  test.each(NON_PI_RUNTIMES)('an ephemeral session reports no pending plan on %s', async provider => {
    const workspaceId = await workspaceWithPendingPlan()
    const { manager, managed } = managerFor(provider, { workspaceId })
    managed.ephemeral = true

    const snapshot = await snapshotOf(manager, workspaceId)
    expect(snapshot.compaction.pendingPlan).toBe(false)
  })

  /**
   * The three compaction fields that did NOT move, pinned so a later lane sees
   * the decision rather than an oversight: they read `managed.contextUsage`,
   * and no snapshot a non-Pi runtime writes carries them (F1.460 (13)).
   */
  test.each(NON_PI_RUNTIMES)('the contextUsage-backed compaction fields stay absent on %s', async provider => {
    const { manager } = managerFor(provider)
    const snapshot = await snapshotOf(manager)
    expect(snapshot.compaction.isCompacting).toBe(false)
    expect(snapshot.compaction.autoCompactionEnabled).toBeUndefined()
    expect(snapshot.compaction.remainingBeforeAutoCompact).toBeUndefined()
  })
})

/**
 * F1.460 (13) — P2.499 RE-DECIDED against the new producer. The non-Pi branch
 * left `context`'s token fields out because "a snapshot is produced by
 * `PiAgent` alone"; since F1.240 claude writes one (`/context`, a compaction
 * boundary), so a claude session holding a snapshot reported none of it here
 * while the Pi branch spreads the same four fields from the same
 * `managed.contextUsage`. Pi is the CONTROL row; a session with no snapshot
 * (codex writes none) still reports none — absent, not zero.
 */
describe('F1.460 (13) the context token fields read managed.contextUsage on every runtime', () => {
  const report = { inputTokens: 52_000, contextWindow: 200_000, percent: 26, stale: true, source: 'sdk_usage' as const }

  test.each(ALL_RUNTIMES)('a held snapshot reaches context.inputTokens/contextWindow/percent/stale on %s', async provider => {
    const { manager, managed } = managerFor(provider)
    managed.contextUsage = { ...report }
    const snapshot = await snapshotOf(manager)
    expect(snapshot.context.inputTokens).toBe(52_000)
    expect(snapshot.context.contextWindow).toBe(200_000)
    expect(snapshot.context.percent).toBe(26)
    expect(snapshot.context.stale).toBe(true)
    expect(parsePiHarnessRuntimeSnapshotV1(JSON.parse(JSON.stringify(snapshot))).context.inputTokens).toBe(52_000)
  })

  test.each(NON_PI_RUNTIMES)('negative — no snapshot, no token fields on %s', async provider => {
    const { manager } = managerFor(provider)
    const snapshot = await snapshotOf(manager)
    for (const key of ['inputTokens', 'contextWindow', 'percent', 'stale']) {
      expect(key in snapshot.context).toBe(false)
    }
  })
})

describe('P2.500 checkpoints are reported per PRODUCER, not per "is it Pi"', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  async function sessionPathWithCheckpoint(): Promise<string> {
    const sessionPath = await mkdtemp(join(tmpdir(), 'p2499-checkpoints-'))
    dirs.push(sessionPath)
    const target = join(sessionPath, 'edited-by-the-agent.txt')
    await writeFile(target, 'before', 'utf-8')
    await createFileCheckpoint({
      sessionPath,
      adapter: 'file',
      toolName: 'Write',
      toolCallId: 'call-1',
      input: { file_path: target },
      authorizedTarget: target,
    })
    return sessionPath
  }

  /**
   * The cloud backend's own tool executor calls `createFileCheckpoint` in
   * `beforeDispatch`, and the write and the read are ONE derivation — the
   * executor is handed `BaseAgent.getSessionStoragePath()` and the lister
   * `sessionStore.getSessionPath(session)`, both bottoming out in
   * `getSessionStoragePath(workspaceId, sessionId)`. So this row had real
   * checkpoints and was told it had none.
   */
  test.each<Provider>(['pi', 'nestor-cloud-agent', 'codex-runtime'])('a producer runtime reports its checkpoints on %s', async provider => {
    const sessionPath = await sessionPathWithCheckpoint()
    const { manager, managed } = managerFor(provider, { sessionPath })
    managed.ephemeral = false

    const snapshot = await snapshotOf(manager)

    // The assertion that dies against the `checkpoints: Object.freeze([])` literal.
    expect(snapshot.checkpoints.length).toBe(1)
    expect(snapshot.checkpoints[0]).toMatchObject({
      adapter: 'file',
      toolName: 'Write',
      fileName: 'edited-by-the-agent.txt',
    })
    expect(parsePiHarnessRuntimeSnapshotV1(JSON.parse(JSON.stringify(snapshot))).checkpoints.length).toBe(1)
  })

  /**
   * The negative, and it is the reason this is a producer question rather than a
   * symmetry one: claude has NO producer (`RUNTIME_FILE_CHECKPOINT_PRODUCERS`;
   * the SDK checkpoints into its own store and `Query.rewindFiles` still has no
   * call site here), so an empty list is the true answer even when a manifest
   * sits at the same path. Reporting it without asking would have been the same
   * lie in the other direction.
   *
   * C3.67 moved `codex-runtime` to the producer arm above — it now has a real
   * call site, `CodexAgent.checkpointCodexFileChange` — and this arm is kept
   * with claude alone rather than deleted: a pair whose two halves agree is a
   * deleted test that still runs.
   */
  test.each<Provider>(['anthropic'])('a non-producer runtime reports none even with a manifest present on %s', async provider => {
    const sessionPath = await sessionPathWithCheckpoint()
    const { manager, managed } = managerFor(provider, { sessionPath })
    managed.ephemeral = false

    const snapshot = await snapshotOf(manager)
    expect(snapshot.checkpoints).toEqual([])
  })

  /** The ephemeral arm, mirrored from the Pi branch so the two cannot disagree. */
  test('an ephemeral cloud session reports no checkpoints', async () => {
    const sessionPath = await sessionPathWithCheckpoint()
    const { manager, managed } = managerFor('nestor-cloud-agent', { sessionPath })
    managed.ephemeral = true

    const snapshot = await snapshotOf(manager)
    expect(snapshot.checkpoints).toEqual([])
  })
})
