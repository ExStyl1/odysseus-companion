/**
 * P6.22 — a worktree the sweep keeps because it holds work is announced to the
 * SESSION, and leaving one offers keep-or-remove.
 *
 * The sweep already refused to remove a worktree holding work; that half was
 * never the defect. The person whose work it is never heard: the only trace was
 * a log line, and the directory sits under a namespace root they did not choose.
 * The branch is the handle — `git checkout <branch>` reaches the work from the
 * main checkout — which is why `WorktreeSweepResult.skipped` grew that field in
 * the same change that reads it.
 *
 * Per-runtime: both halves are host code with no provider branch, and both are
 * reachable on all three runtimes only because a session can now hold a lease on
 * all three (P2.427 releases them everywhere, P6.20 creates them everywhere).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionWorktreePort } from '@nessy-agent/session-tools-core'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import type { PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import { WorktreeLeaseError } from '../../pi-harness/worktree-lease-service'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Skip = { worktreeLeaseId: string; path: string; branch: string; reason: string }

function fixture(options: {
  skipped?: Skip[]
  /** The residual a `remove: true` release throws, if any. */
  refuseWith?: 'worktree-dirty' | 'worktree-holds-commits' | 'worktree-remove-failed'
  /**
   * P6.135 — what `describeWork` answers about the held worktree. Defaults to a
   * clean, existing one; `exists: false` is the vanished-directory arm.
   */
  work?: { exists?: boolean; dirty?: boolean; holdsCommits?: boolean }
  /** P6.135 — what the USER clicks on the keep-or-remove card. */
  answer?: boolean
  /**
   * P6.547 — what the release reports happened to the BRANCH. Absent is the
   * pre-P6.547 port: a release that deletes no branch and says nothing.
   */
  branchOutcome?: { branchDeleted: boolean; branchKeptReason?: string }
} = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-worktree-keep-'))
  roots.push(stateRoot)
  const projectPath = join(stateRoot, 'project')
  const worktreePath = join(stateRoot, '.nessy-worktrees', 'project', 'worktree-session-1')
  mkdirSync(projectPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })

  const manager = createTestSessionManager({
    projectHandleService: new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(stateRoot, 'trust.json') }),
      newId: () => 'project-handle',
    }),
  }) as any
  manager.strictDrainPiSession = async () => {}
  manager.strictDrainSessionForMutation = async () => {}

  const workspace = {
    id: 'ws-keep-or-remove',
    name: 'Keep Workspace',
    slug: 'keep-workspace',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id: 'session-1', workingDirectory: projectPath, sdkCwd: projectPath },
    workspace,
    { messagesLoaded: true, ephemeral: true },
  )
  manager.sessions.set(`${workspace.id}:${managed.id}`, managed)

  const leases: PiWorktreeLeaseV1[] = []
  const releaseCalls: Array<{ id: string; options: unknown }> = []
  /** Every permission request the host actually raised, in order. */
  const asked: Array<{ requestId: string; type?: string; toolName: string; description: string; impact?: string }> = []
  const service = {
    list: () => leases.map(value => ({ ...value })),
    touch: async () => {},
    describeWork: async (id: string) => {
      const lease = leases.find(value => value.worktreeLeaseId === id)
      if (!lease) return undefined
      return {
        worktreeLeaseId: lease.worktreeLeaseId,
        path: lease.path,
        branch: lease.branch,
        exists: options.work?.exists !== false,
        dirty: options.work?.dirty === true,
        holdsCommits: options.work?.holdsCommits === true,
      }
    },
    release: async (id: string, releaseOptions: { refuseIfHoldsWork?: boolean } = {}) => {
      releaseCalls.push({ id, options: releaseOptions })
      if (options.refuseWith) {
        throw new WorktreeLeaseError(options.refuseWith, [
          { resourceType: 'worktree', resourceId: id, code: options.refuseWith },
        ])
      }
      const index = leases.findIndex(value => value.worktreeLeaseId === id)
      if (index >= 0) leases.splice(index, 1)
      // P6.547 — the release now ANSWERS what happened to the branch, and the
      // notice is written from that answer rather than from a rule. `undefined`
      // here is the pre-P6.547 port (one that deletes no branch), which is what
      // the default arm below exercises.
      return options.branchOutcome
    },
    sweepOrphans: async ({ dryRun }: { dryRun?: boolean }) => ({
      dryRun: dryRun === true,
      // A non-empty `removed` on the dry run is what makes the real pass run at
      // all; the notice is driven off `skipped`.
      removed: options.skipped?.length
        ? [{ worktreeLeaseId: 'gone', path: join(stateRoot, 'gone'), lastUsedAt: '2026-01-01T00:00:00.000Z' }]
        : [],
      skipped: dryRun === true ? [] : (options.skipped ?? []),
    }),
    acquire: async ({ ownerAgentId, worktreeLeaseId }: { ownerAgentId: string; worktreeLeaseId?: string }) => {
      const value: PiWorktreeLeaseV1 = {
        schemaVersion: 1,
        worktreeLeaseId: worktreeLeaseId ?? 'worktree-session-1',
        workspaceId: workspace.id,
        ownerAgentId,
        path: worktreePath,
        branch: 'nessy/session-1/lease',
        baseSha: 'abc123',
        status: 'active',
        lastUsedAt: '2026-08-30T00:00:00.000Z',
      }
      leases.push(value)
      return { ...value }
    },
  }
  manager.createPiWorktreeLeaseService = () => {
    manager.piWorktreeLeaseServices.set(`${workspace.id}:${managed.id}`, service)
    return service
  }
  manager.registerPiWorktreeLease = async (
    _managed: unknown,
    _service: unknown,
    _lease: unknown,
    create: () => Promise<PiWorktreeLeaseV1>,
  ) => create()

  // The card, answered where the user would answer it. `requestPiToolApproval`
  // registers its resolver BEFORE handing the request on, so settling it from
  // here is the same route a click takes — and everything the row is about (the
  // type, the wording, the branch) is built by the real method under test.
  manager.handleAgentPermissionRequest = (_managed: unknown, request: {
    requestId: string; type?: string; toolName: string; description: string; impact?: string
  }) => {
    asked.push(request)
    const resolver = manager.directPermissionResolvers.get(request.requestId)
    manager.directPermissionResolvers.delete(request.requestId)
    resolver?.resolve(options.answer === true)
  }

  // `archiveSession` deliberately does NOT await the offer — the archive is the
  // user's instruction and must not wait on an answer to a different question —
  // so the test needs a handle on it. The REAL method still runs; this only
  // keeps its promise.
  let offered: Promise<void> = Promise.resolve()
  const offer = manager.offerWorktreeCleanupOnClose.bind(manager)
  manager.offerWorktreeCleanupOnClose = (target: unknown) => (offered = offer(target))
  const settle = async () => { await offered }

  const port: SessionWorktreePort = manager.createSessionWorktreePort(managed)
  return { manager, managed, port, service, releaseCalls, asked, settle, projectPath, worktreePath }
}

