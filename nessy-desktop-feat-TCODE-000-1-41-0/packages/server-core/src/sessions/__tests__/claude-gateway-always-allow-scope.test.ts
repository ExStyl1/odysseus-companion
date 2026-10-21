/**
 * D1.436 `[safety]` — the durable Bash rule is written only where THIS product's
 * own gate reads it back, which is the same answer the card's sentence gives.
 *
 * ## What was measured, end to end, on the packaged 1.40.0
 *
 * SIT-9 (2026-09-20, P-SIT9-2) drove both runtimes in one app run, in one
 * repository. On **pi** the card's sentence reads `chat.permissionRemember.repository`
 * and one Always Allow on `npm test` writes `Bash(npm test *)` — card and
 * behaviour agree. On **claude-gateway** the card's sentence reads
 * `chat.permissionRemember.session` ("remembers this for the session") and
 * `Bash(npm test *)` was written into `.claude/settings.local.json` ANYWAY; a NEW
 * **pi** session in that repository then ran `npm test` with **no card at all**.
 * So one click on a card labelled *session* durably granted a command to every
 * future pi session in that repository. Two controls taken in the same minutes:
 * the pi card's own sentence really does read *repository* (the reader
 * distinguishes the two, so the difference is the runtime and not the
 * instrument), and on claude the written rule did NOT suppress claude's own
 * later card — the user paid the widening and got none of the convenience.
 *
 * ## Why the C4.46 guard did not catch it
 *
 * The persist cut at `SessionManager.respondToPermission` was keyed on
 * `requestMeta.origin !== 'claude_native'`, and `claude_native` is reserved for
 * the SDK's own `canUseTool` request. The gateway's Bash card is raised by our
 * `runPreToolUseChecks` running as a PreToolUse hook INSIDE the claude child, and
 * `packages/shared/src/agent/claude-agent.ts` stamps it `origin: 'host_gate'` and
 * says so at the card site — "the host gate wearing claude's clothes". `origin`
 * is therefore true and cannot answer this question; the renderer's own
 * `permissionRememberScope` docblock says the same thing in as many words, and
 * keys its sentence on the RUNTIME instead.
 *
 * The runtime is the thing that decides whether the rule is read back:
 * a `.claude/settings.local.json` allow block is compiled into the readable
 * permission DSL and evaluated by the pi and codex gates, and the claude arm
 * never evaluates it (C3.365). `bashAlwaysAllowRememberScope` is that one table,
 * and this file drives it through the REAL answer path and the REAL settings
 * writer rather than through the predicate alone — a predicate test would pass
 * against a build whose call site never consults it.
 *
 * ## The arms, and why each control is here
 *
 * The failing arm alone would pass against a build that had deleted the persist
 * entirely (AGENTS.md §Traps: a control whose two arms now agree is a deleted
 * test that still runs), so every arm below has its positive twin in the SAME
 * repository root: pi writes, codex writes, claude does not, and the claude
 * click still reaches the runtime carrying `alwaysAllow` — which is the session
 * grant the card actually promised, and the half that must not regress.
 *
 * SAFETY: this process's own isolated config dir, a temp repository, no
 * credential, no real home.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR, addLlmConnection, getLlmConnection } from '@nessy-agent/shared/config'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { persistedRulesAllow } from './persisted-bash-rule-bound.ts'

/**
 * THE FIXTURE IS WRITTEN THROUGH THE REAL STORAGE API, INTO THIS PROCESS'S OWN
 * ISOLATED CONFIG DIR — and the first draft of this file did it the other way,
 * which measured nothing.
 *
 * `bunfig.toml`'s `[test].preload` runs `isolate-shared-config-dir.ts` FIRST and
 * `config/paths.ts` then freezes `CONFIG_DIR` at that private temp directory. A
 * test module that assigns `process.env.NESSY_CONFIG_DIR` in its own body runs
 * AFTER both, so the assignment reaches nothing: every connection lookup falls
 * through to "no connection", which `resolveBackendContext` answers with the
 * named default `'pi'`. Measured here — the claude-gateway arm resolved `'pi'`
 * and the fixture's own pi arm "passed" on the same fallback, a dead control.
 * The runtime control below is what turns that into a loud failure.
 *
 * `addLlmConnection` refuses to CREATE `config.json`, so the seeding follows
 * `agent/__tests__/gateway-quota-pointer.test.ts`'s recipe: write a v2 skeleton
 * if there is none, add the connections, and put the previous bytes back in
 * `afterAll` rather than calling the deleter (which reaches the credential
 * manager and throws in a bare test process).
 */
