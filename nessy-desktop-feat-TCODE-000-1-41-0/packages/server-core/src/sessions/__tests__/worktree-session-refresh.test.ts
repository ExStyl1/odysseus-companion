/**
 * F1.11 (option (b)) — the SessionManager half: a session whose project is a linked `git worktree` answers to its
 * main checkout's project-scope plugin changes, live.
 *
 * The input builder reads the checkout's project records for a worktree context
 * (`bootstrap/__tests__/worktree-plugin-activation.test.ts`), so the worktree's NEXT turn already sees a plugin
 * enabled for the repository. What that cannot reach is a session that is already running: a project-scope
 * mutation made from the checkout is scoped to the CHECKOUT's `ProjectKey`, and `refreshPluginRuntime` matched
 * `managed.projectKey` alone — so a live worktree session kept its old plugins until it rebuilt for another reason.
 * `createCapabilityTurn` now records the main checkout's key beside the session's own, and the refresh matcher (like
 * the resolver's `leaseMatchesScope`) accepts either.
 *
 * Real git, a real `SessionManager` (`createTestSessionManager`), its real `createCapabilityTurn` and
 * `refreshPluginRuntime`; the sessions carry no agent, so each affected one reports `untouched` — the count is what
 * says which sessions the refresh reached.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProjectIdentity } from '@nessy-agent/shared/projects/project-identity'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function mint() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'f111-sm-')))
  roots.push(dir)
  const checkout = join(dir, 'main')
  const worktree = join(dir, 'wt')
  const outside = join(dir, 'elsewhere')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
  execFileSync('git', ['init', '-q', '-b', 'main', checkout], { stdio: 'ignore' })
  writeFileSync(join(checkout, 'README.md'), 'F1.11 fixture.\n', 'utf8')
  git(checkout, 'config', 'user.email', 'lane@example.invalid')
  git(checkout, 'config', 'user.name', 'lane')
  git(checkout, 'add', 'README.md')
  git(checkout, 'commit', '-q', '-m', 'seed')
  git(checkout, 'worktree', 'add', '-q', worktree, '-b', 'f111-sm')
  execFileSync('git', ['init', '-q', '-b', 'main', outside], { stdio: 'ignore' })
  return { dir, checkout, worktree, outside }
}

describe('F1.11 — a live worktree session answers to its main checkout', () => {
  it('createCapabilityTurn records the main checkout key for a worktree session, and none for the checkout itself', async () => {
    const { dir, checkout, worktree } = mint()
    const sm = createTestSessionManager() as any
    try {
      const workspace = { id: 'ws-f111', name: 'ws-f111', slug: 'ws-f111', rootPath: join(dir, 'ws'), createdAt: Date.now() }
      const inTree = createManagedSession({ id: 'in-tree', workingDirectory: worktree }, workspace, { messagesLoaded: true, ephemeral: true })
      const inMain = createManagedSession({ id: 'in-main', workingDirectory: checkout }, workspace, { messagesLoaded: true, ephemeral: true })
      sm.sessions.set('ws-f111:in-tree', inTree)
      sm.sessions.set('ws-f111:in-main', inMain)
      const keyMain = (await resolveProjectIdentity(checkout)).projectKey
      const keyTree = (await resolveProjectIdentity(worktree)).projectKey

      const turnTree = await sm.createCapabilityTurn(inTree)
      const turnMain = await sm.createCapabilityTurn(inMain)
      try {
        // Its OWN key is unchanged — identity (and so trust) stays per directory …
        expect(inTree.projectKey).toBe(keyTree)
        // … and the checkout's key rides beside it.
        expect(inTree.mainCheckoutProjectKey).toBe(keyMain)
        // CONTROL — the checkout is not a worktree of anything.
        expect(inMain.projectKey).toBe(keyMain)
        expect(inMain.mainCheckoutProjectKey).toBeUndefined()
      } finally {
        sm.capabilityResolver.releaseSnapshot(turnTree.snapshot.leaseId)
        sm.capabilityResolver.releaseSnapshot(turnMain.snapshot.leaseId)
      }
    } finally {
      sm.cleanup()
    }
  })

  it('a refresh keyed on the checkout reaches the worktree session; an unrelated project is not reached', async () => {
    const { dir, checkout, worktree, outside } = mint()
    const sm = createTestSessionManager() as any
    try {
      const workspace = { id: 'ws-f111', name: 'ws-f111', slug: 'ws-f111', rootPath: join(dir, 'ws'), createdAt: Date.now() }
      const keyMain = (await resolveProjectIdentity(checkout)).projectKey
      const register = (id: string, projectKey: string, mainCheckoutProjectKey?: string) => {
        const managed = createManagedSession({ id }, workspace, { messagesLoaded: true, ephemeral: true })
        managed.projectKey = projectKey
        if (mainCheckoutProjectKey) (managed as { mainCheckoutProjectKey?: string }).mainCheckoutProjectKey = mainCheckoutProjectKey
        sm.sessions.set(`ws-f111:${id}`, managed)
      }
      register('in-main', keyMain)
      register('in-tree', (await resolveProjectIdentity(worktree)).projectKey, keyMain)
      register('elsewhere', (await resolveProjectIdentity(outside)).projectKey)

      const summary = await sm.refreshPluginRuntime('ws-f111', keyMain, 'plugin enable')
      const reached = summary.applied + summary.deferred + summary.untouched + (summary.reloaded ?? 0)
      expect(reached).toBe(2)
    } finally {
      sm.cleanup()
    }
  })
})