function notices(managed: { messages: Array<{ role: string; content: string }> }): string[] {
  return managed.messages.filter(message => message.role === 'info').map(message => message.content)
}

describe('a worktree the sweep keeps is announced to the session', () => {
  const holdsWork = [
    { reason: 'dirty', held: 'uncommitted or untracked changes' },
    { reason: 'holds-commits', held: 'commits that exist nowhere else' },
  ] as const

  for (const testCase of holdsWork) {
    it(`tells the session, with the branch, when a worktree is kept: ${testCase.reason}`, async () => {
      const rig = fixture({
        skipped: [{
          worktreeLeaseId: 'busy',
          path: '/repo/.nessy-worktrees/proj/busy',
          branch: 'nessy/agent/busy',
          reason: testCase.reason,
        }],
      })

      await rig.manager.sweepOrphanedWorktrees(rig.managed, rig.service, [])

      const [notice, ...rest] = notices(rig.managed)
      expect(rest).toEqual([])
      expect(notice).toContain('/repo/.nessy-worktrees/proj/busy')
      expect(notice).toContain(testCase.held)
      // The handle on the work. Without it the notice names a directory the
      // user never chose and gives them no way to reach what is in it.
      expect(notice).toContain('git checkout nessy/agent/busy')
    })
  }

  it('says nothing about a worktree kept for a reason that is not the user\'s work', async () => {
    const rig = fixture({
      skipped: [
        { worktreeLeaseId: 'a', path: '/w/a', branch: 'nessy/a', reason: 'recently-used' },
        { worktreeLeaseId: 'b', path: '/w/b', branch: 'nessy/b', reason: 'live-lease' },
        { worktreeLeaseId: 'c', path: '/w/c', branch: 'nessy/c', reason: 'remove-failed' },
        { worktreeLeaseId: 'd', path: '/w/d', branch: 'nessy/d', reason: 'unknown-last-used' },
      ],
    })

    await rig.manager.sweepOrphanedWorktrees(rig.managed, rig.service, [])

    expect(notices(rig.managed)).toEqual([])
  })
})

