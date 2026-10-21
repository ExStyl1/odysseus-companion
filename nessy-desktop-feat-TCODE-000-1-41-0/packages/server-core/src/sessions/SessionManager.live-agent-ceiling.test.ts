import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { ProcessStore } from '../pi-harness/process-store.ts'
import { ProcessSupervisor } from '../pi-harness/process-supervisor.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

/**
 * The ceiling on the real private method (B3 Task 3).
 *
 * The reason this suite used to give for hand-building its manager — the
 * constructor wants a session store, a capability resolver and a process
 * supervisor, and none of them participates in this decision — is replaced by
 * the measurement D1.242 asked for: `createTestSessionManager` supplies all
 * three from a `mkdtemp` and in-memory stores, priced on this family at
 * 68.38 s hand-built against 62.45 s constructed (D1.109, `0dc2c346e`), both
 * runs ~3 % cpu, i.e. inside the rig's own noise. So the manager is real and
 * only what the method under test reaches is overridden.
 */
/** Everything the busy predicate reads, in its harmless shape. */
interface SessionShape {
  isProcessing?: boolean
  backendProcessing?: boolean
  /** L5 — `AgentInstance.backgroundWorkCount()`, the Claude background level. */
  backendBackgroundTasks?: number
  children?: Array<'running' | 'completed'>
  workflows?: number
  shells?: number
  askUser?: boolean
  provider?: string
  processes?: Array<'running' | 'exited' | 'lost'>
  processSnapshotFails?: boolean
  channelSubscription?: boolean
  /** F1.1282 — whether the session's pool lease holds a connection armed for channel push. */
  armedChannel?: boolean
  commandMonitors?: number
  agentLastActiveAt?: number
}

function ceilingManager(ceiling: number) {
  const disposed: Array<{ sessionId: string; reason: string; strict: boolean | undefined }> = []
  const events: Array<{ sessionId: string; message: string; level?: string }> = []
  const manager = createTestSessionManager() as any
  manager.sessions = new Map()
  manager.liveAgentCeiling = ceiling
  manager.piChildSessionServices = new Map()
  manager.piAskUserServices = new Map()
  manager.pendingPermissionRequests = new Map()
  // Added 2026-09-11 (W12-c): `f3160a2a0` (P6.461) made `setProcessing` stamp
  // the `type=cli` half of `active_time.total` on the rising edge, so the
  // reaper row that drives a real turn boundary through this double threw
  // `TypeError: undefined is not an object (evaluating 'this.cliActiveSince.set')`
  // out of `setProcessing`. Production initialises the field at its
  // declaration; a bare prototype carries no class field at all.
  manager.cliActiveSince = new Map()
  manager.piProcessSupervisor = {
    // P2.143 — the busy read is `countActive`, not a capped `snapshot`. The rig
    // answers the same question the real supervisor answers: how many of THIS
    // session's records are `running` or `lost`, with no slice.
    countActive: async (sessionKey: { sessionId: string }) => {
      const managed = manager.sessions.get(encodeSessionKey({ workspaceId: 'ws', sessionId: sessionKey.sessionId }))
      if (managed?.__shape.processSnapshotFails) throw new Error('process-store-unreadable')
      return (managed?.__shape.processes ?? [])
        .filter((status: string) => status === 'running' || status === 'lost').length
    },
  }
  manager.resolveManagedProvider = (managed: any) => managed.__shape.provider ?? 'anthropic'
  manager.disposeManagedAgentRuntime = mock(async (managed: any, reason: string, strict?: boolean) => {
    disposed.push({ sessionId: managed.id, reason, strict })
    managed.agent = null
  })
  manager.sendEvent = mock((event: any) => {
    events.push({ sessionId: event.sessionId, message: event.message, level: event.level })
  })

  const add = (id: string, lastMessageAt: number, shape: SessionShape = {}) => {
    const managed = {
      id,
      workspace: { id: 'ws' },
      agent: {
        isProcessing: () => shape.backendProcessing ?? false,
        backgroundWorkCount: () => shape.backendBackgroundTasks ?? 0,
      },
      lastMessageAt,
      agentLastActiveAt: shape.agentLastActiveAt,
      isProcessing: shape.isProcessing ?? false,
      childSessionState: shape.children
        ? { children: shape.children.map((status, index) => ({ agentId: `a${index}`, status })) }
        : undefined,
      piBackgroundTaskKinds: new Map(
        Array.from({ length: shape.workflows ?? 0 }, (_value, index) => [`t${index}`, 'subagent' as const]),
      ),
      backgroundShellCommands: new Map(
        Array.from({ length: shape.shells ?? 0 }, (_value, index) => [`s${index}`, 'sleep 1']),
      ),
      pendingAskUser: shape.askUser ? { requestId: 'q1' } : undefined,
      mcpChannelSubscription: shape.channelSubscription ? { leaserId: 'l1', dispose: () => {} } : undefined,
      mcpLeaserId: shape.channelSubscription ? 'l1' : undefined,
      mcpPool: shape.channelSubscription
        ? { hasArmedChannelConnection: (leaserId: string) => leaserId === 'l1' && shape.armedChannel === true }
        : undefined,
      pluginCommandMonitors: shape.commandMonitors
        ? new Map(Array.from({ length: shape.commandMonitors }, (_value, index) => [`m${index}`, 'watch']))
        : undefined,
      __shape: shape,
    }
    manager.sessions.set(encodeSessionKey({ workspaceId: 'ws', sessionId: id }), managed)
    return managed
  }
  const admitting = (id: string) => ({
    id,
    workspace: { id: 'ws' },
    agent: null,
    lastMessageAt: 0,
    isProcessing: false,
    backgroundShellCommands: new Map(),
    __shape: {},
  })
  return { manager, add, admitting, disposed, events }
}