const PI_SLUG = 'd1436-pi'
/** The shipped card's own slug, so the session resolves exactly as the app's does. */
const CLAUDE_GATEWAY_SLUG = 'claude-gateway'
const CODEX_SLUG = 'd1436-codex'
/** `null` when this file created `config.json`; the previous bytes otherwise. */
let previousConfigJson: string | null = null

let createManagedSessionFn: typeof import('../SessionManager.ts')['createManagedSession']
let createTestSessionManagerFn: typeof import('./test-session-manager.ts')['createTestSessionManager']

type SessionManagerInstance = InstanceType<typeof import('../SessionManager.ts')['SessionManager']>

interface Internals {
  sessions: Map<string, unknown>
  handleAgentPermissionRequest(managed: unknown, request: unknown): void
  sendEvent(event: unknown, workspaceId?: string): void
  persistSession(managed: unknown, immediate?: boolean): void
}

/** The command SIT-9 pressed Always Allow on (D1.404 mints `Bash(npm test *)` from it). */
const COMMAND = 'npm test'

/**
 * F1.103 (D1.421) — what a pi or codex click must leave on disk, asserted by what
 * it GRANTS rather than by its spelling: exactly one rule, granting the approved
 * command and not a wider sibling of it. This suite's subject is WHETHER the rule
 * is written per runtime; its width is D1.404's to pin
 * (`bash-always-allow-dangerous-prefix.test.ts`), so a narrowing there must not
 * turn this file red.
 */
const theRepositoryRule = (rules: readonly string[]) =>
  [rules.length, persistedRulesAllow(rules, COMMAND), persistedRulesAllow(rules, 'npm publish')]

