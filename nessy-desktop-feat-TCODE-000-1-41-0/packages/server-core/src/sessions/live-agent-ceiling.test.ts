import { describe, expect, test } from 'bun:test'
import { maxConcurrentSubagents } from '@nessy-agent/shared/config/subagent-limits'
import {
  DEFAULT_IDLE_AGENT_SWEEP_MS,
  DEFAULT_IDLE_AGENT_TTL_MS,
  defaultLiveAgentCeiling,
  liveAgentBusyDomains,
  liveAgentCeilingRefusal,
  resolveIdleAgentReaping,
  resolveIdleAgentSweepMs,
  resolveIdleAgentTtlMs,
  resolveLiveAgentAdmission,
  resolveLiveAgentCeiling,
  type IdleAgentCandidate,
  type LiveAgentBusyInputsV1,
  type LiveAgentCandidate,
} from './live-agent-ceiling.ts'

const candidate = (
  key: string,
  lastUsedAt: number,
  busy = false,
): LiveAgentCandidate => ({ key, lastUsedAt, busy })

const IDLE_INPUTS: LiveAgentBusyInputsV1 = Object.freeze({
  foregroundTurn: false,
  backendTurn: false,
  activeChildren: 0,
  activeProcesses: 0,
  activeWorkflowEvaluators: 0,
  backgroundShells: 0,
  backendBackgroundTasks: 0,
  pendingPermissions: 0,
  pendingAskUser: 0,
})

const reapable = (key: string, lastActiveAt: number, overrides: Partial<IdleAgentCandidate> = {}): IdleAgentCandidate =>
  ({ key, lastActiveAt, busy: false, holdsWakePath: false, ...overrides })

describe('live-agent ceiling', () => {
  test('evicts the least recently used idle agent and never a busy one', () => {
    const candidates = [
      candidate('oldest-but-busy', 1, true),
      candidate('idle-old', 2),
      candidate('idle-new', 3),
    ]

    // Under the ceiling: nothing to do.
    expect(resolveLiveAgentAdmission({ candidates, admitting: 'new', ceiling: 4 }))
      .toEqual({ decision: 'admit' })

    // At the ceiling: the oldest IDLE agent goes, not the oldest agent. Getting
    // this the other way round is exactly the silent dropped turn.
    expect(resolveLiveAgentAdmission({ candidates, admitting: 'new', ceiling: 3 }))
      .toEqual({ decision: 'admit-after-eviction', evict: ['idle-old'] })

    // Two over: both idle ones, oldest first.
    expect(resolveLiveAgentAdmission({ candidates, admitting: 'new', ceiling: 2 }))
      .toEqual({ decision: 'admit-after-eviction', evict: ['idle-old', 'idle-new'] })

    // A session refreshing its OWN runtime is not a new occupant, so a host
    // sitting exactly at the ceiling still answers its next send.
    expect(resolveLiveAgentAdmission({ candidates, admitting: 'idle-new', ceiling: 3 }))
      .toEqual({ decision: 'admit' })
  })

  test('refuses rather than evicting a turn in flight, and says what is holding it', () => {
    const candidates = [candidate('busy-a', 1, true), candidate('busy-b', 2, true)]
    const refusal = resolveLiveAgentAdmission({ candidates, admitting: 'new', ceiling: 2 })
    expect(refusal).toEqual({ decision: 'refuse', live: 2, busy: 2 })
    const message = liveAgentCeilingRefusal({ live: 2, busy: 2, ceiling: 2 })
    expect(message).toStartWith('live-agent-ceiling-reached:')
    // "mid-turn" was a lie once the predicate widened: a background task is not
    // a turn, and telling the user to wait for one they cannot see is worse than
    // saying nothing.
    expect(message).toContain('2 of them are still holding work')
    expect(message).toContain('Wait for a running turn or background task to finish')

    // One idle is enough for a one-over request; one idle is NOT enough for
    // two-over, and the partial set is refused rather than half-applied.
    const mixed = [candidate('busy', 1, true), candidate('idle', 2)]
    expect(resolveLiveAgentAdmission({ candidates: mixed, admitting: 'new', ceiling: 2 }))
      .toEqual({ decision: 'admit-after-eviction', evict: ['idle'] })
    expect(resolveLiveAgentAdmission({ candidates: mixed, admitting: 'new', ceiling: 1 }))
      .toEqual({ decision: 'refuse', live: 2, busy: 1 })
  })

  test('breaks a same-millisecond tie deterministically', () => {
    // Two sessions can share a timestamp, and an unreproducible victim is an
    // unreproducible bug report.
    const candidates = [candidate('b', 5), candidate('a', 5)]
    expect(resolveLiveAgentAdmission({ candidates, admitting: 'new', ceiling: 2 }))
      .toEqual({ decision: 'admit-after-eviction', evict: ['a'] })
  })

  test('scales the ceiling with installed memory and never drops below a parent plus child', () => {
    expect(defaultLiveAgentCeiling(64 * 1024 ** 3)).toBe(32)
    expect(defaultLiveAgentCeiling(16 * 1024 ** 3)).toBe(8)
    // A 2 GiB host would compute 1, which would refuse every Pi child session.
    expect(defaultLiveAgentCeiling(2 * 1024 ** 3)).toBe(2)
    expect(defaultLiveAgentCeiling(0)).toBe(2)
    expect(defaultLiveAgentCeiling()).toBeGreaterThanOrEqual(2)
  })

  test('stays strictly above the concurrent-subagent ceiling, so the memory gate never speaks first', () => {
    // The whole point of `resolveLiveAgentCeiling`: an Agent-tool spawn must be
    // refused by the documented `Concurrent subagent limit reached`, not by this
    // module's `live-agent-ceiling-reached` — which for a background child would
    // arrive asynchronously as a FAILED subagent rather than a refused spawn.
    for (const memory of [4, 8, 16, 64].map(gib => gib * 1024 ** 3)) {
      expect(resolveLiveAgentCeiling({}, memory))
        .toBeGreaterThan(maxConcurrentSubagents({}, memory))
    }
    // An operator who raises the subagent ceiling raises this one with it.
    const raised = { NESSY_MAX_CONCURRENT_SUBAGENTS: '40' }
    expect(resolveLiveAgentCeiling(raised, 16 * 1024 ** 3)).toBe(41)
    // ...and never lowers it below the memory bound.
    expect(resolveLiveAgentCeiling({ NESSY_MAX_CONCURRENT_SUBAGENTS: '2' }, 64 * 1024 ** 3)).toBe(32)
  })
})

