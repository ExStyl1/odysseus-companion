/**
 * Working-directory bookkeeping for `EnterWorktree`/`ExitWorktree`.
 *
 * worktrees.md: entering "records the session under the session's new working
 * directory, the same way `/cd` does, so `/desktop` and `--resume` find it
 * there. Exiting moves it back the same way. A worktree created by a
 * `WorktreeCreate` hook keeps its transcript at the launch directory."
 *
 * These drive the real port and the real `mutateWorkingDirectory` transaction.
 * Only the git side of the lease is stubbed — the argv it would run is pinned by
 * `worktree-git-plan.test.ts`, and what these tests are about is the record, not
 * the checkout.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionWorktreePort } from '@nessy-agent/session-tools-core'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { resolveWorktreeAwareWorkingDirectory } from '@nessy-agent/shared/sessions'
import type { PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-worktree-cwd-'))
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
  })
  // The cwd transaction itself is what these tests isolate; runtime settlement
  // has its own suites.
  ;(manager as any).strictDrainPiSession = async () => {}
  ;(manager as any).strictDrainSessionForMutation = async () => {}

  const workspace = {
    id: 'ws-worktree',
    name: 'Worktree Workspace',
    slug: 'worktree-workspace',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id: 'session-1', workingDirectory: projectPath, sdkCwd: projectPath },
    workspace,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspace.id}:${managed.id}`,
    managed,
  )

  // Stub only the lease service: no git, no supervisor.
  const leases: PiWorktreeLeaseV1[] = []
  const touched: string[] = []
  // P2.427 — every retention sweep the port asks for, in call order. An empty
  // array means the sweep never ran at all.
  const swept: Array<{ dryRun: boolean; liveLeaseIds: string[] }> = []
  let now = 1
  ;(manager as any).createPiWorktreeLeaseService = () => ({
    list: () => leases.map(lease => ({ ...lease })),
    sweepOrphans: async ({ liveLeaseIds, dryRun }: { liveLeaseIds: readonly string[]; dryRun?: boolean }) => {
      swept.push({ dryRun: dryRun === true, liveLeaseIds: [...liveLeaseIds] })
      return { dryRun: dryRun === true, removed: [], skipped: [] }
    },
    acquire: async ({ ownerAgentId, worktreeLeaseId }: { ownerAgentId: string; worktreeLeaseId?: string }) => {
      const lease: PiWorktreeLeaseV1 = {
        schemaVersion: 1,
        worktreeLeaseId: worktreeLeaseId ?? 'worktree-session-1',
        workspaceId: workspace.id,
        ownerAgentId,
        path: worktreePath,
        branch: `nessy/${ownerAgentId}/lease`,
        baseSha: 'abc123',
        status: 'active',
        lastUsedAt: `2026-07-27T00:00:0${now++}.000Z`,
      }
      leases.push(lease)
      return { ...lease }
    },
    touch: async (id: string) => { touched.push(id) },
    release: async () => {},
  })
  ;(manager as any).registerPiWorktreeLease = async (
    _managed: unknown,
    _service: unknown,
    _lease: unknown,
    create: () => Promise<PiWorktreeLeaseV1>,
  ) => create()

  const port: SessionWorktreePort = (manager as any).createSessionWorktreePort(managed)
  return { manager, managed, port, projectPath, worktreePath, touched, swept }
}

describe('EnterWorktree records the session under its new working directory', () => {
  it('moves the recorded cwd into the worktree and leaves the launch directory alone', async () => {
    const { managed, port, projectPath, worktreePath } = fixture()

    const location = await port.enter({})

    expect(location.created).toBe(true)
    expect(location.path).toBe(worktreePath)
    expect(location.previousWorkingDirectory).toBe(projectPath)
    // The record `/desktop` and resume read.
    expect(managed.workingDirectory).toBe(worktreePath)
    // The transcript anchor must NOT follow — it is the only thing a resume can
    // fall back to when the worktree is gone.
    expect(managed.sdkCwd).toBe(projectPath)
  })

  it('preserves the launch directory even on a session with no messages yet', async () => {
    const { managed, port, projectPath, worktreePath } = fixture()
    expect(managed.messages).toHaveLength(0)

    await port.enter({})

    expect(managed.workingDirectory).toBe(worktreePath)
    expect(managed.sdkCwd).toBe(projectPath)
  })

  it('stamps the lease so a retention sweep can age it', async () => {
    const { port } = fixture()
    const location = await port.enter({})
    const [lease] = await port.list()

    expect(lease?.worktreeLeaseId).toBe(location.worktreeLeaseId)
    expect(lease?.lastUsedAt).toMatch(/^2026-07-27T/)
  })

  it('refuses a path that is not a lease of this session', async () => {
    const { port } = fixture()
    await expect(port.enter({ path: '/somewhere/else' })).rejects.toThrow('worktree-unknown-path')
  })

  it('re-enters an existing lease by path and touches it', async () => {
    const { port, worktreePath, touched } = fixture()
    await port.enter({})

    const again = await port.enter({ path: worktreePath })

    expect(again.created).toBe(false)
    expect(again.path).toBe(worktreePath)
    expect(touched).toEqual(['worktree-session-session-1'])
  })
})

/**
 * P2.427's belt. The Pi startup seam (`createPiChildSessionPort`) sweeps aged
 * orphans before `recover()`; claude and codex never reach that method, so
 * nothing swept for them. This is the creation seam all three runtimes DO reach.
 */