describe('leaving a worktree offers keep or remove', () => {
  it('keeps the worktree when removal was not asked for', async () => {
    const rig = fixture()
    await rig.port.enter({})

    const moved = await rig.port.exit()

    expect(moved?.path).toBe(rig.projectPath)
    // Not asked and asked-and-refused must never read as the same answer.
    expect(moved?.removal).toBeUndefined()
    expect(rig.releaseCalls).toEqual([])
  })

  it('removes the worktree on request and names the branch it took', async () => {
    const rig = fixture()
    await rig.port.enter({})

    const moved = await rig.port.exit({ remove: true })

    expect(moved?.removal).toEqual({ removed: true, branch: 'nessy/session-1/lease' })
    expect(rig.releaseCalls).toEqual([
      { id: 'worktree-session-session-1', options: { refuseIfHoldsWork: true } },
    ])
  })

  const refusals = [
    { residual: 'worktree-dirty', reason: 'it still has uncommitted or untracked changes' },
    { residual: 'worktree-holds-commits', reason: 'it holds commits that exist nowhere else' },
  ] as const

  for (const testCase of refusals) {
    it(`refuses the removal and says why: ${testCase.residual}`, async () => {
      const rig = fixture({ refuseWith: testCase.residual })
      await rig.port.enter({})

      const moved = await rig.port.exit({ remove: true })

      // The EXIT still happened: the user asked to leave, and a refused removal
      // is not a refused exit.
      expect(moved?.path).toBe(rig.projectPath)
      expect(moved?.removal).toEqual({
        removed: false,
        branch: 'nessy/session-1/lease',
        keptReason: testCase.reason,
      })
    })
  }

  it('does not call a git failure "still holds work"', async () => {
    const rig = fixture({ refuseWith: 'worktree-remove-failed' })
    await rig.port.enter({})

    const moved = await rig.port.exit({ remove: true })

    expect(moved?.removal?.removed).toBe(false)
    expect(moved?.removal?.keptReason).toContain('the removal did not succeed')
    expect(moved?.removal?.keptReason).not.toContain('holds')
  })
})

/**
 * P6.135 — closing a session that holds a worktree asks the USER to keep or
 * remove it.
 *
 * `worktrees.md#clean-up-worktrees`: *"When you exit an interactive worktree
 * session, Claude checks the worktree for work that removal would delete"*, and
 * for a worktree with work in it *"Claude prompts you to keep or remove the
 * worktree. Keeping preserves the directory and branch so you can return
 * later"*.
 *
 * The CHECK and the MODEL's half of the offer both shipped in P6.22 (the
 * describes above). What is driven here is the person: archiving — this app's
 * "close this chat" — raises the card, and the answer routes through the SAME
 * guarded release `ExitWorktree({ remove: true })` uses, so the user and the
 * model cannot get two different answers to "may this be removed".
 */