describe('SessionManager live-agent ceiling', () => {
  test('evicts the least recently used idle agent and tells that session why', async () => {
    const { manager, add, admitting, disposed, events } = ceilingManager(2)
    add('busy', 1, { isProcessing: true })
    const idle = add('idle', 2)

    await manager.enforceLiveAgentCeiling(admitting('fresh'))

    // The oldest agent is the BUSY one; the oldest IDLE one is what goes.
    expect(disposed).toEqual([{ sessionId: 'idle', reason: 'live-agent ceiling', strict: true }])
    expect(idle.agent).toBeNull()
    // The user of the EVICTED session learns, because their next send will be
    // slow and the reason should not be a mystery.
    expect(events).toHaveLength(1)
    expect(events[0]?.sessionId).toBe('idle')
    expect(events[0]?.level).toBe('info')
    expect(events[0]?.message).toContain('2-agent limit')
    expect(events[0]?.message).toContain('start again on your next message')
  })

  test('refuses the new agent rather than interrupting a turn, and evicts nothing', async () => {
    const { manager, add, admitting, disposed, events } = ceilingManager(2)
    add('busy-a', 1, { isProcessing: true })
    add('busy-b', 2, { isProcessing: true })

    await expect(manager.enforceLiveAgentCeiling(admitting('fresh')))
      .rejects.toThrow('live-agent-ceiling-reached')
    expect(disposed).toEqual([])
    expect(events).toEqual([])
  })

  test('admits without eviction below the ceiling', async () => {
    const { manager, add, admitting, disposed, events } = ceilingManager(4)
    add('one', 1)
    add('two', 2)

    await manager.enforceLiveAgentCeiling(admitting('fresh'))
    expect(disposed).toEqual([])
    expect(events).toEqual([])
  })
})

/**
 * L3 — THE EVICTION DEFECT.
 *
 * `disposeManagedAgentRuntime` calls `piProcessSupervisor.drainSession` for THIS
 * session whatever its runtime, and clears `piBackgroundTaskKinds`;
 * `startPiChildRuntime` detaches a background child's run and returns `running`.
 * (That first clause read "for a Pi session" until P2.23 removed the gate, and
 * it survived the sweep that corrected its twin in `live-agent-ceiling.ts`
 * because it WRAPS ACROSS A LINE BREAK — a phrase grep cannot see a clause a
 * comment has split across `\n *`. Re-sweep a corrected sentence with a
 * whitespace-normalised multiline pattern, never a phrase grep.) So every
 * session below sits at
 * `isProcessing === false` — the predicate the ceiling used to read — while
 * holding work eviction would destroy. The control in each case is the same
 * session with the holding removed: it IS evicted, so these are the predicate
 * discriminating rather than the ceiling having stopped working.
 */
