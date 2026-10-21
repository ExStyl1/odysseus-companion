/**
 * F1.888 — an Always answer on a card that offered no Always Allow
 * (`noAlwaysAllow`) is a ONE-SHOT yes on the host side too.
 *
 * The renderer (`canRemember`) and the iOS client hide the button on such a card,
 * and each runtime re-tests the answer (claude's `canRememberForSession`, codex's
 * `alwaysAllowHonoured`, Pi's boolean-only resolver). The host's own two grant
 * writes in `SessionManager.respondToPermission` did not: its pending record never
 * carried the flag, so a client that sends `alwaysAllow: true` anyway still
 *
 *  - minted the permanent repository `Bash(<key> *)` rule on a `bash`-typed card
 *    (the Pi ask-rule card over a mode prompt keeps type `bash`, F1.913; so does
 *    Pi's protected-path floor card, F1.737), and
 *  - stored the session remember window on a card that carries a `commandHash`.
 *
 * The codex arm is the row's own premise, measured: a codex card (`shell`, from
 * `mapCommandApprovalToRequest`) carries no `type`, so the persist branch never
 * reached it before this fix either — the reachable seat was Pi.
 *
 * Each red arm has its control on the same rig: the same card without the flag
 * still writes its rule or its window, so the fix is not "Always does nothing".
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

const PI_SLUG = 'f1888-pi'
const CODEX_SLUG = 'f1888-codex'
/** `null` when this file created `config.json`; the previous bytes otherwise. */
let previousConfigJson: string | null = null

let createManagedSessionFn: typeof import('../SessionManager.ts')['createManagedSession']
let createTestSessionManagerFn: typeof import('./test-session-manager.ts')['createTestSessionManager']

type SessionManagerInstance = InstanceType<typeof import('../SessionManager.ts')['SessionManager']>

interface Internals {
  sessions: Map<string, unknown>
  handleAgentPermissionRequest(managed: unknown, request: unknown): void
  requestPiToolApproval(managed: unknown, request: unknown): Promise<{ allowed: boolean }>
  sendEvent(event: unknown, workspaceId?: string): void
  persistSession(managed: unknown, immediate?: boolean): void
}

/** A base command D1.404 persists (`git` stays session-scoped as dangerous, which would blind the control). */
const COMMAND = 'npm test'
/** The Pi ask-rule card's own sentence shape (piReadableAskOverModePrompt). */
const RULE_SENTENCE = 'Bash requires approval by readable permission policy rule `ask-npm-test` (workspace scope).'

