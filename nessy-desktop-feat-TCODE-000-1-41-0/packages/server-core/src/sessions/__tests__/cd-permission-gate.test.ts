/**
 * `Cd` rules on the working-directory transaction (permissions.md § Cd).
 *
 * "`Cd` rules control which directories the `/cd` command can move the session
 * to. `Cd` is not a model-invocable tool: Claude can't call it, and the rules
 * apply only when you run `/cd` yourself."
 *
 * `mutateWorkingDirectory` is the one transaction every cwd move goes through,
 * so the gate lives there and is opted into by the user-driven callers only.
 * These drive the real transaction and the real rule tiers; only the drain is
 * stubbed, as in `worktree-working-directory.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { permissionsConfigCache } from '@nessy-agent/shared/agent'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  permissionsConfigCache.clear()
})

interface CdPaths { projectPath: string; blockedPath: string }
type RuleBuilder = (paths: CdPaths) => Array<{ id: string; action: 'allow' | 'ask' | 'deny'; match: unknown }>

/** `//abs` anchor patterns are rooted at `/`, so the leading slash is dropped. */
const absolutePattern = (path: string, suffix = ''): string => `${path.replace(/^\//, '')}${suffix}`

function fixture(buildRules: RuleBuilder) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-cd-rules-'))
  roots.push(stateRoot)
  const projectPath = join(stateRoot, 'project')
  const blockedPath = join(stateRoot, 'blocked')
  const workspaceRoot = join(stateRoot, 'workspace')
  mkdirSync(projectPath, { recursive: true })
  mkdirSync(blockedPath, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(
    join(workspaceRoot, 'permissions.json'),
    JSON.stringify({ permissionDsl: { version: 1, rules: buildRules({ projectPath, blockedPath }) } }),
  )
  permissionsConfigCache.clear()

  const manager = createTestSessionManager({
    projectHandleService: new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(stateRoot, 'trust.json') }),
      newId: () => 'project-handle',
    }),
  })
  ;(manager as any).strictDrainPiSession = async () => {}
  ;(manager as any).strictDrainSessionForMutation = async () => {}

  const workspace = {
    id: 'ws-cd',
    name: 'Cd Workspace',
    slug: 'cd-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id: 'session-cd', workingDirectory: projectPath, sdkCwd: projectPath },
    workspace,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspace.id}:${managed.id}`,
    managed,
  )
  return { manager, managed, projectPath, blockedPath }
}

const denyBlocked: RuleBuilder = ({ blockedPath }) => [{
  id: 'cd-deny',
  action: 'deny',
  match: { kind: 'cdPath', pattern: absolutePattern(blockedPath), anchor: 'absolute' },
}]

describe('Cd rules gate the working-directory transaction', () => {
  it('refuses a user-driven move a deny rule names', async () => {
    const { manager, managed, blockedPath } = fixture(denyBlocked)

    await expect((manager as any).mutateWorkingDirectory(managed, {
      intent: 'keep', path: blockedPath, userInitiated: true,
    })).rejects.toThrow('session-cd-denied')
    expect(managed.workingDirectory).not.toBe(blockedPath)
  })

  it('leaves an agent-driven move alone — Cd is not model-invocable', async () => {
    const { manager, managed, blockedPath } = fixture(denyBlocked)

    await (manager as any).mutateWorkingDirectory(managed, {
      intent: 'keep', path: blockedPath, preserveSdkCwd: true,
    })
    expect(managed.workingDirectory).toBe(blockedPath)
  })

  it('allowlist mode refuses a target no allow rule matches', async () => {
    const { manager, managed, projectPath, blockedPath } = fixture(paths => [{
      id: 'cd-allow',
      action: 'allow',
      match: { kind: 'cdPath', pattern: absolutePattern(paths.projectPath, '/**'), anchor: 'absolute' },
    }])

    await expect((manager as any).mutateWorkingDirectory(managed, {
      intent: 'keep', path: blockedPath, userInitiated: true,
    })).rejects.toThrow('session-cd-denied')

    await (manager as any).mutateWorkingDirectory(managed, {
      intent: 'keep', path: projectPath, userInitiated: true,
    })
    expect(managed.workingDirectory).toBe(projectPath)
  })

  it('moves freely when no Cd rule is configured', async () => {
    const { manager, managed, blockedPath } = fixture(() => [])

    await (manager as any).mutateWorkingDirectory(managed, {
      intent: 'keep', path: blockedPath, userInitiated: true,
    })
    expect(managed.workingDirectory).toBe(blockedPath)
  })
})
