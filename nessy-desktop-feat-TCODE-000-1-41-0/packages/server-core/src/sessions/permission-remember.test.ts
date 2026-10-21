import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR, addLlmConnection, getLlmConnection } from '@nessy-agent/shared/config'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { persistedRulesAllow } from './__tests__/persisted-bash-rule-bound.ts'
/**
 * F1.129 — THE CONNECTION FIXTURE IS STORED THROUGH THE REAL API, INTO THIS
 * PROCESS'S OWN ISOLATED CONFIG DIR, and asserted before any arm runs.
 *
 * Until 2026-09-23 this file wrote a `config.json` into its own `mkdtemp` and
 * assigned `process.env.NESSY_CONFIG_DIR` in its MODULE BODY. That reached
 * nothing: `bunfig.toml`'s preload isolates the config dir first and
 * `config/paths.ts` freezes `CONFIG_DIR` before any test module runs (AGENTS.md
 * §Traps, 2026-09-20). So `permission-remember-conn` resolved to NO connection
 * and `resolveBackendContext` fell back to the named default `'pi'` — which
 * happens to be the fixture's own provider, so the repository-rule case below
 * passed on the fallback, measuring not what it reads as measuring. The failing
 * arm, taken on the old fixture: the resolver answered `'pi'`, and
 * `getLlmConnection('permission-remember-conn')` answered `undefined`.
 *
 * Dropped with it, because they were equally unreachable: the module-body
 * workspace entry and its `defaultLlmConnection`. The repository-rule case still
 * measures `pi` — `bashAlwaysAllowRememberScope` writes a repository rule for
 * `pi` and `codex-runtime` only (D1.436) — now because the connection says so.
 *
 * The seeding is `claude-gateway-always-allow-scope.test.ts`'s recipe:
 * `addLlmConnection` refuses to CREATE `config.json`, so a v2 skeleton is written
 * when there is none, and `afterAll` puts the previous bytes back rather than
 * calling the deleter (it reaches the credential manager and throws in a bare
 * test process). This file's line count is cited by the plans, so the move
 * kept it.
 */
const CONNECTION_SLUG = 'permission-remember-conn'
/** `null` when this file created `config.json`; the previous bytes otherwise. */
let previousConfigJson: string | null = null

let createManagedSessionFn: typeof import('./SessionManager.ts')['createManagedSession']
let createTestSessionManagerFn: typeof import('./__tests__/test-session-manager.ts')['createTestSessionManager']

type SessionManagerInstance = InstanceType<typeof import('./SessionManager.ts')['SessionManager']>

type AgentResponse = {
  requestId: string
  allowed: boolean
  alwaysAllow?: boolean
}

type ManagedForTest = {
  id: string
  workspace: { id: string }
  agent: {
    respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void
  }
}

type PermissionRequestForTest = {
  requestId: string
  toolName: string
  command: string
  description: string
  type: 'bash'
  rememberForMinutes: number
  commandHash: string
}

