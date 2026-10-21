/**
 * P6.136 — the sweep's candidate set, and the two filters that keep widening it
 * safe.
 *
 * THE GAP: `sweepOrphanedWorktrees` planned over one session's own ledger, while
 * a scheduled task makes a NEW SESSION PER RUN — so run #2 walked an empty
 * ledger and run #1's worktree was unreachable from every session that would
 * ever run again. The git-lock arms only decided what to SKIP among candidates;
 * nothing widened the set.
 *
 * The service-side arms (the age cutoff, the live-lease set, git's lock, and the
 * dirty / holds-commits refusals) are pinned in `worktree-orphan-sweep.test.ts`
 * and `worktree-lock-interlock.test.ts`. What is pinned HERE is what the host
 * OFFERS them, because that is where an uncontained widening would come from.
 */
import { describe, expect, it } from 'bun:test'
import type { PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import { SessionManager } from '../SessionManager'

const NAMESPACE = '/repo/.nessy-worktrees/proj'
/**
 * The registration-map key separator, written as an ESCAPE and never as a raw
 * byte: this tree's `lint:nul-bytes` gate reads every tracked source file, and
 * an escaped NUL is byte-identical in value while keeping the source greppable
 * (the rule P2.415 applied to the last two in the repo).
 */
const NUL = '\u0000'

function lease(id: string, path: string): PiWorktreeLeaseV1 {
  return {
    schemaVersion: 1,
    worktreeLeaseId: id,
    workspaceId: 'ws-1',
    ownerAgentId: `agent-${id}`,
    path,
    branch: `nessy/agent/${id}`,
    baseSha: 'base-sha',
    status: 'active',
  } as PiWorktreeLeaseV1
}

/**
 * `foreignWorktreeLeases` and `allLiveWorktreeLeaseIds` read three fields and
 * nothing else, so the harness supplies those three rather than a whole session
 * manager: the row is about which leases are OFFERED, not about how a manager is
 * built.
 */
function harness(options: {
  sessions?: Array<{ id: string; leases: PiWorktreeLeaseV1[] }>
  liveServices?: Record<string, PiWorktreeLeaseV1[]>
  registrations?: string[]
}) {
  const manager = Object.create(SessionManager.prototype) as any
  manager.sessionStore = {
    list: () => (options.sessions ?? []).map(session => ({
      id: session.id,
      worktreeLeaseState: { schemaVersion: 1, revision: 1, leases: session.leases },
    })),
  }
  manager.piWorktreeLeaseServices = new Map(
    Object.entries(options.liveServices ?? {}).map(([key, leases]) => [key, { list: () => leases }]),
  )
  manager.piWorktreeDrainRegistrations = new Map(
    (options.registrations ?? []).map(key => [key, { dispose() {} }]),
  )
  return manager
}

const managed = { id: 'session-own', workspace: { id: 'ws-1' } }

describe('P6.136 · which foreign leases the sweep is offered', () => {
  it("offers another session's worktree inside this project's namespace", () => {
    // The row's subject: run #1's worktree, reachable from run #2 at last.
    const manager = harness({
      sessions: [
        { id: 'session-own', leases: [lease('own', `${NAMESPACE}/own`)] },
        { id: 'session-run-1', leases: [lease('run-1', `${NAMESPACE}/run-1`)] },
      ],
    })

    const offered = manager.foreignWorktreeLeases(managed, NAMESPACE)

    expect(offered.map((value: PiWorktreeLeaseV1) => value.worktreeLeaseId)).toEqual(['run-1'])
  })

  it('never offers a lease outside the namespace root — the uncontained direction', () => {
    // Two sessions in one workspace can sit on DIFFERENT projects, and a sweep
    // run by one must never reach the other's worktrees, nor anything outside
    // `.nessy-worktrees` at all. This is the filter that decides whether the
    // widening can delete something that is not an orphan.
    const manager = harness({
      sessions: [
        { id: 'session-other-project', leases: [lease('other', '/repo/.nessy-worktrees/other-proj/w')] },
        { id: 'session-outside', leases: [lease('outside', '/somewhere/else/w')] },
        // A prefix match WITHOUT the separator would accept a sibling directory
        // whose name merely starts the same way.
        { id: 'session-sibling', leases: [lease('sibling', `${NAMESPACE}-backup/w`)] },
      ],
    })

    expect(manager.foreignWorktreeLeases(managed, NAMESPACE)).toEqual([])
  })

  it("prefers a loaded session's LIVE ledger over its persisted copy", () => {
    // A loaded session's file lags its service: the stale copy would present a
    // lease it has already released as a candidate.
    const manager = harness({
      sessions: [{ id: 'session-loaded', leases: [lease('released', `${NAMESPACE}/released`)] }],
      liveServices: { 'ws-1:session-loaded': [lease('current', `${NAMESPACE}/current`)] },
    })

    const offered = manager.foreignWorktreeLeases(managed, NAMESPACE)

    expect(offered.map((value: PiWorktreeLeaseV1) => value.worktreeLeaseId)).toEqual(['current'])
  })

  it("never offers this session's own leases — those are already the planner's input", () => {
    const manager = harness({
      sessions: [{ id: 'session-own', leases: [lease('own', `${NAMESPACE}/own`)] }],
    })
    expect(manager.foreignWorktreeLeases(managed, NAMESPACE)).toEqual([])
  })

  it('answers the live set PROCESS-WIDE, which the git interlock cannot', () => {
    // The second safety half, and the reason it exists: a sibling session in
    // THIS process locks its worktree under THIS pid, and the sweep's own rule
    // treats a lock naming this process as stale by construction — released
    // rather than honoured. So a per-session live list would let the sweep drop
    // a live sibling's lock and remove its worktree.
    const manager = harness({
      registrations: [`ws-1:session-own${NUL}own`, `ws-1:session-sibling${NUL}sibling`],
    })

    expect([...manager.allLiveWorktreeLeaseIds()].sort()).toEqual(['own', 'sibling'])
  })
})
