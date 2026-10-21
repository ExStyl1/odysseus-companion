/**
 * P2.469 — the `Cd` refusal names the rule and the scope, in BOTH places it
 * renders.
 *
 * P2.459 recorded this site as not rendering at all and left the carrier off
 * `CdPermissionEvaluationV1` for that reason. Measured, it rendered twice and
 * both halves carried the defect that row had just closed everywhere else:
 *
 *   - an OPERATOR log that said `rule claude-settings-deny-0` — the internal
 *     positional id P2.445 measured nobody has ever seen — while dropping the
 *     `scope` sitting in the same evaluation object;
 *   - a USER sentence that said "This directory is blocked by a Cd permission
 *     rule." and nothing else, because the gate threw a bare code and the RPC
 *     catch six thousand lines away turned that code into a constant.
 *
 * WHAT THIS SUITE REFUSES TO DO, for the reason P2.459 wrote down: no
 * hand-built policy ever reaches the evaluator. Every rule below is a real
 * document on disk that `permissionsConfigCache.getMergedConfig` loads,
 * `parsePermissionsJson` parses and `claudeSettingsPermissionDsl` compiles — so
 * the id the fallback would use is the POSITIONAL one the producer really mints
 * and the text is really the settings entry. A test that wrote its own id would
 * be asserting a name the user HAD seen, which is the whole thing being fixed.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

const SESSION_ID = 'session-cd-refusal'
const WORKSPACE_ID = 'ws-cd-refusal'

interface WorkingDirectoryErrorEvent { type: string; sessionId: string; error: string }

/**
 * One workspace whose `permissions.json` is written VERBATIM, and a real
 * `blocked/` directory inside it — `updateWorkingDirectory` calls `realpath`
 * before the gate ever runs, so a target that does not exist never reaches it.
 *
 * The rule strings anchor at the workspace root because that is the directory
 * `loadWorkspacePermissionsConfig` hands `parsePermissionsJson` as the settings
 * source, which is what a `Cd(/blocked)` entry resolves against.
 */
function fixture(permissionsDocument: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-cd-refusal-'))
  roots.push(stateRoot)
  const workspaceRoot = join(stateRoot, 'workspace')
  const projectPath = join(workspaceRoot, 'project')
  const blockedPath = join(workspaceRoot, 'blocked')
  mkdirSync(projectPath, { recursive: true })
  mkdirSync(blockedPath, { recursive: true })
  writeFileSync(join(workspaceRoot, 'permissions.json'), permissionsDocument)
  permissionsConfigCache.clear()

  const manager = createTestSessionManager({
    projectHandleService: new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(stateRoot, 'trust.json') }),
      newId: () => 'project-handle',
    }),
  })
  const internals = manager as unknown as Record<string, unknown>
  internals.strictDrainPiSession = async () => {}
  internals.strictDrainSessionForMutation = async () => {}

  const events: WorkingDirectoryErrorEvent[] = []
  internals.sendEvent = (event: WorkingDirectoryErrorEvent) => { events.push(event) }

  const workspace = {
    id: WORKSPACE_ID,
    name: 'Cd Refusal Workspace',
    slug: 'cd-refusal-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id: SESSION_ID, workingDirectory: projectPath, sdkCwd: projectPath },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${WORKSPACE_ID}:${SESSION_ID}`,
    managed,
  )
  return { manager, managed, projectPath, blockedPath, events }
}

/**
 * Drive the REAL RPC and collect both renderings of one refusal: the sentence
 * the user is sent, and the line the operator gets. `console.warn` is the
 * capture point because `sessionLog` is the module's console-backed fallback
 * until a platform is installed, and installing one is a process-wide global.
 */
async function refuse(permissionsDocument: string): Promise<{ user: string; log: string }> {
  const { manager, blockedPath, events } = fixture(permissionsDocument)
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    await manager.updateWorkingDirectory(SESSION_ID, blockedPath, WORKSPACE_ID)
  } finally {
    console.warn = realWarn
  }
  const failure = events.find(event => event.type === 'working_directory_error')
  expect(failure).toBeDefined()
  return {
    user: failure!.error,
    log: warnings.find(line => line.includes('refused by Cd permission rules')) ?? '',
  }
}

/** A Claude settings block — the producer that mints a POSITIONAL id. */
const settingsDeny = JSON.stringify({ permissions: { deny: ['Cd(/blocked)'] } })
const settingsAllowElsewhere = JSON.stringify({ permissions: { allow: ['Cd(/project)'] } })

