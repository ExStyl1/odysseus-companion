import { describe, expect, it } from 'bun:test'
import type { PiWorktreeLeaseStateV1, PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import { WorktreeLeaseService } from './worktree-lease-service'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-07-27T12:00:00.000Z')
const CUTOFF = NOW - (30 * DAY_MS)

function daysAgo(days: number): string {
  return new Date(NOW - (days * DAY_MS)).toISOString()
}

function lease(
  worktreeLeaseId: string,
  options: { lastUsedAt?: string; permanent?: boolean } = {},
): PiWorktreeLeaseV1 {
  return {
    schemaVersion: 1,
    worktreeLeaseId,
    workspaceId: 'w1',
    ownerAgentId: `agent-${worktreeLeaseId}`,
    path: `/repo/.nessy-worktrees/proj/${worktreeLeaseId}`,
    branch: `nessy/agent/${worktreeLeaseId}`,
    baseSha: 'base-sha',
    status: 'active',
    ...(options.lastUsedAt === undefined ? {} : { lastUsedAt: options.lastUsedAt }),
    ...(options.permanent ? { permanent: true } : {}),
  }
}

interface GitState {
  exists?: boolean
  dirty?: boolean
  /** The worktree's CURRENT head. Drift from the lease's baseSha means new commits. */
  head?: string
}

function build(leases: PiWorktreeLeaseV1[], git: Record<string, GitState> = {}) {
  const removed: string[] = []
  const emitted: string[] = []
  const persisted: PiWorktreeLeaseStateV1[] = []
  const initialState: PiWorktreeLeaseStateV1 = { schemaVersion: 1, revision: 1, leases }
  const service = new WorktreeLeaseService({
    workspaceId: 'w1',
    initialState,
    persist: async state => { persisted.push(structuredClone(state)) },
    policy: { select: async () => ({ path: '/repo/.nessy-worktrees/proj/new', branch: 'nessy/agent/new', baseSha: 'base-sha' }) },
    git: {
      create: async () => {},
      inspect: async value => {
        const state = git[value.worktreeLeaseId] ?? {}
        return {
          exists: state.exists ?? true,
          dirty: state.dirty ?? false,
          branch: value.branch,
          baseSha: state.head ?? value.baseSha,
        }
      },
      remove: async value => { removed.push(value.worktreeLeaseId) },
    },
    emit: event => { emitted.push(event) },
  })
  return { service, removed, emitted, persisted }
}

describe('orphaned-worktree sweep on the retention cutoff', () => {
  it('removes an old orphan and reports it', async () => {
    const { service, removed, emitted } = build([lease('old', { lastUsedAt: daysAgo(90) })])

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed).toEqual([{
      worktreeLeaseId: 'old',
      path: '/repo/.nessy-worktrees/proj/old',
      lastUsedAt: daysAgo(90),
    }])
    expect(result.skipped).toEqual([])
    // Removal goes through the production release path, so git actually ran and
    // WorktreeRemove actually fired.
    expect(removed).toEqual(['old'])
    expect(emitted).toEqual(['WorktreeRemove'])
    expect(service.list()).toEqual([])
  })

  it('never removes a live-leased worktree, regardless of age', async () => {
    const { service, removed } = build([lease('live', { lastUsedAt: daysAgo(3650) })])

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: ['live'] })

    expect(result.removed).toEqual([])
    expect(result.skipped).toEqual([{
      worktreeLeaseId: 'live', path: '/repo/.nessy-worktrees/proj/live',
      branch: 'nessy/agent/live', reason: 'live-lease',
    }])
    expect(removed).toEqual([])
    expect(service.list()).toHaveLength(1)
  })

  it('never removes a lease with NO lastUsedAt — absent is unknown, not epoch', async () => {
    // Every lease persisted before R2 added the field has none. Reading absent
    // as "infinitely old" would delete all of them on the first launch after
    // this ships.
    const { service, removed } = build([lease('legacy')])

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed).toEqual([])
    expect(result.skipped).toEqual([{
      worktreeLeaseId: 'legacy', path: '/repo/.nessy-worktrees/proj/legacy',
      branch: 'nessy/agent/legacy', reason: 'unknown-last-used',
    }])
    expect(removed).toEqual([])
    expect(service.list()).toHaveLength(1)
  })

  it('never removes a lease whose lastUsedAt will not parse', async () => {
    const { service } = build([lease('garbage', { lastUsedAt: 'not-a-date' })])
    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })
    expect(result.skipped.map(entry => entry.reason)).toEqual(['unknown-last-used'])
  })

  it('keeps a recently touched lease', async () => {
    const { service, removed } = build([lease('recent', { lastUsedAt: daysAgo(1) })])

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed).toEqual([])
    expect(result.skipped.map(entry => entry.reason)).toEqual(['recently-used'])
    expect(removed).toEqual([])
  })

  const holdsWork = [
    { name: 'changed or untracked files', git: { dirty: true }, reason: 'dirty' },
    { name: 'commits nobody pushed', git: { head: 'moved-past-base' }, reason: 'holds-commits' },
  ] as const

  for (const testCase of holdsWork) {
    it(`skips an old orphan holding work: ${testCase.name}`, async () => {
      const { service, removed } = build(
        [lease('busy', { lastUsedAt: daysAgo(90) })],
        { busy: testCase.git },
      )

      const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

      expect(result.removed).toEqual([])
      // P6.22 — the branch rides the skip, because the notice this feeds needs
      // it: it is the only handle the user has on the work being kept.
      expect(result.skipped).toEqual([{
        worktreeLeaseId: 'busy', path: '/repo/.nessy-worktrees/proj/busy',
        branch: 'nessy/agent/busy', reason: testCase.reason,
      }])
      expect(removed).toEqual([])
      expect(service.list()).toHaveLength(1)
    })
  }

  /**
   * P6.21. The record was kept forever before this — nothing else removes a
   * lease, and `recover()` runs straight after this pass and throws
   * `worktree-missing` for an `active` lease whose worktree has vanished, so the
   * stale record the sweep exists to clear was the one that broke the next start.
   */
  it('reclaims the lease of a vanished worktree, without calling git', async () => {
    const { service, removed, emitted } = build(
      [lease('gone', { lastUsedAt: daysAgo(90) })],
      { gone: { exists: false } },
    )

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed).toEqual([{
      worktreeLeaseId: 'gone',
      path: '/repo/.nessy-worktrees/proj/gone',
      lastUsedAt: daysAgo(90),
    }])
    expect(result.skipped).toEqual([])
    expect(service.list()).toEqual([])
    // Nothing was removed, so no `git worktree remove` and no `WorktreeRemove`.
    expect(removed).toEqual([])
    expect(emitted).toEqual([])
  })

  /**
   * The reclaim's whole point: the pass that runs immediately before `recover()`
   * has to leave a state `recover()` can accept.
   */
  it('leaves a vanished worktree in a state recover() no longer refuses', async () => {
    const { service } = build(
      [lease('gone', { lastUsedAt: daysAgo(90) })],
      { gone: { exists: false } },
    )

    await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(await service.recover()).toEqual([])
  })

  /**
   * A vanished worktree that is NOT a candidate — live, or inside the retention
   * window — is untouched. The reclaim is the retention pass's decision about an
   * orphan, never a rule about missing directories in general.
   */
  it('never reclaims a vanished worktree the age rules kept', async () => {
    const { service } = build(
      [lease('recent-gone', { lastUsedAt: daysAgo(1) })],
      { 'recent-gone': { exists: false } },
    )

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed).toEqual([])
    expect(result.skipped.map(entry => entry.reason)).toEqual(['recently-used'])
    expect(service.list()).toHaveLength(1)
  })

  it('a dry run reports the vanished lease it would reclaim and keeps it', async () => {
    const { service } = build(
      [lease('gone', { lastUsedAt: daysAgo(90) })],
      { gone: { exists: false } },
    )

    const dry = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [], dryRun: true })

    expect(dry.removed.map(entry => entry.worktreeLeaseId)).toEqual(['gone'])
    expect(service.list()).toHaveLength(1)
  })

  it('a dry run removes nothing and reports exactly what a real run removes', async () => {
    const leases = [
      lease('old-a', { lastUsedAt: daysAgo(90) }),
      lease('old-b', { lastUsedAt: daysAgo(40) }),
      lease('recent', { lastUsedAt: daysAgo(1) }),
      lease('legacy'),
    ]
    const dryService = build(leases.map(entry => ({ ...entry })))
    const dry = await dryService.service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [], dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dryService.removed).toEqual([])
    expect(dryService.service.list()).toHaveLength(4)

    const realService = build(leases.map(entry => ({ ...entry })))
    const real = await realService.service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(real.removed).toEqual(dry.removed)
    expect(real.skipped).toEqual(dry.skipped)
    expect(real.removed.map(entry => entry.worktreeLeaseId)).toEqual(['old-a', 'old-b'])
    expect(realService.removed).toEqual(['old-a', 'old-b'])
    expect(realService.service.list().map(entry => entry.worktreeLeaseId)).toEqual(['recent', 'legacy'])
  })

  it('a user-created worktree has no lease, so the sweep never sees it', async () => {
    // "It never removes worktrees you create with --worktree." The service is
    // the only writer of leases and the sweep walks leases only, so this holds
    // by construction — pinned here so a future directory-walking rewrite fails.
    const { service, removed } = build([])
    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })
    expect(result.removed).toEqual([])
    expect(result.skipped).toEqual([])
    expect(removed).toEqual([])
  })
})

