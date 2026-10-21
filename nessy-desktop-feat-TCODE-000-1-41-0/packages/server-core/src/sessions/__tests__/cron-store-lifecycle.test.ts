/**
 * T8 — where the cron store lives, and who tears it down.
 *
 * Two of the three defects here were watched live in T6 (the store followed the
 * session's cwd, and a rolled-back branch left its services running); the third
 * is the migration that carries a pre-T8 store forward. What every row below
 * asserts is a PATH or a MAP ENTRY, because those are the two things the bug
 * class is made of — a record that is written somewhere the next reader does not
 * look, or a service that outlives the session that owned it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { openSessionCronStore, sessionCronFile } from '@nessy-agent/shared/sessions'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const WORKSPACE_ID = 'ws-cron-store-lifecycle'
const workspaceRoot = join(CONFIG_DIR, 'workspaces', WORKSPACE_ID)
const worktrees: string[] = []

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nessy-cron-worktree-'))
  worktrees.push(dir)
  return dir
}

type SessionManagerModule = typeof import('../SessionManager.ts')
type ManagedForTest = Record<string, unknown> & { id: string; workspace: { id: string; rootPath: string } }

interface Internals {
  sessions: Map<string, unknown>
  sessionCronServices: Map<string, { list(): readonly { id: string; prompt: string }[]; stop(): void; clear(): void }>
  piTaskServices: Map<string, unknown>
  piGoalServices: Map<string, unknown>
  piPlanModeServices: Map<string, unknown>
  piMailboxServices: Map<string, unknown>
  getOrCreateSessionCronService(managed: unknown): {
    create(input: { schedule: string; recurring: boolean; prompt: string }): { id: string }
    list(): readonly { id: string; prompt: string }[]
  } | undefined
  getOrCreateAgent(managed: unknown, runtime?: unknown): Promise<unknown>
}

let createManagedSessionFn: SessionManagerModule['createManagedSession']
let createTestSessionManagerFn: typeof import('./test-session-manager.ts')['createTestSessionManager']
let restoreConfig: () => void = () => {}

beforeAll(async () => {
  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({
      id: WORKSPACE_ID,
      name: 'Cron Store Lifecycle Workspace',
      slug: 'cron-store-lifecycle-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
    'utf-8',
  )

  const mod = await import('../SessionManager.ts')
  createManagedSessionFn = mod.createManagedSession
  ;({ createTestSessionManager: createTestSessionManagerFn } = await import('./test-session-manager.ts'))

  // Same discipline as `scheduled-delivery-runtimes.test.ts`: CONFIG_DIR is
  // frozen by the repo preload, so the connection is written into it here and
  // whatever was there is put back in `afterAll`.
  const storage = await import('@nessy-agent/shared/config/storage')
  const configPath = storage.getConfigPath()
  const previous = existsSync(configPath) ? storage.loadStoredConfig() : null
  const base: StoredConfig = previous ?? ({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as unknown as StoredConfig)
  storage.saveConfig({
    ...base,
    workspaceRefs: [
      ...base.workspaceRefs.filter(ref => ref.id !== WORKSPACE_ID),
      { id: WORKSPACE_ID, lastAccessedAt: Date.now() },
    ],
    defaultLlmConnection: 'cron-lifecycle-pi',
    llmConnections: [{
      slug: 'cron-lifecycle-pi',
      name: 'Cron Lifecycle Pi',
      providerType: 'pi',
      authType: 'api_key',
      defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
      createdAt: Date.now(),
    }] as unknown as NonNullable<StoredConfig['llmConnections']>,
  })
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  restoreConfig()
  rmSync(workspaceRoot, { recursive: true, force: true })
  rmSync(join(CONFIG_DIR, 'sessions', WORKSPACE_ID), { recursive: true, force: true })
  while (worktrees.length > 0) rmSync(worktrees.pop()!, { recursive: true, force: true })
})

let sessionCounter = 0

function harness(options: { workingDirectory?: string } = {}) {
  const manager = createTestSessionManagerFn()
  const internals = manager as unknown as Internals
  const workspace = {
    id: WORKSPACE_ID,
    name: 'Cron Store Lifecycle Workspace',
    slug: 'cron-store-lifecycle-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const id = `session-cron-lifecycle-${++sessionCounter}`
  const managed = createManagedSessionFn(
    { id, name: id, llmConnection: 'cron-lifecycle-pi' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  ) as unknown as ManagedForTest
  if (options.workingDirectory) managed.workingDirectory = options.workingDirectory
  internals.sessions.set(`${workspace.id}:${id}`, managed)
  return { internals, managed }
}

describe('the store anchors to the workspace root, never the working directory (T8 (a))', () => {
  it('a session inside a worktree writes to the workspace root', () => {
    const cwd = worktree()
    const { internals, managed } = harness({ workingDirectory: cwd })

    const service = internals.getOrCreateSessionCronService(managed)!
    const record = service.create({ schedule: '0 9 * * *', recurring: true, prompt: 'created in a worktree' })

    // The anchor. `exitWorktreeBeforeRuntimeSwitch` removes `cwd` before every
    // runtime switch, so a record written under it is a record thrown away.
    expect(existsSync(sessionCronFile(workspaceRoot, managed.id))).toBe(true)
    expect(existsSync(sessionCronFile(cwd, managed.id))).toBe(false)
    expect(openSessionCronStore(workspaceRoot, managed.id).list().map(task => task.id)).toEqual([record.id])
  })

  it('a store left at the legacy anchor is adopted when the service opens', () => {
    const cwd = worktree()
    const { internals, managed } = harness({ workingDirectory: cwd })
    // What a pre-T8 build wrote: the record sits under the session's cwd.
    const legacy = openSessionCronStore(cwd, managed.id)
      .create({ schedule: '0 9 * * *', recurring: true, prompt: 'written by the old anchor' })

    const service = internals.getOrCreateSessionCronService(managed)!

    expect(service.list().map(task => task.id)).toEqual([legacy.id])
    expect(service.list().map(task => task.prompt)).toEqual(['written by the old anchor'])
    expect(openSessionCronStore(workspaceRoot, managed.id).list().map(task => task.id)).toEqual([legacy.id])
    // Adopted, not copied: nothing is left behind to be adopted twice.
    expect(existsSync(sessionCronFile(cwd, managed.id))).toBe(false)
  })

  it('a session with no working directory is unchanged — the control', () => {
    const { internals, managed } = harness()
    const service = internals.getOrCreateSessionCronService(managed)!
    const record = service.create({ schedule: '0 9 * * *', recurring: true, prompt: 'no worktree here' })
    expect(openSessionCronStore(workspaceRoot, managed.id).list().map(task => task.id)).toEqual([record.id])
  })
})

describe('a rolled-back branch takes its per-session services with it (T8 (g))', () => {
  it('the preflight failure clears every per-session map it populated', async () => {
    const { internals: sourceInternals } = harness()
    const manager = sourceInternals as unknown as {
      createSession(workspaceId: string, options?: Record<string, unknown>): Promise<{ id: string }>
    }
    const internals = sourceInternals

    const source = await manager.createSession(WORKSPACE_ID, { name: 'Branch Source' })
    // A branch needs a parent SDK context and a message to branch at. Both are
    // seeded on the LIVE source session rather than in its JSONL, because
    // `createSession` re-persists the managed source from memory immediately
    // before it loads it back (`SessionManager.ts:10809`) — a file written here
    // would be overwritten by that flush, which is what the first attempt hit.
    const sourceManaged = internals.sessions.get(`${WORKSPACE_ID}:${source.id}`) as
      { sdkSessionId?: string; messages: unknown[] }
    sourceManaged.sdkSessionId = '2f24c2a1-4c1e-4f2b-9c6d-0f5a2b6a11c8'
    sourceManaged.messages.push({
      id: 'msg-branch-point', role: 'assistant', content: 'branch here', timestamp: Date.now(),
    })

    // What the real preflight does before it fails: `getOrCreateAgent` builds
    // the per-session services, and `ensureBranchReady` then throws.
    let branchSessionId = ''
    let branchKey = ''
    internals.getOrCreateAgent = async (managed: unknown) => {
      const target = managed as ManagedForTest
      branchSessionId = target.id
      branchKey = `${target.workspace.id}:${target.id}`
      internals.getOrCreateSessionCronService(target)!
        .create({ schedule: '0 9 * * *', recurring: true, prompt: 'armed by the preflight' })
      internals.piTaskServices.set(branchKey, { snapshot: () => ({ tasks: [] }) })
      internals.piGoalServices.set(branchKey, { snapshot: () => ({ goal: undefined }) })
      // T10 — the two maps the T8 pass missed. `deleteSession` clears both with
      // a plain delete, and the rollback is the same event by another name.
      internals.piPlanModeServices.set(branchKey, { state: () => undefined })
      internals.piMailboxServices.set(branchKey, { snapshot: () => ({ messages: [] }) })
      throw new Error('branch preflight refused')
    }

    await expect(manager.createSession(WORKSPACE_ID, {
      branchFromSessionId: source.id,
      branchFromMessageId: 'msg-branch-point',
    })).rejects.toThrow(/Could not create branch/)

    expect(branchKey).not.toBe('')
    expect(internals.sessions.has(branchKey)).toBe(false)
    // The three maps the rollback used to leave behind. The cron entry is the
    // one that mattered most: it owns a live `setInterval`.
    expect(internals.sessionCronServices.has(branchKey)).toBe(false)
    expect(internals.piTaskServices.has(branchKey)).toBe(false)
    expect(internals.piGoalServices.has(branchKey)).toBe(false)
    expect(internals.piPlanModeServices.has(branchKey)).toBe(false)
    expect(internals.piMailboxServices.has(branchKey)).toBe(false)
    // …and the store file went with the session that owned it.
    expect(existsSync(sessionCronFile(workspaceRoot, branchSessionId))).toBe(false)
  })
})