describe('a Cd refusal names the rule and the scope', () => {
  it('tells the USER the rule string and the scope, and never the internal id', async () => {
    const { user } = await refuse(settingsDeny)

    expect(user).toBe('This directory is blocked by Cd permission rule `Cd(/blocked)` (workspace scope).')
    // The point of the row, asserted as its own row: the positional id the
    // producer really minted is the one thing that must NOT reach the user.
    expect(user).not.toContain('claude-settings-deny-0')
    expect(user).not.toBe('This directory is blocked by a Cd permission rule.')
  })

  it('tells the OPERATOR the same rule and scope, and keeps the id beside it', async () => {
    const { log } = await refuse(settingsDeny)

    expect(log).toContain('rule `Cd(/blocked)` (workspace scope)')
    // An operator log is the one place the internal join key is the useful
    // token, so it stays — the defect was that it was the ONLY token, with the
    // scope in the same object thrown away.
    expect(log).toContain('id claude-settings-deny-0')
    expect(log).not.toContain('rule claude-settings-deny-0)')
  })

  it('names the MECHANISM when allowlist mode refused, because no rule refused', async () => {
    const { user, log } = await refuse(settingsAllowElsewhere)

    expect(user).toBe(
      'This directory is blocked because Cd permission rules allow only specific directories and none matches this one.',
    )
    expect(user).not.toContain('rule `')
    expect(log).toContain('no allow rule matches')
  })

  it('names the SCOPE whose file to fix when the policy did not compile, not the synthetic id', async () => {
    // F1.831 — an unreadable workspace document is now dropped whole (it blocks no
    // `/cd`), so the workspace route that still reaches `invalidSource` is P2.269's
    // deny/ask rule-cap overflow, which fails closed whatever the scope.
    const overflow = Array.from({ length: 513 }, (_, index) => ({ id: `d${index}`, action: 'deny', match: { kind: 'bash', executable: `x${index}` } }))
    const { user, log } = await refuse(JSON.stringify({ permissionDsl: { version: 1, rules: overflow } }))

    expect(user).toBe('This directory is blocked because the permission policy is invalid (workspace scope).')
    // The operator half asserted separately, because it is the ONE path where
    // the describer's own refusal of the synthetic id is load-bearing: the user
    // sentence short-circuits before the describer runs, the log does not.
    expect(log).toContain('no rule named')
    expect(log).not.toContain('rule `invalid-policy`')
    // `invalid-policy` is a synthetic report, not a rule anybody wrote. The tool
    // gate is protected from naming it by preferring its diagnostic; the Cd
    // evaluation carries no diagnostic, so the describer refuses it directly.
    expect(user).not.toContain('invalid-policy')
  })

  it('falls back to the id for an author-written rule, where the id IS what the author wrote', async () => {
    const { manager, blockedPath, events } = fixture('{}')
    // Rewritten after the fixture resolved the path, because an author-written
    // `permissionDsl` names an absolute pattern rather than a settings-relative
    // one. Still the production loader: only the document shape differs.
    const workspaceRoot = join(blockedPath, '..')
    writeFileSync(join(workspaceRoot, 'permissions.json'), JSON.stringify({
      permissionDsl: {
        version: 1,
        rules: [{
          id: 'cd-deny-authored',
          action: 'deny',
          match: { kind: 'cdPath', pattern: blockedPath.replace(/^\//, ''), anchor: 'absolute' },
        }],
      },
    }))
    permissionsConfigCache.clear()

    await manager.updateWorkingDirectory(SESSION_ID, blockedPath, WORKSPACE_ID)

    const failure = events.find(event => event.type === 'working_directory_error')
    expect(failure?.error).toBe('This directory is blocked by Cd permission rule `cd-deny-authored` (workspace scope).')
  })

  it('lets a permitted move through — the positive control for every refusal above', async () => {
    const { manager, managed, projectPath, events } = fixture(settingsDeny)

    await manager.updateWorkingDirectory(SESSION_ID, projectPath, WORKSPACE_ID)

    expect(events.some(event => event.type === 'working_directory_error')).toBe(false)
    // `updateWorkingDirectory` canonicalizes before the gate runs, so the
    // committed value is the resolved path — on macOS `/var` is a symlink to
    // `/private/var`, which is exactly the hop the gate's `alternatePaths` exist
    // to cover and why the settings rule above matches either spelling.
    expect((managed as { workingDirectory?: string }).workingDirectory).toBe(realpathSync(projectPath))
  })
})