describe('eviction does not destroy work that cannot be recovered', () => {
  const holdings: Array<[string, SessionShape]> = [
    ['a detached background child', { children: ['running'] }],
    ['a running background process', { provider: 'pi', processes: ['running'] }],
    ['a backgrounded workflow evaluator', { workflows: 1 }],
    ['a background shell', { shells: 1 }],
    // L5. Every other background holding here is read from a map SessionManager
    // writes from a Pi event; Claude's adapter refuses to emit that event, so
    // this one has to be asked of the backend. The SDK's Agent tool backgrounds
    // by default, which makes it the likeliest holding of all on that runtime.
    ['a Claude background task no host map records', { backendBackgroundTasks: 1 }],
    ['an unanswered question to the user', { askUser: true }],
    ['a backend turn the host flag has already cleared', { backendProcessing: true }],
  ]

  for (const [what, shape] of holdings) {
    test(`refuses rather than evicting a session holding ${what}`, async () => {
      const { manager, add, admitting, disposed } = ceilingManager(1)
      add('holder', 1, shape)

      await expect(manager.enforceLiveAgentCeiling(admitting('fresh')))
        .rejects.toThrow('live-agent-ceiling-reached')
      expect(disposed).toEqual([])
    })

    test(`still evicts the same session once ${what} is gone`, async () => {
      const { manager, add, admitting, disposed } = ceilingManager(1)
      // Same shape, emptied. Without this the refusal above would also pass on a
      // ceiling that had simply stopped evicting anything.
      add('holder', 1, { provider: shape.provider })

      await manager.enforceLiveAgentCeiling(admitting('fresh'))
      expect(disposed.map(entry => entry.sessionId)).toEqual(['holder'])
    })
  }

  test('a pending permission card is work too', async () => {
    const { manager, add, admitting, disposed } = ceilingManager(1)
    add('holder', 1)
    manager.pendingPermissionRequests.set('req-1', { workspaceId: 'ws', sessionId: 'holder' })

    await expect(manager.enforceLiveAgentCeiling(admitting('fresh')))
      .rejects.toThrow('live-agent-ceiling-reached')
    expect(disposed).toEqual([])

    // A card belonging to a DIFFERENT session does not protect this one.
    manager.pendingPermissionRequests.set('req-1', { workspaceId: 'ws', sessionId: 'somebody-else' })
    await manager.enforceLiveAgentCeiling(admitting('fresh'))
    expect(disposed.map(entry => entry.sessionId)).toEqual(['holder'])
  })

  test('a process snapshot that fails reads as busy, not as idle', async () => {
    // "I could not find out whether anything is running" is not a yes. The
    // control is the same session with a readable, empty store.
    const { manager, add, admitting, disposed } = ceilingManager(1)
    add('holder', 1, { provider: 'pi', processSnapshotFails: true })

    await expect(manager.enforceLiveAgentCeiling(admitting('fresh')))
      .rejects.toThrow('live-agent-ceiling-reached')
    expect(disposed).toEqual([])
  })

  test('the process store is not read at all while the host is under its ceiling', async () => {
    const { manager, add, admitting, disposed } = ceilingManager(4)
    let reads = 0
    manager.piProcessSupervisor = { countActive: async () => { reads++; return 0 } }
    add('one', 1, { provider: 'pi' })
    add('two', 2, { provider: 'pi' })

    await manager.enforceLiveAgentCeiling(admitting('fresh'))
    expect(disposed).toEqual([])
    // Listing and parsing the process directory per live session on every agent
    // creation is a real cost, and below the ceiling there is no victim to pick.
    expect(reads).toBe(0)
  })
})

/**
 * L3 — THE IDLE REAPER, on the real private method.
 *
 * Every session here is idle by the same margin, so what separates them is the
 * predicate and nothing else.
 */