describe('what counts as busy', () => {
  test('a session holding only background work is busy, and the presence proves the absence', () => {
    // THE CONTROL. The same shape with every count at zero is NOT busy, so the
    // findings below are the predicate answering rather than the predicate
    // always answering yes.
    expect(liveAgentBusyDomains(IDLE_INPUTS)).toEqual([])

    // Each of these reads `isProcessing === false` — the eviction predicate
    // before L3 — and each is work a dispose destroys.
    expect(liveAgentBusyDomains({ ...IDLE_INPUTS, activeChildren: 1 })).toEqual(['child'])
    expect(liveAgentBusyDomains({ ...IDLE_INPUTS, activeProcesses: 2 })).toEqual(['process'])
    expect(liveAgentBusyDomains({ ...IDLE_INPUTS, activeWorkflowEvaluators: 1 })).toEqual(['workflow_evaluator'])
    expect(liveAgentBusyDomains({ ...IDLE_INPUTS, backgroundShells: 1 })).toEqual(['background_shell'])
    // L5 — the backend's OWN background work, which no host map records for
    // Claude. Everything else here is fed by a Pi-written map, so without this
    // input a Claude session running a background subagent read as fully idle.
    expect(liveAgentBusyDomains({ ...IDLE_INPUTS, backendBackgroundTasks: 1 })).toEqual(['background_task'])
    expect(liveAgentBusyDomains({ ...IDLE_INPUTS, pendingPermissions: 1 })).toEqual(['permission'])
    expect(liveAgentBusyDomains({ ...IDLE_INPUTS, pendingAskUser: 1 })).toEqual(['ask_user'])

    // The backend turn is its own input, not a synonym for the host's flag: L2
    // made `ClaudeAgent.isProcessing()` the open turn SLOT, and the two disagree
    // at both edges of a turn.
    expect(liveAgentBusyDomains({ ...IDLE_INPUTS, backendTurn: true })).toEqual(['backend_turn'])
    expect(liveAgentBusyDomains({ ...IDLE_INPUTS, foregroundTurn: true })).toEqual(['foreground_turn'])

    // Every domain reported, in a stable order, so a refusal can name them all.
    expect(liveAgentBusyDomains({
      foregroundTurn: true,
      backendTurn: true,
      activeChildren: 1,
      activeProcesses: 1,
      activeWorkflowEvaluators: 1,
      backgroundShells: 1,
      backendBackgroundTasks: 1,
      pendingPermissions: 1,
      pendingAskUser: 1,
    })).toEqual([
      'foreground_turn', 'backend_turn', 'child', 'process',
      'workflow_evaluator', 'background_shell', 'background_task', 'permission', 'ask_user',
    ])
  })

  test('a nonsense count throws rather than rounding down to idle', () => {
    // Rounding a bad count down to "not busy" is the failure direction that
    // kills a running task; `session-settlement.ts` refuses it for the same
    // reason and this predicate must not be the softer of the two.
    expect(() => liveAgentBusyDomains({ ...IDLE_INPUTS, activeChildren: -1 }))
      .toThrow('live-agent-busy-invalid-count:activeChildren')
    expect(() => liveAgentBusyDomains({ ...IDLE_INPUTS, activeProcesses: 1.5 }))
      .toThrow('live-agent-busy-invalid-count:activeProcesses')
    expect(() => liveAgentBusyDomains({ ...IDLE_INPUTS, pendingAskUser: Number.NaN }))
      .toThrow('live-agent-busy-invalid-count:pendingAskUser')
  })
})