describe('SessionManager permission remember approvals', () => {
  let tmpRoot: string
  let sm: SessionManagerInstance
  let managed: ManagedForTest
  let events: SessionEvent[]
  let agentResponses: AgentResponse[]

  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager

    mkdirSync(CONFIG_DIR, { recursive: true })
    const configPath = join(CONFIG_DIR, 'config.json')
    previousConfigJson = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null
    if (previousConfigJson === null) {
      writeFileSync(configPath, JSON.stringify({ storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null }), 'utf-8')
    }
    addLlmConnection({ slug: CONNECTION_SLUG, name: CONNECTION_SLUG, providerType: 'pi', authType: 'api_key', models: [] } as unknown as Parameters<typeof addLlmConnection>[0])
    // The fixture's own control, before any arm: a stored connection, not a fallback.
    expect(getLlmConnection(CONNECTION_SLUG)?.providerType).toBe('pi')
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-permission-remember-'))
    sm = createTestSessionManagerFn()
    events = []
    agentResponses = []
    sm.setEventSink(((...args: unknown[]) => {
      events.push(args[2] as SessionEvent)
    }) as Parameters<SessionManagerInstance['setEventSink']>[0])

    const workspace = {
      id: 'ws_permission_remember',
      name: 'Permission Remember Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    managed = createManagedSessionFn(
      { id: 'session_permission_remember', name: 'permission remember', llmConnection: 'permission-remember-conn' },
      workspace as never,
      { messagesLoaded: true },
    ) as unknown as ManagedForTest
    managed.agent = {
      respondToPermission: (requestId, allowed, alwaysAllow) => {
        agentResponses.push({ requestId, allowed, alwaysAllow })
      },
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${managed.workspace.id}:${managed.id}`, managed)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    const configPath = join(CONFIG_DIR, 'config.json')
    if (previousConfigJson === null) rmSync(configPath, { force: true })
    else writeFileSync(configPath, previousConfigJson, 'utf-8')
  })

  it('skips the next prompt for the same remembered command hash', () => {
    const request: PermissionRequestForTest = {
      requestId: 'perm-1',
      toolName: 'Bash',
      command: 'npm install express',
      description: 'Execute: npm install express',
      type: 'bash' as const,
      rememberForMinutes: 10,
      commandHash: 'hash-npm-install-express',
    }

    ;(sm as unknown as {
      handleAgentPermissionRequest(managed: ManagedForTest, request: PermissionRequestForTest): void
    }).handleAgentPermissionRequest(managed, request)

    expect(events.filter(event => event.type === 'permission_request')).toHaveLength(1)

    expect(sm.respondToPermission(managed.id, 'perm-1', true, true)).toBe(true)
    expect(agentResponses).toEqual([{ requestId: 'perm-1', allowed: true, alwaysAllow: true }])

    ;(sm as unknown as {
      handleAgentPermissionRequest(managed: ManagedForTest, request: PermissionRequestForTest): void
    }).handleAgentPermissionRequest(managed, {
      ...request,
      requestId: 'perm-2',
    })

    expect(events.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(agentResponses.at(-1)).toEqual({ requestId: 'perm-2', allowed: true, alwaysAllow: false })
  })

  /**
   * permissions.md:15 — a Bash "Yes, don't ask again" is remembered
   * "Permanently per repository and command"; :21 names the file it is saved
   * to. The in-memory window stays as the same-session belt.
   *
   * D1.404 NARROWED what gets written and this pin recorded the old width as if
   * it were a rule. `persistBashAlwaysAllowRule` now keys on
   * `bashSessionWhitelistKey`, so the durable rule is never wider than the
   * session grant the same click makes: a `npm run build --workspaces` approval
   * writes the three-token form below, where this case used to assert the
   * one-token one. That is the new expected reading, not a regression — the
   * whole point of D1.404 is that one Always on a narrow command must not mint
   * a repository-wide grant for every other use of the same binary.
   *
   * F1.103 (D1.421) retired the width pin itself: a pin cannot tell a narrowing
   * from a regression. The case now asserts a BOUND through the reader of the
   * rule (`persistedRulesAllow`) — the approved command is granted and a wider
   * sibling is not — so a narrower rule passes and a widening fails.
   */
  it('saves a Bash Always Allow as a repository rule, and refuses a dangerous base command', () => {
    const repo = join(tmpRoot, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    ;(managed as unknown as { workingDirectory: string }).workingDirectory = join(repo, 'packages')
    mkdirSync(join(repo, 'packages'), { recursive: true })

    const ask = (requestId: string, command: string, commandHash: string) => {
      ;(sm as unknown as {
        handleAgentPermissionRequest(managed: ManagedForTest, request: PermissionRequestForTest): void
      }).handleAgentPermissionRequest(managed, {
        requestId,
        toolName: 'Bash',
        command,
        description: `Execute: ${command}`,
        type: 'bash' as const,
        rememberForMinutes: 10,
        commandHash,
      })
      expect(sm.respondToPermission(managed.id, requestId, true, true)).toBe(true)
    }

    ask('perm-save', 'npm run build --workspaces', 'hash-npm-run-build')
    const settingsPath = join(repo, '.claude', 'settings.local.json')
    const persisted = (): string[] =>
      JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow
    // D1.404/D1.421 — one rule, granting the approved command and not `npm publish`.
    expect([persisted().length, persistedRulesAllow(persisted(), 'npm run build --workspaces'), persistedRulesAllow(persisted(), 'npm publish')]).toEqual([1, true, false])

    // A dangerous base command is never persisted — the same floor the
    // permission_suggestions builder applies to the option it offers.
    ask('perm-danger', 'rm -rf build', 'hash-rm-rf-build')
    expect([persisted().length, persistedRulesAllow(persisted(), 'rm -rf build')]).toEqual([1, false])
  })

  /**
   * permissions.md's tier table gives a file-modification approval "Until
   * session end", not a ten-minute window.
   */
  it('remembers a non-Bash approval for the whole session', () => {
    const store = (sm as unknown as {
      adminRememberApprovals: Map<string, { expiresAt: number }>
    }).adminRememberApprovals
    ;(sm as unknown as {
      handleAgentPermissionRequest(managed: ManagedForTest, request: Record<string, unknown>): void
    }).handleAgentPermissionRequest(managed, {
      requestId: 'perm-write',
      toolName: 'Write',
      command: '/work/repo/src/a.ts',
      description: 'Write /work/repo/src/a.ts',
      type: 'file_write',
      rememberForMinutes: 10,
      commandHash: 'hash-write-a-ts',
    })
    expect(sm.respondToPermission(managed.id, 'perm-write', true, true)).toBe(true)

    const entry = [...store.values()].at(-1)
    expect(entry?.expiresAt).toBe(Number.POSITIVE_INFINITY)
  })

  it('CONTROL — the fixture is a STORED pi connection, not the default the resolver falls back to (F1.129)', async () => {
    // Both halves, because the first alone cannot fail: on the old inert fixture the
    // resolver ALSO answered 'pi', by falling back to the named default.
    const { resolveBackendContext } = await import('@nessy-agent/shared/agent/backend')
    expect(resolveBackendContext({ sessionConnectionSlug: CONNECTION_SLUG }).provider).toBe('pi')
    expect(getLlmConnection(CONNECTION_SLUG)?.providerType).toBe('pi')
  })

  it('CONTROL — the bound tells a widening from a narrowing (F1.103, D1.421)', () => {
    // The pre-D1.404 width grants the wider sibling, so it FAILS the bound above;
    // an exact rule, narrower than today's, still grants the approved command
    // and so PASSES it — the direction a pin could not tell apart.
    expect(persistedRulesAllow(['Bash(npm *)'], 'npm publish')).toBe(true)
    expect(persistedRulesAllow(['Bash(npm run build --workspaces)'], 'npm run build --workspaces')).toBe(true)
    expect(persistedRulesAllow(['Bash(npm run build --workspaces)'], 'npm publish')).toBe(false)
  })
})