describe('SessionManager idle-agent reaper', () => {
  const TTL = 30 * 60_000
  const longAgo = () => Date.now() - TTL - 1

  test('reaps an idle agent, and does not reap a busy one on the same sweep', async () => {
    const { manager, add, disposed, events } = ceilingManager(8)
    const idle = add('idle', 1, { agentLastActiveAt: longAgo() })
    add('busy-turn', 1, { agentLastActiveAt: longAgo(), isProcessing: true })
    add('busy-child', 1, { agentLastActiveAt: longAgo(), children: ['running'] })
    add('busy-process', 1, { agentLastActiveAt: longAgo(), provider: 'pi', processes: ['running'] })

    await manager.reapIdleAgents()

    expect(disposed).toEqual([{ sessionId: 'idle', reason: 'idle-agent reaper', strict: undefined }])
    expect(idle.agent).toBeNull()
    // Nobody is there to read it — unlike an eviction, which is paid for by the
    // user's next send and says so.
    expect(events).toEqual([])
  })

  /**
   * L5 — THE REAPER IS THE PATH THAT ACTUALLY BITES HERE.
   *
   * Eviction needs a host at its agent ceiling; the reaper needs only thirty
   * quiet minutes, which is exactly what a session waiting on a long background
   * subagent looks like. And a reap is SILENT by design, so the user would be
   * told neither that the work was killed nor why the answer never came.
   */
  test('never reaps a Claude session whose background task is still running', async () => {
    const { manager, add, disposed } = ceilingManager(8)
    add('holding', 1, { agentLastActiveAt: longAgo(), backendBackgroundTasks: 1 })
    // The control: the same session after the level came back down. Without it
    // the assertion above would also pass on a reaper that had stopped working.
    add('finished', 1, { agentLastActiveAt: longAgo(), backendBackgroundTasks: 0 })

    await manager.reapIdleAgents()

    expect(disposed.map(entry => entry.sessionId)).toEqual(['finished'])
  })

  test('never reaps a session whose wake path the dispose would take', async () => {
    const { manager, add, disposed } = ceilingManager(8)
    add('subscribed', 1, { agentLastActiveAt: longAgo(), channelSubscription: true, armedChannel: true })
    add('monitoring', 1, { agentLastActiveAt: longAgo(), commandMonitors: 1 })
    // The control, idle by the identical margin and holding nothing.
    add('plain', 1, { agentLastActiveAt: longAgo() })

    await manager.reapIdleAgents()

    // `ensureSessionChannelSubscription` re-arms only at agent construction, so
    // reaping either of the first two would not hibernate the session — it would
    // make it deaf until a human typed something.
    expect(disposed.map(entry => entry.sessionId)).toEqual(['plain'])
  })

  /**
   * F1.1282 (origin SIT3-b, 2026-10-02) — every session with an MCP lease holds
   * a channel subscription (`ensureSessionChannelSubscription` subscribes once
   * per lease, whatever its servers are), so counting the subscription alone
   * made `holdsWakePath` true for every live session with an MCP pool and the
   * reaper never released one. The wake path is a connection actually armed for
   * channel push: a subscription with none is not one.
   */
  test('F1.1282 — reaps a session whose lease has a channel subscription but no channel-armed server', async () => {
    const { manager, add, disposed } = ceilingManager(8)
    add('lease-only', 1, { agentLastActiveAt: longAgo(), channelSubscription: true, armedChannel: false })
    // The control: the same lease with a channel-armed server keeps its session.
    add('armed', 1, { agentLastActiveAt: longAgo(), channelSubscription: true, armedChannel: true })

    await manager.reapIdleAgents()

    expect(disposed.map(entry => entry.sessionId)).toEqual(['lease-only'])
  })

  test('leaves a session that is still inside its idle window', async () => {
    const { manager, add, disposed } = ceilingManager(8)
    add('recent', 1, { agentLastActiveAt: Date.now() - 1_000 })
    add('never-stamped', 1)

    await manager.reapIdleAgents()
    expect(disposed).toEqual([])
  })

  test('re-checks on the near side of the dispose and skips a session that got busy', async () => {
    const { manager, add, disposed } = ceilingManager(8)
    const racing = add('racing', 1, { agentLastActiveAt: longAgo(), provider: 'pi' })
    // The reads are async; a send can start between the sweep's decision and the
    // teardown. The snapshot flips the session to busy exactly once, after the
    // policy has already named it a victim.
    let reads = 0
    manager.piProcessSupervisor = {
      countActive: async () => (++reads > 1 ? 1 : 0),
    }

    await manager.reapIdleAgents()

    expect(disposed).toEqual([])
    expect(racing.agent).not.toBeNull()
  })

  test('a failed dispose is logged rather than thrown out of the timer', async () => {
    const { manager, add } = ceilingManager(8)
    add('unhappy', 1, { agentLastActiveAt: longAgo() })
    manager.disposeManagedAgentRuntime = mock(async () => { throw new Error('peripheral-stuck') })

    // Nothing awaits a sweep, so a rejection here is an unhandled one.
    await expect(manager.reapIdleAgents()).resolves.toBeUndefined()
  })

  test('the sweep stops itself once no session holds a runtime', async () => {
    const { manager, add } = ceilingManager(8)
    add('idle', 1, { agentLastActiveAt: longAgo() })
    manager.armIdleAgentReaper()
    expect(manager.idleAgentReaperTimer).toBeDefined()

    await manager.reapIdleAgents()
    // First sweep reaped it; the second finds nothing left to guard.
    await manager.reapIdleAgents()

    // A backstop that outlives what it guards is a leak of its own — L2's
    // `ClaudeTurnSlot.onSettled` exists for the same reason.
    expect(manager.idleAgentReaperTimer).toBeUndefined()
  })

  test('the idle clock is the turn boundary, not the last message timestamp', async () => {
    const { manager, add, disposed } = ceilingManager(8)
    // A session whose LAST MESSAGE is from yesterday but which just finished a
    // long turn. `rewindToMessage` assigns `lastMessageAt` a historical value,
    // so keying the reaper off it would take the runtime out from under a user
    // who had just rewound. And a turn that ran for an hour must not read as an
    // hour idle the moment it ends.
    const worked = add('worked-all-along', Date.now() - 24 * 3_600_000, { agentLastActiveAt: longAgo() })
    manager.setProcessing(worked, true)
    manager.setProcessing(worked, false)

    await manager.reapIdleAgents()
    expect(disposed).toEqual([])
    expect(worked.agentLastActiveAt).toBeGreaterThan(Date.now() - 5_000)

    // The control: the same session with only its history refreshed and no turn
    // run IS reaped, so the stamp above is what saved it.
    const stale = add('idle-with-recent-history', Date.now(), { agentLastActiveAt: longAgo() })
    await manager.reapIdleAgents()
    expect(disposed.map(entry => entry.sessionId)).toEqual(['idle-with-recent-history'])
    expect(stale.agent).toBeNull()
  })

  test('a sweep that lands during cleanup disarms instead of reaping', async () => {
    const { manager, add, disposed } = ceilingManager(8)
    add('idle', 1, { agentLastActiveAt: longAgo() })
    manager.armIdleAgentReaper()
    manager.cleanupPromise = Promise.resolve()

    await manager.reapIdleAgents()

    expect(disposed).toEqual([])
    expect(manager.idleAgentReaperTimer).toBeUndefined()
  })
})