/**
 * P6.21 — "one sweep, three runtimes", checked rather than assumed, and the
 * half that is still open named beside it.
 *
 * THE RUNTIME ASYMMETRY IS CLOSED, and the evidence is structural rather than
 * anecdotal: there is no provider branch anywhere on this path — not in
 * `sweepOrphansUnlocked`, not in `planWorktreeOrphanSweep`, not on
 * `PiWorktreeLeaseV1`, which records an `ownerAgentId` and no runtime at all —
 * and all three of `sweepOrphanedWorktrees`' call sites in `SessionManager` are
 * provider-agnostic creation seams: the Pi child-session port, the host
 * `EnterWorktree` creation seam every runtime reaches (`bfa1ea427`, which the
 * scheduled-task path goes through), and the SDK `WorktreeCreate` port used for
 * subagent isolation and background sessions (`d5d88eaae`). The release half is
 * the strict drain's, and it stopped branching on provider in `bfa1ea427`.
 *
 * WHAT IS STILL OPEN IS SCOPE, NOT RUNTIME, and it is why the sweep cannot be
 * the answer for a scheduled task: the ledger a sweep walks is ONE SESSION's
 * (`initialState: managed.worktreeLeaseState`), while every worktree of a
 * project shares one namespace root on disk. A scheduled task creates a NEW
 * session per run, so run #2's sweep opens an empty ledger and run #1's worktree
 * is unreachable from it — forever, if that session is never reopened and the
 * drain never runs (a crash, a force quit, an evicted session). The drain is
 * what actually reclaims these, exactly as `strictDrainSessionForMutation`'s own
 * comment says; the sweep is a belt whose reach stops at the session boundary.
 * The second test below is that boundary, pinned so nobody reads the first one
 * as more than it is.
 */