describe('D1.436 · one Always Allow writes a repository rule only where the gate reads it back', () => {
  let repoRoot: string
  let sm: SessionManagerInstance
  let answeredByAgent: Array<[string, boolean, boolean | undefined]>
  let sessionSeq: number

  beforeAll(async () => {
    const mod = await import('../SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./test-session-manager.ts')).createTestSessionManager

    mkdirSync(CONFIG_DIR, { recursive: true })
    const configPath = join(CONFIG_DIR, 'config.json')
    previousConfigJson = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null
    if (previousConfigJson === null) {
      writeFileSync(
        configPath,
        JSON.stringify({ storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null }),
        'utf-8',
      )
    }
    const connection = (slug: string, providerType: string) => ({
      slug,
      name: slug,
      providerType,
      authType: 'api_key',
      models: [],
    } as unknown as Parameters<typeof addLlmConnection>[0])
    addLlmConnection(connection(PI_SLUG, 'pi'))
    addLlmConnection(connection(CLAUDE_GATEWAY_SLUG, 'claude-runtime'))
    addLlmConnection(connection(CODEX_SLUG, 'codex-runtime'))
    // The fixture's own positive control: a failure below is then about the
    // write and not about three connections that were never stored.
    expect(getLlmConnection(PI_SLUG)?.providerType).toBe('pi')
    expect(getLlmConnection(CLAUDE_GATEWAY_SLUG)?.providerType).toBe('claude-runtime')
    expect(getLlmConnection(CODEX_SLUG)?.providerType).toBe('codex-runtime')
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  beforeEach(() => {
    // ONE repository for every arm of a case, so "pi writes here" and "claude
    // does not write here" are statements about the same file.
    repoRoot = mkdtempSync(join(tmpdir(), 'sm-always-allow-scope-repo-'))
    mkdirSync(join(repoRoot, '.git'), { recursive: true })
    sm = createTestSessionManagerFn()
    answeredByAgent = []
    sessionSeq = 0
    const internals = sm as unknown as Internals
    internals.sendEvent = () => undefined
    internals.persistSession = () => undefined
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  /**
   * Put the bytes back rather than calling `deleteLlmConnection`: that setter
   * reaches the credential manager, which throws in a bare test process. The
   * config dir is private to this PROCESS, so this only keeps a neighbouring
   * suite in the same process from meeting three connections it never wrote.
   */
  afterAll(() => {
    const configPath = join(CONFIG_DIR, 'config.json')
    if (previousConfigJson === null) {
      rmSync(configPath, { force: true })
      return
    }
    writeFileSync(configPath, previousConfigJson, 'utf-8')
  })

  /** What is on disk for this repository right now — `[]` when nothing was written. */
  const persistedRules = (): string[] => {
    const settingsPath = join(repoRoot, '.claude', 'settings.local.json')
    if (!existsSync(settingsPath)) return []
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      permissions?: { allow?: string[] }
    }
    return parsed.permissions?.allow ?? []
  }

  /**
   * One session on `connectionSlug`, one Bash card with the origin the producer
   * really stamps, one Always Allow. Everything between the card and the
   * settings file is production code.
   */
  const alwaysAllowOn = (connectionSlug: string, origin: string): void => {
    sessionSeq += 1
    const sessionId = `session_scope_${sessionSeq}`
    const requestId = `perm-scope-${sessionSeq}`
    const workspace = {
      id: 'ws_always_allow_scope',
      name: 'Always Allow Scope Workspace',
      rootPath: join(repoRoot, '.nessy-workspace'),
      createdAt: Date.now(),
    }
    const managed = createManagedSessionFn(
      { id: sessionId, name: 'always allow scope', llmConnection: connectionSlug },
      workspace as never,
      { messagesLoaded: true },
    ) as unknown as Record<string, unknown>
    ;(managed as unknown as { workingDirectory: string }).workingDirectory = repoRoot
    managed.agent = {
      respondToPermission: (id: string, allowed: boolean, alwaysAllow?: boolean) => {
        answeredByAgent.push([id, allowed, alwaysAllow])
      },
    }
    const internals = sm as unknown as Internals
    internals.sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId }), managed)
    internals.handleAgentPermissionRequest(managed, {
      requestId,
      toolName: 'Bash',
      command: COMMAND,
      description: `Execute: ${COMMAND}`,
      type: 'bash' as const,
      origin,
    })
    expect(sm.respondToPermission(sessionId, requestId, true, true, undefined, workspace.id)).toBe(true)
  }

  it('CONTROL — the fixture really resolves three DIFFERENT runtimes', async () => {
    // Without this the arms below could all be measuring one runtime and
    // agreeing for the wrong reason — SIT-9's own rig finding 2, where every
    // settings read pointed at a session that was never bound where it thought.
    const { resolveBackendContext } = await import('@nessy-agent/shared/agent/backend')
    expect(resolveBackendContext({ sessionConnectionSlug: PI_SLUG }).provider).toBe('pi')
    expect(resolveBackendContext({ sessionConnectionSlug: CLAUDE_GATEWAY_SLUG }).provider).toBe('anthropic')
    expect(resolveBackendContext({ sessionConnectionSlug: CODEX_SLUG }).provider).toBe('codex-runtime')
  })

  it('FAILING ARM — a claude-gateway Bash card says "session", so it writes no repository rule', () => {
    // The gateway card's own producer: our PreToolUse gate inside the claude
    // child, which stamps `host_gate`. This is the exact requestMeta the
    // packaged app sends, and it is why the C4.46 origin test passed it.
    alwaysAllowOn(CLAUDE_GATEWAY_SLUG, 'host_gate')

    expect(persistedRules()).toEqual([])
    // ...and the click still buys what the card promised: the answer reaches the
    // runtime carrying `alwaysAllow`, which is the session-scoped grant. Without
    // this the arm above would pass against a build that dropped the answer.
    expect(answeredByAgent).toEqual([['perm-scope-1', true, true]])
  })

  it('CONTROL — a pi card in the SAME repository still writes the rule', () => {
    alwaysAllowOn(PI_SLUG, 'host_gate')

    // One rule granting `npm test` and not `npm publish` — D1.404's bound, not its spelling.
    expect(theRepositoryRule(persistedRules())).toEqual([1, true, false])
  })

  it('CONTROL — a codex card still writes the rule', () => {
    alwaysAllowOn(CODEX_SLUG, 'host_gate')

    expect(theRepositoryRule(persistedRules())).toEqual([1, true, false])
  })

  it('CONTROL — the cut is per RUNTIME, not per repository: pi still writes after a claude click', () => {
    alwaysAllowOn(CLAUDE_GATEWAY_SLUG, 'host_gate')
    expect(persistedRules()).toEqual([])

    alwaysAllowOn(PI_SLUG, 'host_gate')
    expect(theRepositoryRule(persistedRules())).toEqual([1, true, false])
  })

  it('CONTROL — C4.46 is unchanged: the SDK-raised claude card writes nothing either', () => {
    alwaysAllowOn(CLAUDE_GATEWAY_SLUG, 'claude_native')

    expect(persistedRules()).toEqual([])
  })

  it('CONTROL — the table fails CLOSED, which the end-to-end arms above cannot reach', async () => {
    // The compiler keeps the table total over `AgentProvider`, so no arm above
    // can exercise the lookup's fallback. A runtime this table cannot name must
    // cost the user the convenience, never mint a permanent rule.
    const { bashAlwaysAllowRememberScope } = await import('@nessy-agent/shared/agent')
    expect(bashAlwaysAllowRememberScope(undefined)).toBe('session')
    expect(bashAlwaysAllowRememberScope('sonnet-of-nobody' as never)).toBe('session')
    // ...and the positive twin, so a function that answered 'session' for
    // everything would fail here rather than pass both arms.
    expect(bashAlwaysAllowRememberScope('pi')).toBe('repository')
  })
})
