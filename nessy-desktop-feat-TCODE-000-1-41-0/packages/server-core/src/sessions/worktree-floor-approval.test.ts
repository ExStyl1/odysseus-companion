import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const configDir = mkdtempSync(join(tmpdir(), 'sm-worktree-floor-config-'))
const configWorkspaceRoot = join(configDir, 'workspaces', 'worktree-floor-workspace')
mkdirSync(configWorkspaceRoot, { recursive: true })
writeFileSync(
  join(configWorkspaceRoot, 'config.json'),
  JSON.stringify({
    id: 'ws-config-worktree-floor',
    name: 'Worktree Floor Workspace',
    slug: 'worktree-floor-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)
writeFileSync(
  join(configDir, 'config.json'),
  JSON.stringify({
    workspaces: [{
      id: 'ws-config-worktree-floor',
      name: 'Worktree Floor Workspace',
      rootPath: configWorkspaceRoot,
      createdAt: Date.now(),
    }],
    activeWorkspaceId: 'ws-config-worktree-floor',
    activeSessionId: null,
    defaultLlmConnection: 'worktree-floor-conn',
    llmConnections: [{
      slug: 'worktree-floor-conn',
      name: 'Worktree Floor Connection',
      providerType: 'pi',
      authType: 'api_key',
      createdAt: Date.now(),
    }],
  }, null, 2),
  'utf-8',
)
const originalConfigDir = process.env.NESSY_CONFIG_DIR
process.env.NESSY_CONFIG_DIR = configDir

let createManagedSessionFn: typeof import('./SessionManager.ts')['createManagedSession']
let createTestSessionManagerFn: typeof import('./__tests__/test-session-manager.ts')['createTestSessionManager']
let runPreToolUseChecksFn: typeof import('@nessy-agent/shared/agent')['runPreToolUseChecks']
let setPermissionModeFn: typeof import('@nessy-agent/shared/agent')['setPermissionMode']

type SessionManagerInstance = InstanceType<typeof import('./SessionManager.ts')['SessionManager']>

type ManagedForTest = {
  id: string
  workspace: { id: string }
  agent: {
    respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void
  }
}

/** The minimal PermissionManagerLike the gate needs; nothing is whitelisted. */
const permissionManagerStub = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: (command: string) => command.trim().split(/\s+/)[0] ?? '',
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

/**
 * R2: the worktree approval floor's prompt must be APPROVABLE through the real
 * chain — gate result -> `requestPiToolApproval` (the Pi permission service's
 * interactive seam) -> `handleAgentPermissionRequest` -> `respondToPermission`.
 *
 * The pre-fix defect: the floor emitted `promptType: 'admin_approval'` with NO
 * `command`, so `handleAgentPermissionRequest` never registered it with the
 * privileged-execution broker (that registration requires a command), while
 * `respondToPermission` still routed every `admin_approval` answer through
 * `privilegedExecutionBroker.resolveApproval` — which fails closed with "No
 * pending privileged request found". Clicking Approve settled the resolver
 * `false`: Approve did nothing.
 *
 * These tests feed the gate's REAL emitted prompt into the chain, so re-emitting
 * the floor as a bare `admin_approval` turns the approve test red again.
 */
describe('worktree approval floor — the prompt can actually be approved (R2)', () => {
  let tmpRoot: string
  let sm: SessionManagerInstance
  let managed: ManagedForTest
  let events: SessionEvent[]
  let agentResponses: Array<{ requestId: string; allowed: boolean }>

  // P6.137 — this hook pays a `SessionManager.ts`-rooted import against bun's
  // 5 s default, and the import is DELIBERATE: `NESSY_CONFIG_DIR` is written at
  // module scope above and a static top-level import would load the module
  // before that assignment, defeating the isolation. So rule 24's fix (hoist the
  // import) is not available here and the budget is, which is the family's own
  // second answer (`module-graph-budgets.ts`).
  //
  // MEASURED 2026-09-08 at load ~12, on this rig, twice: importing
  // `SessionManager.ts` alone cost **112.5 s** and **89.8 s** wall — 18x and 22x
  // the 5 s default — so the hook could not have passed at any load resembling
  // today's, and the suite reported `0 pass / 1 fail` with ZERO assertion
  // failures. Not a regression of this row: the row's own new floor suite passes
  // beside it, and this hook's cost is the graph, not the change.
  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager
    const shared = await import('@nessy-agent/shared/agent')
    runPreToolUseChecksFn = shared.runPreToolUseChecks
    setPermissionModeFn = shared.setPermissionMode
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-worktree-floor-'))
    sm = createTestSessionManagerFn()
    events = []
    agentResponses = []
    sm.setEventSink(((...args: unknown[]) => {
      events.push(args[2] as SessionEvent)
    }) as Parameters<SessionManagerInstance['setEventSink']>[0])

    const workspace = {
      id: 'ws_worktree_floor',
      name: 'Worktree Floor Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    managed = createManagedSessionFn(
      { id: 'session_worktree_floor', name: 'worktree floor', llmConnection: 'worktree-floor-conn' },
      workspace as never,
      { messagesLoaded: true },
    ) as unknown as ManagedForTest
    managed.agent = {
      respondToPermission: (requestId, allowed) => {
        agentResponses.push({ requestId, allowed })
      },
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${managed.workspace.id}:${managed.id}`, managed)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true })
    if (originalConfigDir === undefined) {
      delete process.env.NESSY_CONFIG_DIR
    } else {
      process.env.NESSY_CONFIG_DIR = originalConfigDir
    }
  })

  /** Run the REAL gate and return its prompt result for the given call. */
  function gatePrompt(toolName: string, input: Record<string, unknown>, worktree?: { repoRoot: string }) {
    const sessionKey = { workspaceId: managed.workspace.id, sessionId: managed.id }
    setPermissionModeFn(sessionKey, 'default', { changedBy: 'user' })
    const result = runPreToolUseChecksFn({
      toolName,
      input,
      sessionId: managed.id,
      sessionKey,
      permissionMode: 'default',
      workspaceRootPath: tmpRoot,
      workspaceId: managed.workspace.id,
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      permissionManager: permissionManagerStub,
      ...(worktree ? { worktree } : {}),
    })
    if (result.type !== 'prompt') throw new Error(`expected the gate to prompt, got ${result.type}`)
    return result
  }

  /** Feed a gate prompt through the Pi interactive approval seam. */
  function requestApproval(decisionId: string, toolName: string, prompt: ReturnType<typeof gatePrompt>) {
    return (sm as unknown as {
      requestPiToolApproval(
        managed: ManagedForTest,
        request: Record<string, unknown>,
      ): Promise<{ allowed: boolean; canonicalInput?: Record<string, unknown> }>
    }).requestPiToolApproval(managed, {
      decisionId,
      toolName,
      type: prompt.promptType,
      description: prompt.description,
      command: prompt.command,
      appName: prompt.appName,
      reason: prompt.reason,
      impact: prompt.impact,
      requiresSystemPrompt: prompt.requiresSystemPrompt,
      rememberForMinutes: prompt.rememberForMinutes,
      commandHash: prompt.commandHash,
      approvalTtlSeconds: prompt.approvalTtlSeconds,
    })
  }

  const floorCall = () => gatePrompt(
    'EnterWorktree',
    { path: '/somewhere/else' },
    { repoRoot: join(tmpdir(), 'some-repo') },
  )

  it('clicking Approve approves the floor prompt (the operation proceeds)', async () => {
    const prompt = floorCall()
    // The floor is non-negotiable and carries no don't-ask-again fields.
    expect(prompt.nonNegotiable).toBe('worktreeApproval')
    expect(prompt.command).toBeUndefined()
    expect(prompt.commandHash).toBeUndefined()

    const outcome = requestApproval('floor-approve', 'EnterWorktree', prompt)
    expect(sm.respondToPermission(managed.id, 'floor-approve', true, false)).toBe(true)
    expect(await outcome).toEqual({ allowed: true, canonicalInput: undefined })
    // The answer settled through the direct resolver, never the agent channel.
    expect(agentResponses).toEqual([])

    // The card the renderer saw: the floor's own prompt type, and no
    // always-allow offer — "choosing 'don't ask again' doesn't suppress this
    // prompt" (worktrees.md), so the button must not be shown.
    const published = events.find(event => event.type === 'permission_request') as
      | { request: { type?: string; noAlwaysAllow?: boolean } }
      | undefined
    expect(published?.request.type).toBe(prompt.promptType)
    expect(published?.request.noAlwaysAllow).toBe(true)
  })

  it('clicking Deny denies the floor prompt', async () => {
    const outcome = requestApproval('floor-deny', 'EnterWorktree', floorCall())
    expect(sm.respondToPermission(managed.id, 'floor-deny', false, false)).toBe(true)
    expect(await outcome).toEqual({ allowed: false, canonicalInput: undefined })
  })

  // The three real privileged-execution forms (the broker's installer-only
  // policy) must keep flowing THROUGH the broker and still be approvable.
  const installerCommands = [
    'brew install --cask firefox',
    'brew upgrade --cask firefox',
    'installer -pkg /tmp/pkg.pkg -target /',
  ]
  for (const command of installerCommands) {
    it(`the privileged admin_approval form still works: ${command}`, async () => {
      const prompt = gatePrompt('Bash', { command })
      expect(prompt.promptType).toBe('admin_approval')
      expect(prompt.command).toBe(command)

      const decisionId = `admin-${command.split(' ')[0]}-${installerCommands.indexOf(command)}`
      const outcome = requestApproval(decisionId, 'Bash', prompt)
      expect(sm.respondToPermission(managed.id, decisionId, true, false)).toBe(true)
      expect((await outcome).allowed).toBe(true)
    })
  }

  it('a restart-settled answer never stands in for the human on the floor', async () => {
    // The floor was covered by the `admin_approval` exclusion until it got its
    // own type; keeping it excluded is what stops the rename from quietly
    // widening a floor that "only `bypassPermissions` mode skips".
    ;(managed as unknown as { restartApprovalAnswer: unknown }).restartApprovalAnswer = {
      toolName: 'EnterWorktree',
      type: 'worktree_approval',
      expiresAt: Date.now() + 60_000,
    }
    const outcome = requestApproval('floor-restart', 'EnterWorktree', floorCall())

    // The prompt is SHOWN rather than auto-approved…
    expect(events.filter(event => event.type === 'permission_request')).toHaveLength(1)
    // …and the stored answer is still sitting there, unconsumed.
    expect((managed as unknown as { restartApprovalAnswer?: unknown }).restartApprovalAnswer).toBeDefined()

    // It is still answerable by the human, which is the point.
    expect(sm.respondToPermission(managed.id, 'floor-restart', true, false)).toBe(true)
    expect((await outcome).allowed).toBe(true)
  })

  it('a privileged admin_approval deny still fails closed through the broker', async () => {
    const prompt = gatePrompt('Bash', { command: 'brew install --cask firefox' })
    const outcome = requestApproval('admin-deny', 'Bash', prompt)
    expect(sm.respondToPermission(managed.id, 'admin-deny', false, false)).toBe(true)
    expect((await outcome).allowed).toBe(false)
  })
})