describe('P6.21 — the sweep is provider-blind, and session-scoped', () => {
  /** A lease as each runtime's creation seam writes it: same shape, different owner. */
  function runtimeLease(worktreeLeaseId: string, ownerAgentId: string): PiWorktreeLeaseV1 {
    return { ...lease(worktreeLeaseId, { lastUsedAt: daysAgo(90) }), ownerAgentId }
  }

  it('reclaims every aged lease by name, whichever runtime created it', async () => {
    // The owner ids are the ones the three seams actually mint: `session-<id>`
    // from the host EnterWorktree port (which is also what a scheduled task's
    // `automation-<matcher>-<session>` becomes), the hook's `name` slug from the
    // SDK WorktreeCreate port, and Pi's own agent id.
    const { service, removed } = build([
      runtimeLease('pi-child', 'pi-agent-7'),
      runtimeLease('claude-subagent', 'bold-oak-a3f2'),
      runtimeLease('automation-run', 'automation-nightly-sess42'),
    ])

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed.map(entry => entry.worktreeLeaseId))
      .toEqual(['pi-child', 'claude-subagent', 'automation-run'])
    expect(result.removed.map(entry => entry.path)).toEqual([
      '/repo/.nessy-worktrees/proj/pi-child',
      '/repo/.nessy-worktrees/proj/claude-subagent',
      '/repo/.nessy-worktrees/proj/automation-run',
    ])
    expect(result.skipped).toEqual([])
    // Reclaimed through the production release path, so git really ran for each.
    expect(removed).toEqual(['pi-child', 'claude-subagent', 'automation-run'])
    expect(service.list()).toEqual([])
  })

  it('cannot see another session\'s lease, even in the same namespace root', async () => {
    // Run #1's worktree, aged past the cutoff and still leased.
    const runOne = build([runtimeLease('automation-run-1', 'automation-nightly-sess41')])
    // Run #2 is a different session, so its ledger is empty — this is what the
    // creation-seam belt actually sweeps on a scheduled task, and the answer is
    // nothing. Not a bug in the sweep: a bound on it, and the reason the drain
    // is the fix and this is the belt.
    const runTwo = build([])

    const swept = await runTwo.service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(swept.removed).toEqual([])
    expect(swept.skipped).toEqual([])
    expect(runTwo.removed).toEqual([])
    // Run #1's lease is untouched, and reclaimable only from run #1's own ledger.
    expect(runOne.service.list().map(entry => entry.worktreeLeaseId)).toEqual(['automation-run-1'])
    const fromItsOwnSession = await runOne.service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })
    expect(fromItsOwnSession.removed.map(entry => entry.worktreeLeaseId)).toEqual(['automation-run-1'])
    expect(runOne.removed).toEqual(['automation-run-1'])
  })
})

