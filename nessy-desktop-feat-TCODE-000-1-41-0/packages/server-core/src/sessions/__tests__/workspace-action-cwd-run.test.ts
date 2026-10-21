/**
 * P6.720 — a saved action's `cwd` is honoured at RUN, under the parser's own
 * containment.
 *
 * `WorkspaceAction.cwd` was parsed, contained at declaration time and then
 * DROPPED: `runShellCommand` took no working directory, so an action declaring
 * `cwd: sub/dir` ran at the session root and said nothing — accepted-and-ignored,
 * the shape this plan exists to remove. The host half (`resolveWorkspaceActionCwd`
 * and the store rule) landed in `9d517d423`; what is pinned here is the executor.
 *
 * The containment is applied HERE rather than at the caller on purpose: this
 * method is reachable from the session `command` verb as well as from the
 * saved-actions one, so a caller-resolved absolute path would make the
 * direct-shell seam widenable by whoever calls it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

setSessionPlatform(createHeadlessPlatform())

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * The executor is stubbed rather than run, and it returns `executed: false` so
 * the method's early return short-circuits the persist/flush/respond tail. What
 * is under test is the ONE argument the row is about — the directory the command
 * would have been spawned in — so a stub that records it is a stronger reading
 * than a real `pwd`, whose output would also depend on symlink resolution in the
 * temp directory.
 */
function rig() {
  const root = mkdtempSync(join(tmpdir(), 'nessy-action-cwd-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(join(workspaceRoot, 'sub', 'dir'), { recursive: true })
  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: workspaceRoot,
    createdAt: 1,
  }, { messagesLoaded: true, ephemeral: true, workingDirectory: workspaceRoot })
  // Not `default`: that mode asks for approval before the executor is reached,
  // and the approval card is not what this row is about.
  managed.permissionMode = 'acceptEdits'
  const spawnedIn: string[] = []
  const internals = manager as unknown as {
    sessions: Map<string, unknown>
    executeDirectShellCommand(command: string, cwd: string): Promise<unknown>
    cleanup(): void
  }
  internals.sessions.set('workspace-a:session-a', managed)
  internals.executeDirectShellCommand = async (_command, cwd) => {
    spawnedIn.push(cwd)
    return { executed: false, stdout: '', stderr: '', error: 'stub' }
  }
  return { manager, internals, workspaceRoot, spawnedIn }
}

describe('P6.720 — `cwd` reaches the executor, contained', () => {
  it('runs a declared relative `cwd` there, and the session root without one', async () => {
    const h = rig()
    try {
      const declared = await h.manager.runShellCommand('session-a', 'pwd', 'workspace-a', 'sub/dir')
      expect(h.spawnedIn[0]).toBe(join(h.workspaceRoot, 'sub', 'dir'))
      expect(declared.cwd).toBe(join(h.workspaceRoot, 'sub', 'dir'))

      // The control: an action without a `cwd` is byte-identical to today.
      const plain = await h.manager.runShellCommand('session-a', 'pwd', 'workspace-a')
      expect(h.spawnedIn[1]).toBe(h.workspaceRoot)
      expect(plain.cwd).toBe(h.workspaceRoot)
    } finally {
      h.internals.cleanup()
    }
  })

  it('refuses a `cwd` that escapes the workspace, by name, without spawning', async () => {
    const h = rig()
    try {
      const escaped = await h.manager.runShellCommand('session-a', 'pwd', 'workspace-a', '../outside')
      expect(escaped.blocked).toBe(true)
      expect(escaped.executed).toBe(false)
      // The parser's own words, not a second wording invented at the executor.
      expect(escaped.error).toContain('must be within the workspace root')
      // Refused BEFORE the spawn, which is the whole point of containing it here.
      expect(h.spawnedIn).toHaveLength(0)
      // The report still names where the session runs, so the refusal is legible.
      expect(escaped.cwd).toBe(h.workspaceRoot)
    } finally {
      h.internals.cleanup()
    }
  })
})