describe('P6.135 · closing a session offers the USER keep or remove', () => {
  it('asks about a worktree that holds work, naming the branch and what is held', async () => {
    const rig = fixture({ work: { dirty: true } })
    await rig.port.enter({})

    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()

    expect(rig.asked).toHaveLength(1)
    // Its OWN type, so the card can offer Remove/Keep instead of Allow/Deny and
    // can refuse to remember the answer.
    expect(rig.asked[0]?.type).toBe('worktree_cleanup')
    expect(rig.asked[0]?.description).toContain(rig.worktreePath)
    // The branch is the handle on the work.
    expect(rig.asked[0]?.description).toContain('nessy/session-1/lease')
    expect(rig.asked[0]?.impact).toContain('uncommitted or untracked changes')
  })

  it('KEEPS on the keep answer, and tells the session how to reach the work', async () => {
    const rig = fixture({ work: { holdsCommits: true }, answer: false })
    await rig.port.enter({})

    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()

    expect(rig.releaseCalls).toEqual([])
    expect(rig.service.list()).toHaveLength(1)
    const [notice] = notices(rig.managed)
    expect(notice).toContain('Kept the worktree')
    expect(notice).toContain('git checkout nessy/session-1/lease')
  })

  it('REMOVES on the remove answer, through the same guarded release the model gets', async () => {
    const rig = fixture({ answer: true })
    await rig.port.enter({})

    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()

    expect(rig.releaseCalls).toEqual([
      { id: 'worktree-session-session-1', options: { refuseIfHoldsWork: true } },
    ])
    expect(rig.service.list()).toEqual([])
    // P6.547 — the notice states what actually happened to the branch. A
    // release that reports nothing deleted nothing, so the branch was kept and
    // the notice says how to reach the work rather than claiming a deletion.
    const [notice] = notices(rig.managed)
    expect(notice).toContain('Removed the worktree')
    expect(notice).toContain('Branch `nessy/session-1/lease` was kept')
    expect(notice).toContain('git checkout nessy/session-1/lease')
  })

  it('says the branch went with the worktree when the release reports that it did', async () => {
    const rig = fixture({ answer: true, branchOutcome: { branchDeleted: true } })
    await rig.port.enter({})

    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()

    const [notice] = notices(rig.managed)
    expect(notice).toContain('and branch `nessy/session-1/lease` with it')
    // The narrowing, stated to the user rather than only to the code: the
    // deletion happened because the host made the branch for this worktree and
    // it held nothing its base does not.
    expect(notice).toContain('held nothing its base does not')
  })

  it('P6.546 — an archived session that still holds the worktree asks again when it is opened', async () => {
    const rig = fixture({ answer: false })
    await rig.port.enter({})
    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()
    expect(rig.asked).toHaveLength(1)

    // The user archived from the sidebar and navigated away, so the card above
    // was posted into a chat nobody was looking at. Opening it asks again.
    ;(rig.manager as any).reofferWorktreeCleanupOnOpen(rig.managed)
    await rig.settle()

    expect(rig.asked).toHaveLength(2)
    expect(rig.asked[1]?.type).toBe('worktree_cleanup')
  })

  it('P6.546 — asks nothing for a live session, or for one whose worktree is gone', async () => {
    const rig = fixture({ answer: true })
    await rig.port.enter({})

    // Not archived: the close-time question has not been asked yet, and opening
    // a live chat must not ask it.
    ;(rig.manager as any).reofferWorktreeCleanupOnOpen(rig.managed)
    await rig.settle()
    expect(rig.asked).toHaveLength(0)

    // Archived AND answered with "remove": the lease is gone, so there is
    // nothing left to ask about however often the chat is opened.
    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()
    expect(rig.asked).toHaveLength(1)
    expect(rig.service.list()).toEqual([])
    ;(rig.manager as any).reofferWorktreeCleanupOnOpen(rig.managed)
    await rig.settle()
    expect(rig.asked).toHaveLength(1)
  })

  it('P6.546 — two openings while one card is unanswered raise ONE card', async () => {
    const rig = fixture({ answer: false })
    await rig.port.enter({})
    rig.managed.isArchived = true

    // Concurrent on purpose: `describeWork` is async, so the second call enters
    // while the first is still in flight — which is exactly the shape a user
    // navigating back and forth produces. Two cards for one worktree would
    // strand whichever answer was not clicked.
    const first = (rig.manager as any).offerWorktreeCleanupOnClose(rig.managed)
    const second = (rig.manager as any).offerWorktreeCleanupOnClose(rig.managed)
    await Promise.all([first, second])

    expect(rig.asked).toHaveLength(1)
  })

  it('repeats the reason git gave when the branch was kept', async () => {
    const rig = fixture({
      answer: true,
      branchOutcome: { branchDeleted: false, branchKeptReason: "error: the branch 'x' is not fully merged" },
    })
    await rig.port.enter({})

    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()

    const [notice] = notices(rig.managed)
    expect(notice).toContain('was kept — error: the branch')
  })

  it('reports a refused removal instead of losing it, and the worktree stays', async () => {
    const rig = fixture({ work: { dirty: true }, answer: true, refuseWith: 'worktree-dirty' })
    await rig.port.enter({})

    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()

    // The attempt is the control: a silent keep and a refused remove must not
    // read the same.
    expect(rig.releaseCalls).toHaveLength(1)
    expect(rig.service.list()).toHaveLength(1)
    const [notice] = notices(rig.managed)
    expect(notice).toContain('it still has uncommitted or untracked changes')
    expect(notice).toContain('git checkout nessy/session-1/lease')
  })

  it('NEGATIVE — a session holding no worktree is closed without a card', async () => {
    const rig = fixture()

    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()

    expect(rig.asked).toEqual([])
    expect(notices(rig.managed)).toEqual([])
  })

  it('NEGATIVE — a worktree whose directory has vanished is nobody\'s decision', async () => {
    const rig = fixture({ work: { exists: false } })
    await rig.port.enter({})

    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()

    expect(rig.asked).toEqual([])
    expect(rig.releaseCalls).toEqual([])
  })

  it('NEGATIVE — re-archiving an already-archived session is not a new close', async () => {
    const rig = fixture({ work: { dirty: true } })
    await rig.port.enter({})

    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()
    await rig.manager.archiveSession('session-1', rig.managed.workspace.id)
    await rig.settle()

    expect(rig.asked).toHaveLength(1)
  })
})