/**
 * P6.136 — the candidate set was ONE session's ledger, so a scheduled task's
 * per-run worktrees were unreachable and leaked.
 *
 * A scheduled task makes a new session per run: run #2 planned over an empty
 * ledger while run #1's worktree sat on disk with nobody able to see it. None of
 * the git-lock arms widened the set — they only ever decided what to SKIP among
 * candidates — so the fix is the input, and every refusal below is the existing
 * one applied to a wider set.
 */
describe('P6.136 · foreign leases as sweep candidates', () => {
  it("reclaims another session's aged worktree, and does not write our ledger for it", async () => {
    // The row's own done_means, in the unit: run #2 reclaims run #1's worktree.
    const { service, removed, persisted } = build([], { 'run-1': { exists: true } })

    const result = await service.sweepOrphans({
      cutoffMs: CUTOFF,
      liveLeaseIds: [],
      foreignLeases: [lease('run-1', { lastUsedAt: daysAgo(90) })],
    })

    expect(result.removed.map(entry => entry.worktreeLeaseId)).toEqual(['run-1'])
    // The directory and branch really went through git.
    expect(removed).toEqual(['run-1'])
    // …and OUR ledger was never written: the record belongs to another
    // session's file, which collects it on its own next sweep.
    expect(persisted).toEqual([])
  })

  it('KEEPS a foreign lease some session in this process is holding', async () => {
    // The control that decides whether this row is safe. The git interlock
    // cannot supply it: a sibling session in THIS process locks under THIS pid,
    // and the sweep treats a lock naming this process as stale by construction.
    // So the live set must be process-wide, and this is the assertion that says
    // so — without it the sweep removes a running sibling's worktree.
    const { service, removed } = build([])

    const result = await service.sweepOrphans({
      cutoffMs: CUTOFF,
      liveLeaseIds: ['run-2'],
      foreignLeases: [lease('run-2', { lastUsedAt: daysAgo(90) })],
    })

    expect(result.removed).toEqual([])
    expect(result.skipped).toEqual([
      { worktreeLeaseId: 'run-2', path: '/repo/.nessy-worktrees/proj/run-2', branch: 'nessy/agent/run-2', reason: 'live-lease' },
    ])
    expect(removed).toEqual([])
  })

  it('still refuses a foreign worktree that holds work — the refusals are not per-owner', async () => {
    // Both work-holding refusals, applied to somebody else's worktree. A widened
    // candidate set that dropped them would delete the very thing the sweep
    // exists to protect.
    const { service, removed } = build([], {
      'dirty-run': { dirty: true },
      'committed-run': { head: 'moved-sha' },
    })

    const result = await service.sweepOrphans({
      cutoffMs: CUTOFF,
      liveLeaseIds: [],
      foreignLeases: [
        lease('dirty-run', { lastUsedAt: daysAgo(90) }),
        lease('committed-run', { lastUsedAt: daysAgo(90) }),
      ],
    })

    expect(result.removed).toEqual([])
    expect(result.skipped.map(skip => skip.reason).sort()).toEqual(['dirty', 'holds-commits'])
    // The branch is joined on for a foreign lease too — it is the handle the
    // user has on the work, and P6.22's announcement reads it.
    expect(result.skipped.every(skip => skip.branch.length > 0)).toBe(true)
    expect(removed).toEqual([])
  })

  it("reports a foreign lease whose directory is gone rather than claiming a reclaim", async () => {
    // The record is another session's file; this pass can neither remove a
    // directory that is not there nor edit that file. Saying "reclaimed" would
    // claim a write it cannot make.
    const { service, removed, persisted } = build([], { 'gone-run': { exists: false } })

    const result = await service.sweepOrphans({
      cutoffMs: CUTOFF,
      liveLeaseIds: [],
      foreignLeases: [lease('gone-run', { lastUsedAt: daysAgo(90) })],
    })

    expect(result.removed).toEqual([])
    expect(result.skipped.map(skip => skip.reason)).toEqual(['foreign-record'])
    expect(removed).toEqual([])
    expect(persisted).toEqual([])
  })

  it('never lets a stale foreign copy shadow the lease this service owns', async () => {
    // Ours first, deliberately: a caller's copy of a lease we hold is by
    // definition older than our own, and letting it win would plan over stale
    // state — including a `lastUsedAt` we have since refreshed.
    const { service, removed, persisted } = build([lease('shared', { lastUsedAt: daysAgo(90) })])

    const result = await service.sweepOrphans({
      cutoffMs: CUTOFF,
      liveLeaseIds: [],
      foreignLeases: [{ ...lease('shared', { lastUsedAt: daysAgo(90) }), branch: 'stale/copy' }],
    })

    expect(result.removed.map(entry => entry.worktreeLeaseId)).toEqual(['shared'])
    expect(removed).toEqual(['shared'])
    // Our ledger IS written for our own lease — the half the foreign path skips.
    expect(persisted.at(-1)?.leases).toEqual([])
  })

  it('sweeps exactly as before when no foreign lease is offered', async () => {
    // The regression control: every existing caller passes no `foreignLeases`,
    // and this row must be invisible to them.
    const { service, removed } = build([
      lease('old', { lastUsedAt: daysAgo(90) }),
      lease('fresh', { lastUsedAt: daysAgo(1) }),
    ])

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed.map(entry => entry.worktreeLeaseId)).toEqual(['old'])
    expect(result.skipped.map(skip => skip.reason)).toEqual(['recently-used'])
    expect(removed).toEqual(['old'])
  })
})