describe('F1.888 · an Always answer on a card with noAlwaysAllow grants nothing beyond this call', () => {
  let repoRoot: string
  let sm: SessionManagerInstance
  let events: Array<{ type?: string; request?: { requestId?: string } }>
  let answeredByAgent: Array<[string, boolean, boolean | undefined]>
  let sessionSeq: number

  beforeAll(async () => {
    const mod = await import('../SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./test-session-manager.ts')).createTestSessionManager

    // The seeding recipe of `claude-gateway-always-allow-scope.test.ts`: the
    // preload froze CONFIG_DIR at a private temp dir, so the fixture is written
    // through the real storage API there.
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
      slug, name: slug, providerType, authType: 'api_key', models: [],
    } as unknown as Parameters<typeof addLlmConnection>[0])
    addLlmConnection(connection(PI_SLUG, 'pi'))
    addLlmConnection(connection(CODEX_SLUG, 'codex-runtime'))
    expect(getLlmConnection(PI_SLUG)?.providerType).toBe('pi')
    expect(getLlmConnection(CODEX_SLUG)?.providerType).toBe('codex-runtime')
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'sm-no-always-answer-repo-'))
    mkdirSync(join(repoRoot, '.git'), { recursive: true })
    sm = createTestSessionManagerFn()
    events = []
    answeredByAgent = []
    sessionSeq = 0
    const internals = sm as unknown as Internals
    internals.sendEvent = event => { events.push(event as (typeof events)[number]) }
    internals.persistSession = () => undefined
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    const configPath = join(CONFIG_DIR, 'config.json')
    if (previousConfigJson === null) {
      rmSync(configPath, { force: true })
      return
    }
    writeFileSync(configPath, previousConfigJson, 'utf-8')
  })

  const persistedRules = (): string[] => {
    const settingsPath = join(repoRoot, '.claude', 'settings.local.json')
    if (!existsSync(settingsPath)) return []
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { permissions?: { allow?: string[] } }
    return parsed.permissions?.allow ?? []
  }

  const sessionOn = (connectionSlug: string) => {
    sessionSeq += 1
    const sessionId = `session_f1888_${sessionSeq}`
    const workspace = {
      id: 'ws_f1888',
      name: 'F1.888 Workspace',
      rootPath: join(repoRoot, '.nessy-workspace'),
      createdAt: Date.now(),
    }
    const managed = createManagedSessionFn(
      { id: sessionId, name: 'no always answer', llmConnection: connectionSlug },
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
    return { managed, sessionId, workspaceId: workspace.id, internals }
  }

  /** A Pi bash card raised through the real Pi seam, answered with Always. */
  const piAlwaysOn = async (card: { noAlwaysAllow?: true }) => {
    const { managed, sessionId, workspaceId, internals } = sessionOn(PI_SLUG)
    const decisionId = `pi-card-${sessionSeq}`
    const settled = internals.requestPiToolApproval(managed, {
      decisionId,
      toolName: 'Bash',
      type: 'bash',
      command: COMMAND,
      description: RULE_SENTENCE,
      ...card,
    })
    expect(sm.respondToPermission(sessionId, decisionId, true, true, undefined, workspaceId)).toBe(true)
    return settled
  }

  it('RED ARM — Pi ask-rule card (type bash, noAlwaysAllow): an Always writes no repository rule and still runs this call', async () => {
    const answer = await piAlwaysOn({ noAlwaysAllow: true })

    expect(persistedRules()).toEqual([])
    // A one-shot yes, not a refusal: the call the card asked about runs.
    expect(answer.allowed).toBe(true)
  })

  it('CONTROL — the same Pi card without noAlwaysAllow still writes its repository rule', async () => {
    const answer = await piAlwaysOn({})

    expect(persistedRules().length).toBe(1)
    expect(answer.allowed).toBe(true)
  })

  /**
   * The remember window, on the same host record. No producer today puts a
   * `commandHash` on a `noAlwaysAllow` card, so this pins the host contract the
   * durable twin (`settleDurableApproval`: `pending.commandHash && !pending.noAlwaysAllow`)
   * already keeps.
   */
  const windowAfterAlways = (card: { noAlwaysAllow?: true }) => {
    const { managed, sessionId, workspaceId, internals } = sessionOn(CODEX_SLUG)
    const hashed = { toolName: 'mcp__linear__save_issue', description: 'Call save_issue', commandHash: 'f1888-hash', rememberForMinutes: 10, origin: 'codex_approval' }
    internals.handleAgentPermissionRequest(managed, { requestId: 'first', ...hashed, ...card })
    expect(sm.respondToPermission(sessionId, 'first', true, true, { rememberForMinutes: 10 }, workspaceId)).toBe(true)
    events = []
    internals.handleAgentPermissionRequest(managed, { requestId: 'second', ...hashed, ...card })
    return events.filter(event => event.type === 'permission_request').map(event => event.request?.requestId)
  }

  it('RED ARM — a hashed card with noAlwaysAllow: an Always stores no remember window, so the next identical call is carded', () => {
    expect(windowAfterAlways({ noAlwaysAllow: true })).toEqual(['second'])
  })

  it('CONTROL — the same hashed card without noAlwaysAllow keeps its window: the next identical call is answered with no card', () => {
    expect(windowAfterAlways({})).toEqual([])
    expect(answeredByAgent.map(([id, allowed]) => [id, allowed])).toEqual([['first', true], ['second', true]])
  })

  it('BOUNDARY — a codex shell ask card carries no type, so no Always on it ever reached the repository rule', () => {
    const { managed, sessionId, workspaceId, internals } = sessionOn(CODEX_SLUG)
    internals.handleAgentPermissionRequest(managed, {
      requestId: 'codex-shell',
      toolName: 'shell',
      command: COMMAND,
      description: `${RULE_SENTENCE}\n\nRun: ${COMMAND}`,
      origin: 'codex_approval',
      noAlwaysAllow: true,
    })
    expect(sm.respondToPermission(sessionId, 'codex-shell', true, true, undefined, workspaceId)).toBe(true)

    expect(persistedRules()).toEqual([])
    // The runtime still gets the raw answer; codex's own `alwaysAllowHonoured`
    // makes it one call (F1.870).
    expect(answeredByAgent).toEqual([['codex-shell', true, true]])
  })
})
