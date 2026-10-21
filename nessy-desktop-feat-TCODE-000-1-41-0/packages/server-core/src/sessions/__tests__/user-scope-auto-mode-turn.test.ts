/**
 * P6.493 — the user scope's `autoMode` reaches the judge, and can only narrow it.
 *
 * The reader (`pi-harness/user-auto-mode-policy.ts`) and the trust boundary
 * (`resolveAutoMode`) were both built and both tested, and neither was WIRED:
 * `SessionManager` passed `managed` alone, so the narrowing guarded a path no
 * document could reach and a developer's own `autoMode` block did nothing at
 * all. What is pinned here is the seam — the block reaching `managedAutoMode`
 * through the production turn, and the refusal being announced rather than
 * swallowed.
 *
 * Delegated decision Q-den 2 = option C: `hard_deny`/`soft_deny` travel from the
 * user scope, `allow`/`environment` stay managed-only. B — the vendor's additive
 * user scope — was refused because it makes a safety judge's trust boundary
 * user-writable.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

setSessionPlatform(createHeadlessPlatform())

const roots: string[] = []
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'
const originalConfigDir = process.env[CONFIG_DIR_ENV]

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  // `delete` first on the restore path too: assigning to `process.env.X` in Bun
  // 1.3.14 can leave the name readable by property and invisible to a spread,
  // and every subprocess env in this tree is built by spreading `process.env`.
  delete process.env[CONFIG_DIR_ENV]
  if (originalConfigDir !== undefined) process.env[CONFIG_DIR_ENV] = originalConfigDir
})

type CapabilityTurn = { runtime: { managedAutoMode?: { readonly [key: string]: readonly string[] } } }

async function turnFor(userSettings: unknown): Promise<{
  runtime: CapabilityTurn['runtime']
  announced: string | undefined
}> {
  const root = mkdtempSync(join(tmpdir(), 'nessy-user-auto-mode-'))
  roots.push(root)
  const claudeDir = join(root, 'claude')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(userSettings))
  delete process.env[CONFIG_DIR_ENV]
  process.env[CONFIG_DIR_ENV] = claudeDir

  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  const manager = createTestSessionManager({
    // The MANAGED half of the composition, so the assertion is about ADDITION
    // rather than about a user scope acting alone.
    managedPiPolicy: { ...DEFAULT_MANAGED_PI_POLICY, autoMode: { hard_deny: ['managed rule'] } },
  })
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: workspaceRoot,
    createdAt: 1,
  }, { messagesLoaded: true, ephemeral: true, workingDirectory: workspaceRoot })
  managed.activeProvider = 'pi'
  const internals = manager as unknown as {
    sessions: Map<string, unknown>
    createCapabilityTurn(managed: unknown): Promise<CapabilityTurn>
    lastAnnouncedUserAutoModeNotice: string | undefined
    cleanup(): void
  }
  internals.sessions.set('workspace-a:session-a', managed)
  try {
    const turn = await internals.createCapabilityTurn(managed)
    return { runtime: turn.runtime, announced: internals.lastAnnouncedUserAutoModeNotice }
  } finally {
    internals.cleanup()
  }
}

describe('P6.493 — the user scope reaches the judge through the turn', () => {
  it('adds a user `hard_deny` to the managed one, and says nothing when there is nothing to refuse', async () => {
    const { runtime, announced } = await turnFor({ autoMode: { hard_deny: ['user rule'] } })
    expect(runtime.managedAutoMode?.hard_deny).toContain('managed rule')
    expect(runtime.managedAutoMode?.hard_deny).toContain('user rule')
    // A clean file is the ordinary case and must not produce a warning.
    expect(announced).toBeUndefined()
  })

  it('drops a user `allow` and names it, because a user scope may never widen the judge', async () => {
    const { runtime, announced } = await turnFor({
      autoMode: {
        hard_deny: ['user rule'],
        allow: ['Bash(rm:*)'],
        environment: ['this repository is a sandbox'],
      },
    })
    // The narrowing half: the entry is not in the composed policy…
    expect(runtime.managedAutoMode?.allow ?? []).not.toContain('Bash(rm:*)')
    // …and the ADDED half still is, so the refusal is per key, not per block.
    expect(runtime.managedAutoMode?.hard_deny).toContain('user rule')
    // The audible half: refused BY NAME, with managed settings named as the
    // only home. Silence here is the defect the row exists to close.
    expect(announced).toContain('autoMode.allow')
    expect(announced).toContain('autoMode.environment')
    expect(announced).toContain('Managed settings are the only home')
  })
})
