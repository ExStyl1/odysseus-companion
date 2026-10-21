import { describe, expect, mock, test } from 'bun:test'
import { parsePiAgentViewPageRequestV1, parsePiAgentViewPageV1 } from '@nessy-agent/shared/protocol'
import { GoalService } from '../pi-harness/goal-service.ts'
import { SessionManager } from './SessionManager'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

const managed = (id: string, lastMessageAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  workspace: { id: 'workspace-1', name: 'Workspace / private', rootPath: '/private/root' },
  agent: null,
  isProcessing: false,
  lastMessageAt,
  lastMessageRole: 'assistant',
  taskState: { schemaVersion: 1, revision: 1, tasks: [{ id: 'task', title: '/private/prompt', status: 'in_progress', blockedBy: [] }], tombstones: [] },
  childSessionState: { schemaVersion: 1, revision: 1, sealedOwnerTaskIds: [], children: [] },
  backgroundShellCommands: new Map(),
  piBackgroundTaskKinds: new Map(),
  ...extra,
})

function fixture(items: any[]) {
  // D1.242 — a REAL instance through `createTestSessionManager`, not
  // a bare prototype double. Every assignment below still
  // overrides what it overrode; the fields nobody seeded are now the
  // constructor's rather than `undefined`. D1.109 priced it: a `mkdtemp` and
  // four in-memory stores, not measurably expensive.
  const manager = createTestSessionManager() as any
  manager.sessions = new Map(items.map(item => [item.id, item]))
  manager.resolveManagedProvider = (item: any) => item.provider ?? 'pi'
  manager.piProcessSupervisor = { snapshot: mock(async () => []) }
  manager.piChildSessionServices = new Map()
  manager.piTaskServices = new Map()
  manager.piGoalServices = new Map()
  manager.piAskUserServices = new Map()
  manager.piPlanModeServices = new Map()
  manager.pendingPermissionRequests = new Map()
  manager.agentRefreshLocks = new Map()
  manager.projectMutationSessions = new Set()
  manager.strictDrainPiSession = mock(async (item: any) => {
    item.agent = null
    item.isProcessing = false
  })
  return manager as any
}

