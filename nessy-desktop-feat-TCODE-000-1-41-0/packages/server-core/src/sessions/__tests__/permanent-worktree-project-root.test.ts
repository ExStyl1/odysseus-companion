/**
 * P6.800 — a PERMANENT worktree appears as its own project root.
 *
 * The sweep already keeps a `permanent` worktree by name (P6.336 (b)); what it
 * did not get was a way back in. `enter`'s create branch mutates the working
 * directory with `intent: 'keep'`, which resolves no project handle, so nothing
 * ever recorded the path — the directory was intact and reachable only through
 * the session that made it, the exact shape P6.22 fixed one layer down.
 *
 * W9-ah landed the recorder (`RecentProjectStore.recordProjectDirectory`,
 * `e1891fd4e`) with no caller. This drives the real port and the real store, so
 * what is asserted is the RECORD a project picker reads, not that a method was
 * called.
 *
 * The lease service is stubbed exactly as `worktree-working-directory.test.ts`
 * stubs it: no git, no supervisor. The subject is the registry, not the
 * checkout.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionWorktreePort } from '@nessy-agent/session-tools-core'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store'
import type { PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-permanent-worktree-'))
  roots.push(stateRoot)
  const projectPath = join(stateRoot, 'project')
  const worktreePath = join(stateRoot, '.nessy-worktrees', 'project', 'worktree-session-1')
  mkdirSync(projectPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })

  const recentProjectStore = new RecentProjectStore(
    { storageLayoutVersion: 2 as const, verificationId: 'p6800' },
    { filePath: join(stateRoot, 'recent-projects.json') },
  )
  const manager = createTestSessionManager({
    recentProjectStore,
    projectHandleService: new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(stateRoot, 'trust.json') }),
      newId: () => 'project-handle',
    }),
  })
  ;(manager as any).strictDrainPiSession = async () => {}
  ;(manager as any).strictDrainSessionForMutation = async () => {}

  const workspace = {
    id: 'ws-permanent-worktree',
    name: 'Permanent Worktree Workspace',
    slug: 'permanent-worktree-workspace',
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

  const leases: PiWorktreeLeaseV1[] = []
  ;(manager as any).createPiWorktreeLeaseService = () => ({
    list: () => leases.map(lease => ({ ...lease })),
    sweepOrphans: async () => ({ dryRun: true, removed: [], skipped: [] }),
    acquire: async ({ ownerAgentId, worktreeLeaseId, permanent }: {
      ownerAgentId: string
      worktreeLeaseId?: string
      permanent?: boolean
    }) => {
      const lease: PiWorktreeLeaseV1 = {
        schemaVersion: 1,
        worktreeLeaseId: worktreeLeaseId ?? 'worktree-session-1',
        workspaceId: workspace.id,
        ownerAgentId,
        path: worktreePath,
        branch: `nessy/${ownerAgentId}/lease`,
        baseSha: 'abc123',
        status: 'active',
        lastUsedAt: '2026-09-08T00:00:00.000Z',
        ...(permanent ? { permanent: true } : {}),
      }
      leases.push(lease)
      return { ...lease }
    },
    touch: async () => {},
    release: async () => {},
  })
  ;(manager as any).registerPiWorktreeLease = async (
    _managed: unknown,
    _service: unknown,
    _lease: unknown,
    create: () => Promise<PiWorktreeLeaseV1>,
  ) => create()

  const port: SessionWorktreePort = (manager as any).createSessionWorktreePort(managed)

  const recordedDirectories = (): string[] =>
    recentProjectStore.listRecentProjects(workspace.id).map(entry => entry.displayPath)

  return { port, worktreePath, recordedDirectories }
}

describe('P6.800 · a permanent worktree becomes its own project root', () => {
  it('records the worktree directory in the project registry', async () => {
    const { port, worktreePath, recordedDirectories } = fixture()
    expect(recordedDirectories()).toEqual([])

    const location = await port.enter({ permanent: true })

    expect(location.created).toBe(true)
    // The record a project picker reads — the path is now reachable without the
    // session that made it.
    expect(recordedDirectories()).toEqual([worktreePath])
  })

  it('records nothing for a throwaway worktree', async () => {
    // The negative that keeps the recents honest: a worktree the sweep will
    // collect must not accumulate in the picker, so only `permanent` registers.
    const { port, recordedDirectories } = fixture()

    await port.enter({})

    expect(recordedDirectories()).toEqual([])
  })
})