/**
 * P2.23 — THE MEASUREMENT WAS PER-RUNTIME, AND THE TEARDOWN AGREED WITH IT.
 *
 * `liveAgentBusyDomainsFor` returned synchronous zeros for every provider but
 * Pi, on the stated premise that "`disposeManagedAgentRuntime` only calls
 * `drainSession` for a Pi one, so on any other runtime there is no process for a
 * dispose to kill". Neither half held: `SessionMonitorService` is constructed
 * with `processPort: piWorkspaceDrainParticipant.processSupervisorPort` and
 * starts every `Monitor` command watch through it under the WATCHING session's
 * key, and `Monitor` reaches claude in-process and codex over the host-callback
 * bridge. So a claude or codex session could hold a running supervised process,
 * measure idle, be evicted for it — and keep the record latched `running` until
 * retention swept it, because the dispose that killed the runtime asked the
 * provider before draining.
 *
 * Every row below runs on all three runtimes, and `pi` is the CONTROL: its
 * answers are the ones it already gave, so a "fix" that moved Pi fails here.
 * The pair per row is the other control — the same session with the holding
 * removed IS taken, so a refusal is the predicate discriminating rather than the
 * ceiling having stopped working.
 */
describe('P2.23 — the ceiling and the reaper see a supervised process on every runtime', () => {
  const RUNTIMES = ['pi', 'anthropic', 'codex'] as const
  const TTL = 30 * 60_000
  const longAgo = () => Date.now() - TTL - 1

  for (const provider of RUNTIMES) {
    test(`refuses rather than evicting a ${provider} session holding a running process`, async () => {
      const { manager, add, admitting, disposed } = ceilingManager(1)
      add('holder', 1, { provider, processes: ['running'] })

      await expect(manager.enforceLiveAgentCeiling(admitting('fresh')))
        .rejects.toThrow('live-agent-ceiling-reached')
      expect(disposed).toEqual([])
    })

    test(`evicts the same ${provider} session once that process has exited`, async () => {
      const { manager, add, admitting, disposed } = ceilingManager(1)
      add('holder', 1, { provider, processes: ['exited'] })

      await manager.enforceLiveAgentCeiling(admitting('fresh'))
      expect(disposed.map(entry => entry.sessionId)).toEqual(['holder'])
    })

    test(`refuses over a ${provider} record the host cannot confirm dead`, async () => {
      // `lost` is the supervisor's own word for "this host cannot say whether it
      // is alive", and this read has always counted it alongside `running`. It
      // is also why P2.22's cheaper `countRunning` index read is NOT what this
      // predicate uses: that one counts `running` only, so adopting it here
      // would have left claude and codex evictable over exactly the record Pi
      // refuses to evict over — the same per-runtime split, in the fail-open
      // direction.
      const { manager, add, admitting, disposed } = ceilingManager(1)
      add('holder', 1, { provider, processes: ['lost'] })

      await expect(manager.enforceLiveAgentCeiling(admitting('fresh')))
        .rejects.toThrow('live-agent-ceiling-reached')
      expect(disposed).toEqual([])
    })

    test(`never reaps a ${provider} session whose process is still running`, async () => {
      // The reaper is the likelier path of the two: eviction needs a host at its
      // agent ceiling, while this needs only thirty quiet minutes — which is
      // exactly what a session watching a long build looks like. And a reap is
      // silent, so the user would be told neither that the watch died nor why.
      const { manager, add, disposed } = ceilingManager(8)
      add('holding', 1, { provider, agentLastActiveAt: longAgo(), processes: ['running'] })
      add('finished', 1, { provider, agentLastActiveAt: longAgo(), processes: ['exited'] })

      await manager.reapIdleAgents()

      expect(disposed.map(entry => entry.sessionId)).toEqual(['finished'])
    })
  }

  test('reads the store for THIS session and nothing else', async () => {
    // The store is GLOBAL — one `.pi-processes` for the whole app — so the only
    // thing keeping session A's process from holding session B live is the key
    // this read is scoped by.
    //
    // P2.143 — and it is asked with NO second argument. The read used to be
    // `snapshot(key, { limit: 100 })`, which sorts `startedAt` DESC and slices,
    // so a session owning 100 or more records could not see an OLD still-running
    // one and read idle. `snapshot` rejects any limit above 100 outright, so the
    // cap could not be raised; `countActive` asks the same `running || lost`
    // question over the whole of this session's records. The single-argument
    // shape is the assertion: a limit reappearing here re-opens the under-count.
    const { manager, add, admitting, disposed } = ceilingManager(1)
    add('holder', 1, { provider: 'anthropic' })
    const calls: unknown[][] = []
    manager.piProcessSupervisor = {
      countActive: async (...args: unknown[]) => { calls.push(args); return 0 },
    }

    await manager.enforceLiveAgentCeiling(admitting('fresh'))

    expect(disposed.map(entry => entry.sessionId)).toEqual(['holder'])
    expect(calls).toEqual([[{ workspaceId: 'ws', sessionId: 'holder' }]])
  })

  /**
   * P2.143, on a REAL `ProcessSupervisor` over a REAL `ProcessStore`, because
   * the under-count lives inside `snapshot`'s sort-then-slice and a mocked
   * supervisor cannot reproduce it.
   *
   * MEASURED on the pre-fix tree with this exact store — 121 records for one
   * session, the OLDEST of them the only `running` one:
   *   `snapshot(key, { limit: 100 })` returned the 100 newest, and the
   *   `running || lost` filter over them counted **0**. The busy read answered
   *   "idle" and the ceiling was free to evict a session holding a live process.
   *
   * The sibling mitigation P2.23's review recorded is RE-CONFIRMED here rather
   * than inherited: `drainSession` reads `store.list` with no limit at all, so
   * even inside that window it still found the record and refused to report a
   * clean drain. The cost was a wrong READING, never a silently destroyed
   * process — which is why this was a row and not a fix wave.
   *
   * THE EXPLICIT BUDGET (2026-09-11, W12-c). Those 121 records are 121 real
   * file creates, and the case then lists, snapshots and drains them — on a box
   * where `bun` itself prints `warn: Slow filesystem detected` and per-file-open
   * latency under concurrency is the dominant cost. It timed out at 5 002.89 ms
   * with ZERO assertion failures, which is AGENTS.md's
   * budget-below-the-resting-floor shape rather than a defect in what it
   * measures. Priced with `--reporter=junit`, which times the BODY rather than
   * the module graph around it: **15.590 s** at load 12.9, four sibling lanes on
   * the tree, inside a file whose other 46 cases sum to under 7 s. So the
   * default 5 s was never going to hold here, and the budget below is set
   * against that measured floor with room, not against zero. The store is NOT
   * shrunk instead: 121 is the number that makes a `{ limit: 100 }` cap slice
   * the running record away, so it IS the row.
   */
  test('counts an old running record a capped snapshot would have sliced away', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p143-store-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({
        store,
        graceMs: 20,
        resolveIsolation: (input: { command: string; args: readonly string[]; profile: string }) => ({
          command: input.command, args: input.args, backend: 'test', profile: input.profile,
        }) as never,
      })
      const sessionKey = { workspaceId: 'ws', sessionId: 'busy' }
      const base = {
        executionId: 'e', semanticId: 'shell', pid: null, deadlineAt: 0,
        exitCode: null, signal: null, pidStartMarker: null,
        profile: 'workspace' as never, isolationProfile: 'none',
        environmentProfile: 'workspace' as never, environmentDigest: 'd', cwd: '/tmp',
      }
      await store.create({ ...base, sessionKey, startedAt: 1, status: 'running' })
      for (let index = 0; index < 120; index++) {
        await store.create({ ...base, sessionKey, startedAt: 1000 + index, status: 'exited' })
      }

      // The rig can see the record at all — without this control the count
      // below would also read 1 on a store that never got its 120 siblings.
      expect((await store.list(sessionKey)).length).toBe(121)
      // The defect, still reproducible through the read this row replaced.
      const capped = (await supervisor.snapshot(sessionKey, { limit: 100 }))
        .filter(process => process.status === 'running' || process.status === 'lost').length
      expect(capped).toBe(0)
      // The read the ceiling now takes.
      expect(await supervisor.countActive(sessionKey)).toBe(1)

      // And the mitigation the row rests on, re-measured rather than inherited:
      // the drain is uncapped, so it still finds the record the capped read
      // missed and fails closed over it.
      await expect(supervisor.drainSession(sessionKey)).rejects.toThrow('process-session-drain-failed')
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60_000)

  /**
   * The other half of `countActive`'s predicate, and the reason
   * `ProcessStore.countRunning` — which is cheaper and index-backed — is NOT
   * what the busy read delegates to: it counts `running` only, so a `lost`
   * record (a process that cannot be confirmed dead) would read as idle.
   */
  test('counts a lost record as active, which the running index cannot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p143-lost-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({
        store,
        graceMs: 20,
        resolveIsolation: (input: { command: string; args: readonly string[]; profile: string }) => ({
          command: input.command, args: input.args, backend: 'test', profile: input.profile,
        }) as never,
      })
      const sessionKey = { workspaceId: 'ws', sessionId: 'lost-holder' }
      await store.create({
        sessionKey, executionId: 'e', semanticId: 'shell', pid: null, startedAt: 1, deadlineAt: 0,
        status: 'lost', exitCode: null, signal: null, pidStartMarker: null,
        profile: 'workspace' as never, isolationProfile: 'none',
        environmentProfile: 'workspace' as never, environmentDigest: 'd', cwd: '/tmp',
      })

      expect(await store.countRunning(sessionKey)).toBe(0)
      expect(await supervisor.countActive(sessionKey)).toBe(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

/**
 * P2.23 — THE OTHER HALF, ON A REAL PROCESS AND A REAL STORE.
 *
 * The measurement above keeps the ceiling off a busy non-Pi session; this is
 * what happens on the teardown paths that are NOT the ceiling — a session close,
 * a runtime switch, a restart-required config change — where the dispose runs
 * over whatever the session is holding by design. While the drain asked the
 * provider, those paths killed a claude or codex runtime and left its supervised
 * processes' records standing at `running` until retention swept them: the work
 * destroyed and the paperwork kept, which is the state `runtime_owner_lost` is
 * computed from.
 *
 * A REAL `ProcessSupervisor` over a real `ProcessStore` and a real OS process,
 * because a mocked drain cannot show a record that fails to move.
 */
describe('P2.23 — a non-Pi dispose drains this session’s supervised processes', () => {
  const isolationFree = (input: { command: string; args: readonly string[]; profile: string }) => ({
    command: input.command,
    args: input.args,
    backend: 'test',
    profile: input.profile,
  }) as never

  /** Everything `disposeManagedAgentRuntime` reaches on `this`, and no more. */
  function disposeManager(supervisor: ProcessSupervisor) {
    const manager = createTestSessionManager() as any
    manager.piProcessSupervisor = supervisor
    manager.piLspServices = new Map()
    manager.piLspRegistrations = new Map()
    manager.piLspAuthoritySignatures = new Map()
    manager.piLspDiagnostics = new Map()
    // The provider is ANSWERED, and the drain must not care what it says.
    manager.resolveManagedProvider = mock(() => 'anthropic')
    return manager
  }

  function managedSession(sessionId: string) {
    return {
      id: sessionId,
      workspace: { id: 'ws' },
      agent: {
        setCapabilityTurnRuntime: () => {},
        setAutomationSystem: () => {},
        captureLifecycleState: () => ({ sessionStartEmitted: true, sessionEndEmitted: false, sessionStartHooksApplied: true }),
        drainAutomationEvents: async () => {},
        disposeForRestart: async () => {},
      },
      backgroundShellCommands: new Map(),
    } as any
  }

  /**
   * The shape `SessionMonitorService.startCommand` starts: a persistent,
   * backgrounded `/bin/sh -lc` under the watching session's key, with
   * `semanticId: 'monitor'`. The command writes its marker only if it is still
   * alive half a second from now, so the file is the work itself rather than a
   * proxy for it.
   */
  async function startMonitorShapedProcess(supervisor: ProcessSupervisor, sessionKey: { workspaceId: string; sessionId: string }, marker: string) {
    return await supervisor.start({
      sessionKey,
      executionId: `monitor-${sessionKey.sessionId}`,
      semanticId: 'monitor',
      command: '/bin/sh',
      args: ['-lc', `(sleep 0.5; printf still-running > ${JSON.stringify(marker)}) & wait`],
      cwd: '/tmp',
      workspaceRoot: '/tmp',
      profile: 'workspace',
      background: true,
      persistent: true,
      timeoutMs: 30_000,
    })
  }

  /**
   * P2.23's marker pair shared a bare `await Bun.sleep(700)`, and 700 ms is
   * 200 ms of headroom over the child's own `sleep 0.5` — a narrowing knob set
   * below this box's resting floor.
   *
   * Measured 2026-09-11 (W12-c) at load 10.4 with four sibling lanes on the
   * tree: the CONTROL below failed `ENOENT` on the marker inside a case that
   * itself took 3 553 ms, i.e. the wait expired while the child was still being
   * scheduled. And the absence half is the worse of the two, because its
   * failure mode is silent: a child delayed past 700 ms makes it pass
   * VACUOUSLY, which is the single outcome a control exists to prevent.
   *
   * So both halves share ONE deadline through this helper. The presence half
   * POLLS, so it still returns in about half a second when the box is quiet;
   * the absence half waits the whole of it, which is what makes its
   * `undefined` mean "the drain reached the process" rather than "the box was
   * slow". Both cases carry an explicit budget, because the deadline is being
   * raised past the 5 s default the budget would otherwise be.
   */
  const MARKER_DEADLINE_MS = 6_000
  const MARKER_CASE_BUDGET_MS = 25_000

  /** The marker's content, or `undefined` once the shared deadline has passed. */
  async function markerWithinDeadline(marker: string): Promise<string | undefined> {
    const deadline = Date.now() + MARKER_DEADLINE_MS
    for (;;) {
      const value = await readFile(marker, 'utf8').then(text => text, () => undefined)
      if (value !== undefined) return value
      if (Date.now() >= deadline) return undefined
      await Bun.sleep(25)
    }
  }

  test('stops the process and leaves no record latched running', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'nessy-p223-store-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({ store, graceMs: 20, resolveIsolation: isolationFree })
      const sessionKey = { workspaceId: 'ws', sessionId: 'claude-holder' }
      const marker = join(root, 'monitor-marker')
      const started = await startMonitorShapedProcess(supervisor, sessionKey, marker)

      // The rig can see a live process at all: the record says so and the store
      // counts it. Without this the assertions below would also pass on a
      // process that never started.
      expect((await store.get(started.handle)).status).toBe('running')
      expect(await store.countRunning(sessionKey)).toBe(1)

      const manager = disposeManager(supervisor)
      const managed = managedSession('claude-holder')
      await manager.disposeManagedAgentRuntime(managed, 'live-agent ceiling', true)

      // The RECORD moved. `stopped` is a terminal the retention sweep no longer
      // has to be the one to write.
      expect((await store.get(started.handle)).status).toBe('stopped')
      expect(await store.countRunning(sessionKey)).toBe(0)
      expect(managed.agent).toBeNull()

      // And the WORK stopped: the marker is what the process would have written
      // had the drain not reached it. The WHOLE deadline is waited out here —
      // an absence claim that gives up early is an absence of waiting.
      expect(await markerWithinDeadline(marker)).toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  }, MARKER_CASE_BUDGET_MS)

  test('the same process left undisposed does write its marker', async () => {
    // The positive control for the absence above, on the same rig: the marker
    // path, the deadline and the store are identical, and only the dispose is
    // gone.
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'nessy-p223-control-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({ store, graceMs: 20, resolveIsolation: isolationFree })
      const sessionKey = { workspaceId: 'ws', sessionId: 'claude-control' }
      const marker = join(root, 'monitor-marker')
      const started = await startMonitorShapedProcess(supervisor, sessionKey, marker)

      expect(await markerWithinDeadline(marker)).toBe('still-running')
      await supervisor.stop({ sessionKey, handle: started.handle })
    } finally { await rm(root, { recursive: true, force: true }) }
  }, MARKER_CASE_BUDGET_MS)

  test('a session holding nothing disposes clean, and a Pi one is unchanged', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'nessy-p223-empty-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({ store, graceMs: 20, resolveIsolation: isolationFree })
      const manager = disposeManager(supervisor)
      // The empty drain every idle Pi session already paid, now paid by claude
      // too: it must not turn a clean teardown into a strict failure.
      const claude = managedSession('claude-empty')
      await manager.disposeManagedAgentRuntime(claude, 'live-agent ceiling', true)
      expect(claude.agent).toBeNull()

      // The Pi control, through the same code with the provider answered 'pi'.
      manager.resolveManagedProvider = mock(() => 'pi')
      const pi = managedSession('pi-empty')
      const key = { workspaceId: 'ws', sessionId: 'pi-empty' }
      const started = await startMonitorShapedProcess(supervisor, key, join(root, 'pi-marker'))
      await manager.disposeManagedAgentRuntime(pi, 'live-agent ceiling', true)
      expect((await store.get(started.handle)).status).toBe('stopped')
      expect(await store.countRunning(key)).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