describe('SessionManager Pi Agent View', () => {
  // The fixture predates P6.57, which is why this row moved. `session-c` was
  // named `adjacent` because the listing used to FILTER non-Pi sessions out, so
  // the newest session in the workspace never appeared and page 1 began at
  // `session-a`. P6.57 made the listing runtime-neutral on purpose — "gating it
  // on the provider gave a claude or codex user an EMPTY page rather than 'not
  // supported'" — so the sort now puts `session-c` (lastMessageAt 30) first.
  //
  // Updated to the new claim rather than pinned back to the old one, and the
  // change makes two assertions REAL that were vacuous before: the
  // provider-redaction check now runs against a page that actually contains the
  // anthropic session, and `active` being absent (not zeroed) off Pi is
  // asserted where it can fail.
  test('orders, paginates and redacts project/task paths while projecting input and lost truth', async () => {
    const first = managed('session-a', 20, { isProcessing: true, pendingAskUser: { requestId: 'ask-1', question: 'secret', options: [], allowFreeText: true } })
    const second = managed('session-b', 10, { childSessionState: { schemaVersion: 1, revision: 1, sealedOwnerTaskIds: [], children: [{ agentId: 'child', agent: 'worker', task: 'secret', status: 'running', background: true }] } })
    const adjacent = managed('session-c', 30, { provider: 'anthropic' })
    const manager = fixture([first, second, adjacent])

    const page1 = await manager.listPiAgentView('workspace-1', { schemaVersion: 1, limit: 1 })
    expect(page1.items[0]).toMatchObject({ session: { sessionId: 'session-c' }, state: 'idle', residency: 'cold' })
    // Omitted, never zeroed: `0` on a claude session would claim nothing is
    // running where the truth is that nothing is tracked.
    expect(page1.items[0].active).toBeUndefined()
    expect(page1.nextCursor).toBeTruthy()
    const page2 = await manager.listPiAgentView('workspace-1', { schemaVersion: 1, cursor: page1.nextCursor, limit: 1 })
    expect(page2.items[0]).toMatchObject({ session: { sessionId: 'session-a' }, state: 'needs_input', residency: 'cold', needsInput: { kind: 'ask_user', requestId: 'ask-1' } })
    expect(page2.nextCursor).toBeTruthy()
    const page3 = await manager.listPiAgentView('workspace-1', { schemaVersion: 1, cursor: page2.nextCursor, limit: 1 })
    expect(page3.items[0]).toMatchObject({ session: { sessionId: 'session-b' }, state: 'working', residency: 'lost', errorCode: 'runtime_owner_lost' })
    // The Pi session DOES carry the counters — the positive control for the
    // absence asserted on page 1, without which that check passes for a field
    // nothing ever emits.
    expect(page3.items[0].active).toMatchObject({ children: 1 })
    const wire = JSON.stringify([page1, page2, page3])
    expect(wire).not.toContain('/private')
    expect(wire).not.toContain('prompt')
    expect(wire).not.toContain('question')
    expect(wire).not.toContain('anthropic')
  })

  /**
   * D1.323 — the REAL page through the REAL parser, which is the one reading no
   * test of this pair took.
   *
   * `packages/shared/src/protocol/pi-agent-view.test.ts` feeds the parser
   * fixtures written to the shape it expects, and the case above reads the
   * builder's own object; between them, a field the builder emits and the
   * parser's closed `exact()` list rejects could fail nothing. That is the same
   * untested seam D1.264 measured on the SIBLING snapshot parser, where it had
   * already cost a live defect.
   *
   * The page is round-tripped through JSON first, because that is what crosses
   * the IPC boundary before `apps/electron/src/preload/bootstrap.ts` parses the
   * RESULT — the builder's frozen objects do not survive the wire as such.
   *
   * The goal arm drives the REAL `GoalService.safeSnapshot()` rather than a
   * double, because that projection builds `budgets` as a SPREAD of the stored
   * record — the exact construction D1.264 found publishing a fourth key into a
   * three-key wire type. It agrees today; a double could never say so.
   *
   * `session-b` and `session-c` share a `lastMessageAt` on purpose: the builder
   * breaks that tie with `localeCompare` and the parser re-checks it with `<`,
   * two different orderings of one contract, and nothing else in the tree puts
   * them in the same room.
   */
  test('D1.323 — the page the real builder emits is accepted by the real preload parser', async () => {
    const now = 1_700_000_000_000
    const goalState = {
      schemaVersion: 1,
      goal: {
        schemaVersion: 1,
        id: 'goal-1',
        revision: 2,
        source: 'user',
        creator: 'person',
        condition: 'finish the run',
        status: 'active',
        budgets: { turnLimit: 32, tokenLimit: 250_000, costLimitUsd: 20, elapsedLimitMs: 7_200_000 },
        accounting: { turns: 3, tokens: 1_200, costUsd: 0.5, elapsedMs: 4_000, startedAt: now, lastResumedAt: now, resumeCount: 1 },
        createdAt: now - 1_000,
        updatedAt: now,
      },
    }
    const rich = managed('session-a', 30, {
      agent: { getHarnessDiagnostics: () => ({ contextProfile: 'normal' }) },
      contextUsage: { inputTokens: 10, contextWindow: 100, percent: 10, stale: false },
      capabilityRuntime: { view: { generation: 'a'.repeat(64) } },
      piExecutionReceipts: { snapshot: () => [{}, {}] },
      pendingAskUser: { requestId: 'ask-1', question: 'secret', options: [], allowFreeText: true },
      goalState,
    })
    const lost = managed('session-b', 20, {
      childSessionState: { schemaVersion: 1, revision: 1, sealedOwnerTaskIds: [], children: [{ agentId: 'child', agent: 'worker', task: 'secret', status: 'running', background: true }] },
    })
    const foreign = managed('session-c', 20, { provider: 'anthropic' })
    const failed = managed('session-d', 10, { piAgentViewOutcome: 'failed' })
    const manager = fixture([rich, lost, foreign, failed])
    manager.piGoalServices.set(
      manager.managedKey(rich),
      new GoalService({ workspaceId: 'workspace-1', sessionId: 'session-a' }, { now: () => now }, goalState),
    )

    const page = await manager.listPiAgentView('workspace-1', { schemaVersion: 1, limit: 25 })
    const wire = JSON.parse(JSON.stringify(page))
    const parsed = parsePiAgentViewPageV1(wire)

    expect(parsed.items.map(item => item.session.sessionId)).toEqual(['session-a', 'session-b', 'session-c', 'session-d'])
    // Without these the case would pass over a page of bare entries, which is
    // the shape that makes a round-trip assertion look stronger than it is.
    const first = parsed.items[0]!
    expect(first.goal?.status).toBe('active')
    expect(first.goal?.budgets.turnLimit).toBe(32)
    expect(first.goal?.accounting.resumeCount).toBe(1)
    expect(first.needsInput).toEqual({ kind: 'ask_user', requestId: 'ask-1' })
    expect(first.context).toEqual({ mode: 'normal', inputTokens: 10, contextWindow: 100, percent: 10, stale: false })
    expect(first.capabilityGeneration).toBe('a'.repeat(64))
    expect(first.receiptCount).toBe(2)
    expect(first.task).toEqual({ total: 1, active: 1, completed: 0, blocked: 0 })
    expect(parsed.items[1]!.errorCode).toBe('runtime_owner_lost')
    expect(parsed.items[2]!.active).toBeUndefined()
    expect(parsed.items[3]!.errorCode).toBe('session_failed')

    // The instrument's own discrimination: the same parser, the same page, one
    // key the builder does not emit. Without it, a parser that accepted
    // anything would read exactly like a builder that emits nothing wrong.
    expect(() => parsePiAgentViewPageV1({ ...wire, items: [{ ...wire.items[0], rawPrompt: 'secret' }, ...wire.items.slice(1)] }))
      .toThrow('pi-agent-view-invalid')
  })

  /**
   * D1.323's other half — the REQUEST, which is where RS-56's
   * `pi-agent-view-invalid` actually came from.
   *
   * Both parsers in this family throw that one word, so a rig reading it from
   * outside the preload cannot tell a rejected RESULT from a rejected REQUEST —
   * and `scripts/cdp/cases/rs-56.ts` called `listPiAgentView({ session, limit })`,
   * which is neither of that request type's fields plus a missing
   * `schemaVersion`. The declared shape beside it is the control.
   */
  test('D1.323 — the RPC route accepts the declared request shape and refuses RS-56\'s', async () => {
    const manager = fixture([managed('session-a', 20)])
    // The parse sits INSIDE the arrow on purpose: that is where the RPC route
    // puts it (`handlers/rpc/sessions.ts`), so a bad request throws before the
    // manager is reached at all — which is the whole finding.
    const route = (value: unknown) => manager.listPiAgentView('workspace-1', parsePiAgentViewPageRequestV1(value))
    await expect(route({ schemaVersion: 1, limit: 20 })).resolves.toMatchObject({ schemaVersion: 1 })
    expect(() => route({ session: { workspaceId: 'workspace-1', sessionId: 'session-a' }, limit: 20 })).toThrow('pi-agent-view-invalid')
    expect(() => route({ schemaVersion: 1, session: { workspaceId: 'workspace-1', sessionId: 'session-a' }, limit: 20 })).toThrow('pi-agent-view-invalid')
    expect(() => route({ limit: 20 })).toThrow('pi-agent-view-invalid')
  })

  test('owner-checks idempotent stop/resume and delivers a paused queue once', async () => {
    const session = managed('session-a', 20, { agent: {}, queuePaused: true, messageQueue: [{ message: 'queued' }] }) as any
    const manager = fixture([session]) as any
    manager.getManaged = (id: string, workspaceId: string) => id === session.id && workspaceId === session.workspace.id ? session : undefined
    manager.ensureMessagesLoaded = mock(async () => {})
    manager.cancelProcessing = mock(async () => {})
    manager.disposeManagedAgentRuntime = mock(async () => { session.agent = null })
    manager.persistSession = mock(() => {})
    manager.emitPiHarnessInvalidation = mock(() => {})
    manager.projectPiAgentViewEntry = mock(async () => ({ residency: 'cold' }))
    manager.withCapabilityRuntime = mock(async (_managed: unknown, action: (runtime: unknown) => Promise<unknown>) => action({}))
    manager.getOrCreateAgent = mock(async () => { session.agent = {}; return session.agent })
    manager.resumeQueue = mock(async () => { session.queuePaused = false })

    await manager.controlPiAgentView({ schemaVersion: 1, session: { workspaceId: 'workspace-1', sessionId: 'session-a' }, action: 'stop' })
    await manager.controlPiAgentView({ schemaVersion: 1, session: { workspaceId: 'workspace-1', sessionId: 'session-a' }, action: 'stop' })
    expect(session.piAgentViewOutcome).toBe('stopped')
    await manager.controlPiAgentView({ schemaVersion: 1, session: { workspaceId: 'workspace-1', sessionId: 'session-a' }, action: 'resume' })
    await manager.controlPiAgentView({ schemaVersion: 1, session: { workspaceId: 'workspace-1', sessionId: 'session-a' }, action: 'resume' })
    expect(manager.resumeQueue).toHaveBeenCalledTimes(1)
    await expect(manager.controlPiAgentView({ schemaVersion: 1, session: { workspaceId: 'other', sessionId: 'session-a' }, action: 'open' })).rejects.toThrow('session-not-found')
  })
})