describe('the idle reaper policy', () => {
  const TTL = 30 * 60_000

  test('reaps an idle agent and never a busy one, on the same rig', () => {
    const now = 10_000_000
    const candidates = [
      reapable('idle', now - TTL),
      reapable('busy', now - TTL * 10, { busy: true }),
      reapable('fresh', now - TTL + 1),
    ]
    // The absence ('busy' and 'fresh' survive) has a presence ('idle' goes) in
    // the same call, so this is the policy discriminating rather than the policy
    // doing nothing.
    expect(resolveIdleAgentReaping({ candidates, now, idleAfterMs: TTL }))
      .toEqual({ reap: ['idle'] })

    // The busy one is the OLDEST by ten idle windows, so age is not what saved
    // the other two.
    expect(resolveIdleAgentReaping({ candidates: [candidates[1]!], now, idleAfterMs: TTL }))
      .toEqual({ reap: [] })
  })

  test('never reaps a session whose wake path the dispose would take', () => {
    const now = 10_000_000
    const deaf = reapable('has-channel-subscription', now - TTL * 5, { holdsWakePath: true })
    // Idle for five windows and holding nothing — the only thing keeping it is
    // that reaping it would not hibernate it, it would make it deaf until a
    // human types. The control is the same candidate without the wake path.
    expect(resolveIdleAgentReaping({ candidates: [deaf], now, idleAfterMs: TTL }))
      .toEqual({ reap: [] })
    expect(resolveIdleAgentReaping({
      candidates: [{ ...deaf, holdsWakePath: false }],
      now,
      idleAfterMs: TTL,
    })).toEqual({ reap: ['has-channel-subscription'] })
  })

  test('a disabled or nonsense window reaps nothing, and a future clock is not idle', () => {
    const now = 10_000_000
    const stale = [reapable('a', 0), reapable('b', 0)]
    // The operator's off switch must not be spelled "reap everything".
    expect(resolveIdleAgentReaping({ candidates: stale, now, idleAfterMs: 0 })).toEqual({ reap: [] })
    expect(resolveIdleAgentReaping({ candidates: stale, now, idleAfterMs: -1 })).toEqual({ reap: [] })
    expect(resolveIdleAgentReaping({ candidates: stale, now, idleAfterMs: Number.NaN })).toEqual({ reap: [] })
    // ...and with a real window those same two DO go, so the three above are the
    // switch working rather than the candidates being unreapable.
    expect(resolveIdleAgentReaping({ candidates: stale, now, idleAfterMs: TTL })).toEqual({ reap: ['a', 'b'] })

    // A clock that stepped backwards, or a restored header from the future,
    // reads as not-idle instead of instantly reapable.
    expect(resolveIdleAgentReaping({
      candidates: [reapable('future', now + 60_000)],
      now,
      idleAfterMs: TTL,
    })).toEqual({ reap: [] })
    expect(resolveIdleAgentReaping({
      candidates: [reapable('no-clock', Number.NaN)],
      now,
      idleAfterMs: TTL,
    })).toEqual({ reap: [] })
  })

  test('reads its window from the environment and falls back rather than to zero', () => {
    expect(resolveIdleAgentTtlMs({})).toBe(DEFAULT_IDLE_AGENT_TTL_MS)
    expect(resolveIdleAgentTtlMs({ NESSY_IDLE_AGENT_TTL_MS: '90000' })).toBe(90_000)
    // `0` is the documented off switch and must survive the parser.
    expect(resolveIdleAgentTtlMs({ NESSY_IDLE_AGENT_TTL_MS: '0' })).toBe(0)
    // Garbage falls back to the default, never to 0 (which would silently
    // disable the reaper) and never to a tiny number (which would reap live
    // sessions) — the trap AGENTS.md records as "a narrowing knob set too
    // aggressively manufactures its own failure".
    expect(resolveIdleAgentTtlMs({ NESSY_IDLE_AGENT_TTL_MS: 'soon' })).toBe(DEFAULT_IDLE_AGENT_TTL_MS)
    expect(resolveIdleAgentTtlMs({ NESSY_IDLE_AGENT_TTL_MS: '-5' })).toBe(DEFAULT_IDLE_AGENT_TTL_MS)

    expect(resolveIdleAgentSweepMs({})).toBe(DEFAULT_IDLE_AGENT_SWEEP_MS)
    expect(resolveIdleAgentSweepMs({ NESSY_IDLE_AGENT_SWEEP_MS: '5000' })).toBe(5_000)
    // A zero sweep would be a busy loop, so the sweep has no off switch — the
    // TTL is where "off" lives.
    expect(resolveIdleAgentSweepMs({ NESSY_IDLE_AGENT_SWEEP_MS: '0' })).toBe(DEFAULT_IDLE_AGENT_SWEEP_MS)
  })
})
