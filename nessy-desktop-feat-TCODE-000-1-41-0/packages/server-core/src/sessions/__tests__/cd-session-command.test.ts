/**
 * P6.509 · `/cd <path>` — the command half of the `Cd` vocabulary.
 *
 * The rules half has been compiled since `permissions-config.ts` learned
 * `cdPath`, and `cd-permission-gate.test.ts` beside this file proves the gate
 * refuses a user-driven move. What none of it reached was a COMMAND: the only
 * two ways to move a session were the folder picker and the
 * `updateWorkingDirectory` RPC, neither reachable from `-p`, from `apps/cli` or
 * from the headless server. `permissions.md` § Cd says the rules "apply only
 * when you run `/cd` yourself", so until this command existed they compiled for
 * a control nobody could reach.
 *
 * **Option B-prime is what these assertions are about.** The delegated option B
 * asked the result line to say that skills and the capability snapshot were NOT
 * re-resolved; W8-j measured that false, because `mutateWorkingDirectory`
 * already invalidates both on every successful move. So the line these tests
 * pin is the honest one — what the move DID re-resolve, and what it did not —
 * and the test asserts on both halves, because the second half is the one a
 * later change is most likely to make untrue without noticing.
 *
 * Harness: `cd-permission-gate.test.ts`'s, verbatim in shape — the real
 * transaction, the real rule tiers, only the drain stubbed.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { permissionsConfigCache } from '@nessy-agent/shared/agent'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { parseSessionCommand } from '@nessy-agent/shared/slash-commands/session-command'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  permissionsConfigCache.clear()
})

/** `//abs` anchor patterns are rooted at `/`, so the leading slash is dropped. */
const absolutePattern = (path: string, suffix = ''): string => `${path.replace(/^\//, '')}${suffix}`

type Runtime = 'pi' | 'anthropic' | 'codex-runtime'

/**
 * The three runtimes the row asks for an allowed and a refused move on.
 *
 * They are driven through ONE fixture on purpose: the executor takes no runtime
 * argument and calls nothing that resolves one — the working directory is a
 * host record — so this is uniformity by construction rather than three
 * implementations that happen to agree today. The tag is set anyway, so the day
 * a runtime branch appears in this path the pinning is already here.
 */
const RUNTIMES: Runtime[] = ['pi', 'anthropic', 'codex-runtime']

function fixture(runtime: Runtime, buildRules: (paths: { projectPath: string; blockedPath: string }) => Array<{ id: string; action: 'allow' | 'ask' | 'deny'; match: unknown }>) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-cd-command-'))
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
  ;(manager as any).resolveManagedProvider = () => runtime

  const workspace = {
    id: 'ws-cd-cmd',
    name: 'Cd Command Workspace',
    slug: 'cd-command-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id: 'session-cd-cmd', workingDirectory: projectPath, sdkCwd: projectPath },
    workspace,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspace.id}:${managed.id}`,
    managed,
  )
  const run = async (typed: string): Promise<string> => {
    const parsed = parseSessionCommand(typed)
    if (parsed?.kind !== 'cd') throw new Error(`not a /cd command: ${typed}`)
    const before = managed.messages.length
    await (manager as any).runCdSessionCommand(managed, parsed)
    const written = managed.messages.slice(before)
    expect(written).toHaveLength(1)
    // Read the value into a local BEFORE asserting a shape on the object: an
    // asymmetric matcher inside `toMatchObject` overwrites the field it matched.
    const entry = written[0] as { role: string; content: string }
    expect(entry.role).toBe('info')
    return entry.content
  }
  return { manager, managed, projectPath, blockedPath, run }
}

const denyBlocked = ({ blockedPath }: { blockedPath: string }) => [{
  id: 'cd-deny',
  action: 'deny' as const,
  match: { kind: 'cdPath', pattern: absolutePattern(blockedPath), anchor: 'absolute' },
}]

describe('P6.509 · /cd parses as a session command', () => {
  it('takes the rest of the line as the path, and the bare form is a usage error rather than prose', () => {
    expect(parseSessionCommand('/cd /tmp/project')).toEqual({ kind: 'cd', path: '/tmp/project' })
    // A directory may contain spaces, so unlike `/config` and `/resume` the
    // argument is NOT `[\w.-]+` — the whole rest of the line is the path.
    expect(parseSessionCommand('/cd /tmp/My Project')).toEqual({ kind: 'cd', path: '/tmp/My Project' })
    expect(parseSessionCommand('  /CD   /tmp/project  ')).toEqual({ kind: 'cd', path: '/tmp/project' })
    // The bare form is claimed, with an empty path: the executor reports usage,
    // exactly as `/subtask` with no task does.
    expect(parseSessionCommand('/cd')).toEqual({ kind: 'cd', path: '' })
  })

  it('does not claim a mention inside a sentence, nor a different command that starts with the same letters', () => {
    expect(parseSessionCommand('what does /cd do?')).toBeNull()
    expect(parseSessionCommand('/cdn /tmp')).toBeNull()
    expect(parseSessionCommand('/clear')).not.toMatchObject({ kind: 'cd' })
  })
})

describe.each(RUNTIMES)('P6.509 · /cd moves the session on %s', runtime => {
  it('moves an allowed directory and names what was re-resolved and what was not', async () => {
    const { managed, projectPath, blockedPath, run } = fixture(runtime, () => [])

    const content = await run(`/cd ${blockedPath}`)

    // The session records the CANONICAL path, not the one that was typed — the
    // executor resolves it exactly as the `updateWorkingDirectory` RPC does, so
    // on this platform `/var/...` is stored as `/private/var/...`. Asserting on
    // the typed string would have passed on Linux and failed here.
    const canonicalBlocked = realpathSync(blockedPath)
    expect(managed.workingDirectory).toBe(canonicalBlocked)
    expect(managed.workingDirectory).not.toBe(realpathSync(projectPath))
    expect(content).toContain(canonicalBlocked)
    // Option B-prime's first half: the move DID re-resolve these, so the line
    // says so instead of B's sentence, which would have been false when printed.
    expect(content).toContain('Re-resolved')
    expect(content).toContain('skills')
    expect(content).toContain('capability snapshot')
    // And its second half, which is the one a later change is most likely to
    // make untrue: nothing in the transaction reconnects an MCP client or
    // re-reads memory.
    expect(content).toContain('NOT re-resolved')
    expect(content).toContain('MCP servers already connected')
    expect(content).toContain('memory is unchanged')
  })

  it('reports a Cd refusal in the command\'s own answer and leaves the directory alone', async () => {
    const { managed, projectPath, blockedPath, run } = fixture(runtime, denyBlocked)

    const content = await run(`/cd ${blockedPath}`)

    // The refusal is the EXISTING gate's sentence, not a second spelling.
    expect(managed.workingDirectory).toBe(projectPath)
    expect(managed.workingDirectory).not.toBe(realpathSync(blockedPath))
    expect(content).toContain('The working directory was not changed')
    expect(content).toContain('Cd')
    expect(content).not.toContain('Re-resolved')
  })
})

describe('P6.509 · the answers that are not a move', () => {
  it('reports usage for the bare form, and refuses a path that is not a directory, without touching the session', async () => {
    const { managed, projectPath, run } = fixture('pi', () => [])

    expect(await run('/cd')).toContain('Usage: /cd <path>')
    expect(managed.workingDirectory).toBe(projectPath)

    const missing = await run(`/cd ${join(projectPath, 'no-such-directory')}`)
    expect(missing).toContain('The working directory was not changed')
    expect(managed.workingDirectory).toBe(projectPath)
  })
})