/**
 * P6.336 — the operator's policy, and the whole reason the row exists:
 * "a sweep with no operator-visible policy is a control the operator can
 * neither see nor stop."
 *
 * Every exemption below is REPORTED as a skip with its own reason rather than
 * filtered away, so `skipped` is a list a caller can render.
 */
describe('P6.336 · the operator worktree retention policy', () => {
  it('removes nothing at all when automatic deletion is off, and says so per candidate', async () => {
    const { service, removed } = build([
      lease('old', { lastUsedAt: daysAgo(90) }),
      lease('older', { lastUsedAt: daysAgo(120) }),
    ])
    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [], autoRemove: false })
    expect(removed).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.skipped.filter(skip => skip.reason === 'auto-remove-off').map(skip => skip.worktreeLeaseId).sort())
      .toEqual(['old', 'older'])
  })

  it('keeps the newest N when a retention count is set, and removes the rest', async () => {
    const { service, removed } = build([
      lease('a', { lastUsedAt: daysAgo(40) }),
      lease('b', { lastUsedAt: daysAgo(90) }),
      lease('c', { lastUsedAt: daysAgo(120) }),
    ])
    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [], retainCount: 2 })
    // Newest first: `a` and `b` are kept, `c` goes.
    expect(result.skipped.filter(skip => skip.reason === 'retained').map(skip => skip.worktreeLeaseId).sort())
      .toEqual(['a', 'b'])
    expect(removed).toEqual(['c'])
  })

  it('a permanent worktree is exempt BY NAME, whatever its age', async () => {
    const { service, removed } = build([
      lease('keep-me', { lastUsedAt: daysAgo(365), permanent: true }),
      lease('ordinary', { lastUsedAt: daysAgo(365) }),
    ])
    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })
    expect(result.skipped.filter(skip => skip.reason === 'permanent').map(skip => skip.worktreeLeaseId))
      .toEqual(['keep-me'])
    expect(removed).toEqual(['ordinary'])
  })

  // The count is applied to what is LEFT after the permanent exemptions: a
  // permanent worktree is not one of the N a retention count decides about.
  it('a permanent worktree does not consume a retention slot', async () => {
    const { service, removed } = build([
      lease('perm', { lastUsedAt: daysAgo(40), permanent: true }),
      lease('a', { lastUsedAt: daysAgo(90) }),
      lease('b', { lastUsedAt: daysAgo(120) }),
    ])
    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [], retainCount: 1 })
    expect(result.skipped.filter(skip => skip.reason === 'permanent').map(skip => skip.worktreeLeaseId)).toEqual(['perm'])
    expect(result.skipped.filter(skip => skip.reason === 'retained').map(skip => skip.worktreeLeaseId)).toEqual(['a'])
    expect(removed).toEqual(['b'])
  })

  // NEGATIVE — a caller that passes no policy sweeps exactly as it always did.
  // Both keys are optional and absent by default.
  it('a sweep given no policy behaves exactly as before', async () => {
    const { service, removed } = build([lease('old', { lastUsedAt: daysAgo(90) })])
    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })
    expect(removed).toEqual(['old'])
    expect(result.skipped.filter(skip =>
      skip.reason === 'auto-remove-off' || skip.reason === 'retained' || skip.reason === 'permanent')).toEqual([])
  })

  // NEGATIVE — `retainCount: 0` is "keep nothing extra", the opposite of the
  // off switch, and must not be read as "unset".
  it('a retention count of zero keeps nothing extra', async () => {
    const { service, removed } = build([lease('old', { lastUsedAt: daysAgo(90) })])
    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [], retainCount: 0 })
    expect(result.skipped.filter(skip => skip.reason === 'retained')).toEqual([])
    expect(removed).toEqual(['old'])
  })
})