describe('creating a worktree runs the retention sweep', () => {
  it('sweeps before acquiring, on a session that holds nothing yet', async () => {
    const { port, swept } = fixture()

    await port.enter({})

    // The dry run is the whole pass when it plans no removals — `sweepOrphans`
    // is only called a second time once there is something to remove. It ran
    // before the acquire, so the live set is empty.
    expect(swept).toEqual([{ dryRun: true, liveLeaseIds: [] }])
  })

  it('never offers the sweep a lease this session is holding', async () => {
    const { manager, managed, port, swept } = fixture()
    // What `registerPiWorktreeLease` writes for a lease this process acquired —
    // seeded directly because the fixture stubs that registration away.
    ;(manager as any).piWorktreeDrainRegistrations.set(
      `${(manager as any).managedKey(managed)}\u0000worktree-held`,
      { dispose: () => {} },
    )

    await port.enter({})

    expect(swept).toEqual([{ dryRun: true, liveLeaseIds: ['worktree-held'] }])
  })

  it('does not sweep when re-entering an existing lease by path', async () => {
    const { port, swept, worktreePath } = fixture()
    await port.enter({})
    swept.length = 0

    await port.enter({ path: worktreePath })

    // Sweeping here would remove a lease past the cutoff and then fail the very
    // request that named it.
    expect(swept).toEqual([])
  })
})

describe('ExitWorktree moves the record back the same way', () => {
  it('returns to the launch directory', async () => {
    const { managed, port, projectPath, worktreePath } = fixture()
    await port.enter({})

    const moved = await port.exit()

    expect(moved).toEqual({ path: projectPath, previousWorkingDirectory: worktreePath })
    expect(managed.workingDirectory).toBe(projectPath)
    expect(managed.sdkCwd).toBe(projectPath)
  })

  it('does nothing when the session is not in a worktree', async () => {
    const { managed, port, projectPath } = fixture()

    expect(await port.exit()).toBeNull()
    expect(managed.workingDirectory).toBe(projectPath)
  })

  it('does not move a session whose cwd is not one of its leases', async () => {
    const { manager, managed, port } = fixture()
    await (manager as any).mutateWorkingDirectory(managed, { intent: 'keep', path: '/somewhere/else', preserveSdkCwd: true })

    expect(await port.exit()).toBeNull()
    expect(managed.workingDirectory).toBe('/somewhere/else')
  })
})

describe('reopening a session follows the same record', () => {
  it('resumes in the worktree, and in the launch directory once it is gone', () => {
    const { projectPath, worktreePath } = fixture()

    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: worktreePath, sdkCwd: projectPath, exists: () => true,
    })).toBe(worktreePath)

    rmSync(worktreePath, { recursive: true, force: true })
    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: worktreePath,
      sdkCwd: projectPath,
      exists: path => path !== worktreePath,
    })).toBe(projectPath)
  })
})
