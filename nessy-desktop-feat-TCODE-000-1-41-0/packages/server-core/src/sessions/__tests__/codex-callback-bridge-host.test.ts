/**
 * T5 — the HOST half of the codex callback bridge, against the real ports.
 *
 * The companion suite in `session-mcp-server` drives the real subprocess over
 * the real bridge onto FAKE ports; that is the right split, because the two
 * suites answer different questions. This one asks whether the bridge reaches
 * the host authorities themselves:
 *
 * - `cron/*` runs against a REAL `SessionCronService` for a real codex-gateway
 *   session, through `SessionManager.buildSessionCronPort` — the SAME builder
 *   the Pi backend config and the Claude callback registry both take (T3), so
 *   this is the production port and not a copy of it.
 * - `monitor/start` runs against the REAL `SessionMonitorService`, which awaits
 *   T2's `authorizeMonitor` INSIDE `start`. A deny rule written into the
 *   workspace's own `permissions.json` must therefore refuse THROUGH the bridge,
 *   with the rule named — the gate is exercised, not bypassed, and the bridge
 *   deliberately adds no second gate of its own.
 * - the owner check: a request naming another session is rejected before any
 *   port is resolved, let alone called.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PermissionRequest } from '@nessy-agent/core/types'
import { permissionsConfigCache, mergeSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from '@nessy-agent/shared/agent'
import {
  startCodexSessionCallbackBridge,
  type CodexSessionCallbackBridgeHandle,
} from '@nessy-agent/shared/agent/backend/codex/session-callback-bridge'
import {
  HOST_CALLBACK_BRIDGE_ROUTES,
  HOST_CALLBACK_BRIDGE_SESSION_MISMATCH,
  type SessionCronPort,
  type SessionGoalPort,
  type SessionMonitorPort,
} from '@nessy-agent/session-tools-core'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { SessionMonitorService } from '../session-monitor-service.ts'

const stateRoot = mkdtempSync(join(tmpdir(), 'sm-codex-bridge-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-codex-callback-bridge'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Codex Callback Bridge Workspace',
    slug: 'codex-callback-bridge-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

const TEST_CONNECTIONS = [
  {
    slug: 'codex-gateway',
    name: 'Codex (Nessy Gateway)',
    providerType: 'codex-runtime',
    authType: 'bearer_token',
    defaultModel: 'gpt-5.3-codex',
    createdAt: Date.now(),
  },
] as unknown as NonNullable<StoredConfig['llmConnections']>

type SessionManagerModule = typeof import('../SessionManager.ts')
type ManagedForTest = Record<string, unknown> & { id: string; workspace: { id: string } }

interface Internals {
  sessions: Map<string, unknown>
  sessionMonitors: SessionMonitorService
  getOrCreateSessionCronService(managed: unknown): {
    list(): readonly { id: string; prompt: string; dynamic?: boolean }[]
    stop(): void
  } | undefined
  buildSessionCronPort(managed: unknown, service: unknown): SessionCronPort
  getOrCreatePiGoalService(managed: unknown): { snapshot(): { goal?: { id: string; status: string; source: string; creator: string } } }
  buildSessionGoalPort(managed: unknown, service: unknown): SessionGoalPort
  buildSessionMonitorPort(managed: unknown): SessionMonitorPort
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  flushSession(sessionId: string, workspaceId?: string): Promise<void>
  sendMessage(...args: unknown[]): Promise<void>
  bindSendAgentMessage(sender: unknown): (sessionId: string, message: string) => Promise<{ status: string }>
}

let createManagedSessionFn: SessionManagerModule['createManagedSession']
let createTestSessionManagerFn: typeof import('./test-session-manager.ts')['createTestSessionManager']
let restoreConfig: () => void = () => {}

beforeAll(async () => {
  const mod = await import('../SessionManager.ts')
  createManagedSessionFn = mod.createManagedSession
  ;({ createTestSessionManager: createTestSessionManagerFn } = await import('./test-session-manager.ts'))

  const storage = await import('@nessy-agent/shared/config/storage')
  const configPath = storage.getConfigPath()
  const previous = existsSync(configPath) ? storage.loadStoredConfig() : null
  const base: StoredConfig = previous ?? ({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as unknown as StoredConfig)
  storage.saveConfig({ ...base, defaultLlmConnection: 'codex-gateway', llmConnections: TEST_CONNECTIONS })
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
  // P6.801 (W9-bq, 2026-09-10). This hook's whole body is a `SessionManager.ts`
  // import, and it had NO budget argument at all — bun's 5 000 ms default
  // against a 1.3 MB module graph. Measured at HEAD on a QUIET tree, the file
  // ALONE at load 7.5:
  //
  //   zero-case control (`-t` matching nothing)  55.86 s, 0 cases,
  //                                              user 1.70 / sys 1.08 — 5 % cpu
  //   full run                                   59.44 s wall, 0 pass / 1 fail,
  //                                              the junit body `time="5.0024"`
  //                                              with `<failure type="TimeoutError"/>`
  //
  // So it FAILS ALONE AT LOW LOAD, which by AGENTS.md's two-cause rule is the
  // hook, not starvation — and the 55.9 s zero-case reading is the file's
  // STATIC graph, before this hook imports anything. bun's message names a
  // `beforeEach/afterEach` hook; this file declares neither, and AGENTS.md
  // records that misnomer: the output cannot say which hook family ran.
  //
  // What the junit decomposition then says about the hook itself, with the
  // budget in place (60.52 s file total, 27 pass / 0 fail, load 6.6): the 27
  // bodies sum to **0.55 s**, slowest 0.17 s, so 59.96 s is outside them and
  // 55.86 s of that is the static graph — **the hook's own floor is ~4.1 s**.
  // That is 82 % of the 5 000 ms default on an otherwise idle machine, which is
  // why it is deterministic rather than flaky: there is no load at which a
  // 900 ms margin survives. And it is why the budget is not "5 s plus a bit" —
  // the number that matters is the graph this hook imports, not the margin it
  // was missing.
  //
  // The budget is the family's shared one rather than a number invented here;
  // see `module-graph-budgets.ts` for how 600 000 was sized and for the
  // zero-case control that sizes the next one.
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  restoreConfig()
  rmSync(stateRoot, { recursive: true, force: true })
})

/**
 * The workspace `permissions.json` is a real layer of the merge
 * `authorizeMonitor` reads, so a rule written here arrives through production
 * composition rather than as a hand-built policy object.
 */
function setWorkspaceRules(rules: Array<{ id: string; action: 'allow' | 'ask' | 'deny'; match: unknown }>): void {
  writeFileSync(
    join(workspaceRoot, 'permissions.json'),
    JSON.stringify(rules.length === 0 ? {} : { permissionDsl: { version: 1, rules } }),
    'utf-8',
  )
  permissionsConfigCache.clear()
}

const bashPattern = (id: string, action: 'allow' | 'ask' | 'deny', pattern: string) => ({
  id,
  action,
  match: { kind: 'bash', pattern },
})

let sessionCounter = 0
const openBridges: CodexSessionCallbackBridgeHandle[] = []
const registeredKeys: Array<{ workspaceId: string; sessionId: string }> = []

afterEach(async () => {
  setWorkspaceRules([])
  for (const bridge of openBridges.splice(0)) await bridge.close()
  for (const key of registeredKeys.splice(0)) unregisterSessionScopedToolCallbacks(key)
})

/**
 * A codex session with its real cron service and real monitor service, both
 * published into the per-session callback registry exactly as
 * `getOrCreateAgentUnchecked` publishes them — which is what the bridge reads
 * when nothing overrides `resolvePorts`.
 */
async function codexSessionWithBridge(options?: { withoutCron?: boolean; withoutGoal?: boolean }) {
  const manager = createTestSessionManagerFn()
  const internals = manager as unknown as Internals
  const workspace = {
    id: WORKSPACE_ID,
    name: 'Codex Callback Bridge Workspace',
    slug: 'codex-callback-bridge-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const id = `session-codex-bridge-${++sessionCounter}`
  const managed = createManagedSessionFn(
    { id, name: id, llmConnection: 'codex-gateway' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  ) as unknown as ManagedForTest
  internals.sessions.set(`${workspace.id}:${id}`, managed)

  const prompts: PermissionRequest[] = []
  internals.sendEvent = (event: unknown) => {
    const typed = event as { type?: string; request?: PermissionRequest }
    if (typed.type === 'permission_request' && typed.request) prompts.push(typed.request)
  }
  internals.persistSession = () => undefined
  internals.flushSession = async () => undefined
  internals.sendMessage = async () => undefined

  const sessionKey = { workspaceId: workspace.id, sessionId: id }
  const service = options?.withoutCron ? undefined : internals.getOrCreateSessionCronService(managed)
  if (!options?.withoutCron && !service) throw new Error('a codex-gateway session must get a cron service (T1)')
  // P2.2 — the same shape for the goal: a codex-gateway session is inside
  // `SCHEDULED_DELIVERY_RUNTIMES`, so `getOrCreateAgentUnchecked` builds it a
  // real `GoalService` and publishes the port built by the one builder.
  const goalService = options?.withoutGoal ? undefined : internals.getOrCreatePiGoalService(managed)

  // The production expressions, verbatim: all three ports through their one
  // builder each. D1.269 gave `monitorPort` a builder of its own — it was a
  // literal inlined in the registry, and this block carried a hand-copy of it
  // that a change to the production one would not have moved. The host-bound
  // identity/paths still win over a model-supplied body; that rule now lives
  // where it is executed.
  mergeSessionScopedToolCallbacks(sessionKey, {
    cronPort: service ? internals.buildSessionCronPort(managed, service) : undefined,
    goalPort: goalService ? internals.buildSessionGoalPort(managed, goalService) : undefined,
    monitorPort: internals.buildSessionMonitorPort(managed),
  })
  registeredKeys.push(sessionKey)

  const bridge = await startCodexSessionCallbackBridge({ sessionKey })
  openBridges.push(bridge)

  const post = async (route: string, payload?: unknown, sessionId = id) => {
    const response = await fetch(`http://127.0.0.1:${bridge.port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...(payload === undefined ? {} : { payload }) }),
    })
    return { status: response.status, body: await response.json() as { result?: unknown; error?: string } }
  }

  return { internals, managed, service, goalService, sessionKey, bridge, post, prompts }
}

describe('cron routes reach the session\'s own store', () => {
  it('creates, lists and removes against the real SessionCronService', async () => {
    const h = await codexSessionWithBridge()

    const created = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronCreate, {
      schedule: '0 9 * * *',
      recurring: true,
      prompt: 'daily standup',
    })
    expect(created.status).toBe(200)
    const record = created.body.result as { id: string; prompt: string }
    // `:168` — the STORE owns the 8-character id, so this proves the request
    // reached it rather than being answered by the transport.
    expect(record.id).toHaveLength(8)
    expect(h.service!.list().map(entry => entry.prompt)).toEqual(['daily standup'])

    const listed = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronList)
    expect((listed.body.result as Array<{ prompt: string }>).map(entry => entry.prompt)).toEqual(['daily standup'])

    expect((await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronRemove, { id: record.id })).body.result).toBe(true)
    expect(h.service!.list()).toEqual([])
    // Negative control: removing what is gone answers false, not an error.
    expect((await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronRemove, { id: record.id })).body.result).toBe(false)
  })

  it('re-arms and stops the self-paced wakeup, and reports honestly when there is none', async () => {
    const h = await codexSessionWithBridge()

    const noLoop = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronRearmWakeup, { delayMs: 60_000 })
    expect(noLoop.body.error).toContain('No self-paced /loop is active in this session.')
    expect((await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronStopWakeup)).body.result).toBe(false)

    await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronCreate, { dynamic: true, recurring: true, prompt: 'keep going' })
    const armed = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronRearmWakeup, { delayMs: 60_000 })
    expect((armed.body.result as { firesAt: number }).firesAt).toBeGreaterThan(Date.now())
    expect((await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronStopWakeup)).body.result).toBe(true)
    h.service!.stop()
  })

  it('rejects a non-finite or negative rearm delay with 400 before the port is touched', async () => {
    const h = await codexSessionWithBridge()
    // A self-paced loop IS active, so a valid delay would arm — which makes the
    // 400s below the guard rather than a missing loop or a clamp.
    await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronCreate, { dynamic: true, recurring: true, prompt: 'keep going' })

    for (const delayMs of ['soon', -1, undefined] as const) {
      const res = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronRearmWakeup, { delayMs })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('delayMs')
      // Not the port's own "no self-paced loop" error — the guard fired first.
      expect(res.body.error).not.toContain('self-paced')
    }

    // Positive control: a valid delay through the same route arms the wakeup.
    const armed = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronRearmWakeup, { delayMs: 60_000 })
    expect(armed.status).toBe(200)
    expect((armed.body.result as { firesAt: number }).firesAt).toBeGreaterThan(Date.now())
    h.service!.stop()
  })

  it('a session with no scheduler answers unavailable rather than pretending', async () => {
    const h = await codexSessionWithBridge({ withoutCron: true })
    const answer = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronCreate, {
      schedule: '0 9 * * *',
      recurring: true,
      prompt: 'daily standup',
    })
    expect(answer.body.error).toContain('unavailable')
    // Positive control on the same bridge: the monitor half is still bound.
    expect(typeof h.bridge.port).toBe('number')
  })
})

describe('monitor/start goes through T2\'s gate, not around it', () => {
  it('a deny rule refuses through the bridge, naming the rule, and starts nothing', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = await codexSessionWithBridge()

    const refused = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.monitorStart, {
      description: 'watch the log',
      timeoutMs: 300_000,
      persistent: false,
      command: 'tail -f /var/log/system.log',
    })

    // The rule the user wrote is what the refusal names — an unattributed
    // refusal is indistinguishable from a broken bridge.
    expect(refused.body.error).toContain('no-tail')
    expect(refused.body.result).toBeUndefined()
    // A refusal is not a decision to hand to the user, and it leaves no watch.
    expect(h.prompts).toEqual([])
    expect(h.internals.sessionMonitors.list(h.sessionKey)).toEqual([])
  })

  // The positive control for the row above: the same bridge, the same route, a
  // command an allow rule names. Without this, "error" could mean the bridge
  // never worked rather than the gate refusing.
  it('an allow rule starts the watch silently through the same route', async () => {
    setWorkspaceRules([bashPattern('allow-echo', 'allow', 'echo:*')])
    const h = await codexSessionWithBridge()

    const started = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.monitorStart, {
      description: 'watch the greeting',
      timeoutMs: 300_000,
      persistent: false,
      command: 'echo hello',
    })

    expect(started.body.error).toBeUndefined()
    const result = started.body.result as { taskId: string }
    expect(typeof result.taskId).toBe('string')
    expect(h.prompts).toEqual([])
    expect(h.internals.sessionMonitors.list(h.sessionKey)).toHaveLength(1)

    // `monitor/stop` closes the same watch, over the route the port declares.
    expect((await h.post(HOST_CALLBACK_BRIDGE_ROUTES.monitorStop, { taskId: result.taskId })).body.result).toBe(true)
  })

  // P3.10 — the row's promise against the REAL service: a PERSISTENT watch (the
  // kind with no deadline, the only kind that needs a model stop path) started
  // over the bridge is ended by `monitor/stop` — the route `ProcessStop`'s
  // monitor half rides — and the real `SessionMonitorService` list empties.
  it('a persistent watch started over the bridge is ended by monitor/stop, and the real list empties', async () => {
    setWorkspaceRules([bashPattern('allow-echo', 'allow', 'echo:*')])
    const h = await codexSessionWithBridge()

    const started = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.monitorStart, {
      description: 'keep watching the greeting',
      timeoutMs: 300_000,
      persistent: true,
      command: 'echo hello',
    })
    expect(started.body.error).toBeUndefined()
    const result = started.body.result as { taskId: string; persistent?: boolean }
    // The watch is persistent (no timeout) and live on the real service.
    expect(result.persistent).toBe(true)
    expect(h.internals.sessionMonitors.list(h.sessionKey)).toHaveLength(1)

    // Stopped through the same route ProcessStop consults — the watch is gone.
    expect((await h.post(HOST_CALLBACK_BRIDGE_ROUTES.monitorStop, { taskId: result.taskId })).body.result).toBe(true)
    expect(h.internals.sessionMonitors.list(h.sessionKey)).toEqual([])
    // Negative control: stopping it again answers false, not an error.
    expect((await h.post(HOST_CALLBACK_BRIDGE_ROUTES.monitorStop, { taskId: result.taskId })).body.result).toBe(false)
  })

  // The security row: the raw body is model-controllable, and the host sink
  // spreads it over host-bound fields. A `sessionKey`/`cwd`/`env` smuggled into
  // the body must NOT reach the monitor service — the watch is the OWNER's.
  it('narrows the monitor payload to its own fields so owner-binding holds on the call', async () => {
    setWorkspaceRules([bashPattern('allow-echo', 'allow', 'echo:*')])
    const h = await codexSessionWithBridge()

    // The detector is what the host service is actually asked to start, read off
    // the service itself rather than from the reply text.
    const started: Array<Record<string, unknown>> = []
    const realStart = h.internals.sessionMonitors.start.bind(h.internals.sessionMonitors)
    h.internals.sessionMonitors.start = ((request: Parameters<typeof realStart>[0]) => {
      started.push(request as unknown as Record<string, unknown>)
      return realStart(request)
    }) as typeof realStart

    const foreign = { workspaceId: 'ws-foreign', sessionId: 'session-foreign' }
    const res = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.monitorStart, {
      description: 'watch the greeting',
      timeoutMs: 300_000,
      persistent: false,
      command: 'echo hello',
      // Poison: the host-bound fields a compromised caller would try to smuggle
      // in beside the legitimate ones.
      sessionKey: foreign,
      cwd: '/etc',
      workspaceRoot: '/etc',
      env: { EVIL: '1' },
      additionalWritableRoots: ['/etc'],
    })

    expect(res.body.error).toBeUndefined()
    expect(started).toHaveLength(1)
    const request = started[0]!
    // Every host-bound field held: the watch runs for the OWNER, in the owner's
    // directory, with no smuggled env or extra writable roots.
    expect(request.sessionKey).toEqual(h.sessionKey)
    expect(request.cwd).toBe(workspaceRoot)
    expect(request.workspaceRoot).toBe(workspaceRoot)
    expect(request.env).toBeUndefined()
    expect(request.additionalWritableRoots).toBeUndefined()

    // And nothing was registered against the session the body named.
    expect(h.internals.sessionMonitors.list(foreign)).toEqual([])
    expect(h.internals.sessionMonitors.list(h.sessionKey)).toHaveLength(1)

    await h.post(HOST_CALLBACK_BRIDGE_ROUTES.monitorStop, { taskId: (res.body.result as { taskId: string }).taskId })
  })
})

/**
 * P2.2 — the goal routes against the REAL `GoalService`, through the REAL
 * `buildSessionGoalPort` (the one builder the Pi backend config and the Claude
 * callback registry both take), so what is measured is the production port.
 */
describe('goal routes reach the session\'s own GoalService', () => {
  it('set, get and clear round-trip against the real service', async () => {
    const h = await codexSessionWithBridge()

    const created = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalSet, {
      action: 'create',
      condition: 'Ship the retry with a green gate',
    })
    expect(created.status).toBe(200)
    const state = created.body.result as { goal?: { id: string; revision: number; status: string } }
    expect(state.goal?.status).toBe('active')
    // The SERVICE owns the record, so reading it back off the service proves the
    // request reached it rather than being answered by the transport.
    expect(h.goalService!.snapshot().goal?.id).toBe(state.goal!.id)
    // And it reached the SESSION's persisted state, which is what survives a
    // runtime switch.
    expect((h.managed as { goalState?: { goal?: { id: string } } }).goalState?.goal?.id).toBe(state.goal!.id)

    const read = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalGet)
    expect((read.body.result as { goal?: { id: string } }).goal?.id).toBe(state.goal!.id)

    const cleared = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalClear, {
      action: 'cancel',
      id: state.goal!.id,
      revision: state.goal!.revision,
      reason: 'superseded by a different plan',
    })
    expect(cleared.status).toBe(200)
    expect((cleared.body.result as { goal?: { status: string } }).goal?.status).toBe('cancelled')
    expect(h.goalService!.snapshot().goal?.status).toBe('cancelled')
  })

  /**
   * The security row, and the reason the payload belt exists at all.
   *
   * `source` and `creator` decide ATTRIBUTION — a `source: 'user'` goal reads as
   * one the human asked for — and the host stamps them from the session. A body
   * carrying its own must not reach the service. `GoalSchema` is a union of
   * `.strict()` objects, so the smuggled keys make the whole payload MALFORMED
   * (400) rather than being silently dropped, which is the stronger answer: the
   * caller is told, and no half-honoured command lands.
   */
  it('refuses a payload smuggling source/creator, and stamps them itself on a clean one', async () => {
    const h = await codexSessionWithBridge()

    const forged = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalSet, {
      action: 'create',
      condition: 'Ship it',
      source: 'user',
      creator: 'desktop',
    })
    expect(forged.status).toBe(400)
    expect(forged.body.error).toContain('goal/set payload is invalid')
    // Nothing landed: the refusal is before the port, not after a partial write.
    expect(h.goalService!.snapshot().goal).toBeUndefined()

    // Positive control: the same command without the forged fields is accepted,
    // and the host's OWN stamp is what the record carries — `agent`, and the
    // runtime the session is actually on.
    const clean = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalSet, { action: 'create', condition: 'Ship it' })
    expect(clean.status).toBe(200)
    expect(h.goalService!.snapshot().goal).toMatchObject({ source: 'agent', creator: 'codex-runtime' })
  })

  // The second half of the payload belt: each mutating route serves only its own
  // actions, so a `cancel` posted to `goal/set` is refused by the route rather
  // than reaching a port that would have honoured it.
  it('refuses an action the route does not serve, in both directions', async () => {
    const h = await codexSessionWithBridge()
    const created = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalSet, { action: 'create', condition: 'Ship it' })
    const goal = (created.body.result as { goal: { id: string; revision: number } }).goal

    const clearOnSet = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalSet, {
      action: 'cancel', id: goal.id, revision: goal.revision, reason: 'wrong route',
    })
    expect(clearOnSet.status).toBe(400)
    expect(clearOnSet.body.error).toContain('goal/set does not serve action "cancel"')

    const setOnClear = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalClear, {
      action: 'replace', id: goal.id, revision: goal.revision, condition: 'Ship something else',
    })
    expect(setOnClear.status).toBe(400)
    expect(setOnClear.body.error).toContain('goal/clear does not serve action "replace"')

    // The goal is untouched by either attempt — same id, same revision, active.
    expect(h.goalService!.snapshot().goal).toMatchObject({ id: goal.id, status: 'active' })
  })

  // `goal/get` reads NOTHING from the body, so the only thing deciding whose
  // goal comes back is the envelope owner check. Asserted by posting a payload
  // naming another session's goal and getting this session's answer.
  it('goal/get ignores the body entirely — the envelope decides whose goal', async () => {
    const h = await codexSessionWithBridge()
    await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalSet, { action: 'create', condition: 'Ship it' })

    const read = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalGet, {
      sessionKey: { workspaceId: 'ws-foreign', sessionId: 'session-foreign' },
      id: 'goal-somebody-elses',
    })
    expect(read.status).toBe(200)
    expect((read.body.result as { goal?: { condition: string } }).goal?.condition).toBe('Ship it')
  })

  // The owner belt on the goal routes specifically: a foreign session id is
  // refused with 403 before the port is resolved, and nothing is written.
  it('rejects a foreign session id on the goal routes before touching the service', async () => {
    const h = await codexSessionWithBridge()

    const rejected = await h.post(
      HOST_CALLBACK_BRIDGE_ROUTES.goalSet,
      { action: 'create', condition: 'not mine' },
      'some-other-session',
    )
    expect(rejected.status).toBe(403)
    expect(rejected.body.error).toBe(HOST_CALLBACK_BRIDGE_SESSION_MISMATCH)
    expect(h.goalService!.snapshot().goal).toBeUndefined()

    // Positive control: the same body with the right id is accepted.
    const accepted = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalSet, { action: 'create', condition: 'mine' })
    expect(accepted.status).toBe(200)
    expect(h.goalService!.snapshot().goal?.status).toBe('active')
  })

  it('a session with no goal authority answers unavailable rather than pretending', async () => {
    const h = await codexSessionWithBridge({ withoutGoal: true })
    const answer = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalGet)
    expect(answer.body.error).toContain('Goal is unavailable for this session.')
    // Positive control on the same bridge: the cron half is still bound.
    expect((await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronList)).body.result).toEqual([])
  })

  /**
   * P2.17 — the ORDER `pickGoalCommand`'s own doc promises, measured where the
   * two answers differ. `goal().execute(pickGoalCommand(…))` evaluated the
   * callee first, so on a session with no goal authority a malformed body was
   * answered by the missing port (200 `{ error: 'Goal is unavailable…' }`)
   * rather than by the parser (400) — the tool would have told the model its
   * capability was absent when in fact its arguments were wrong.
   *
   * The bound-port half of the same claim is already covered above (a forged
   * `source`/`creator` is 400 with nothing written); this row is the half that
   * only a session WITHOUT the port can see, on both mutating routes.
   */
  it('parses the goal payload before resolving the port, even with no goal authority', async () => {
    const h = await codexSessionWithBridge({ withoutGoal: true })

    for (const route of [HOST_CALLBACK_BRIDGE_ROUTES.goalSet, HOST_CALLBACK_BRIDGE_ROUTES.goalClear] as const) {
      const malformed = await h.post(route, { action: 'create', condition: 'Ship it', source: 'user' })
      expect(malformed.status).toBe(400)
      expect(malformed.body.error).toContain('payload is invalid')
    }

    // Positive control: a WELL-FORMED body on the same portless session still
    // reaches the missing port and reports the capability as absent, so the 400s
    // above measure the parse order and not a bridge that refuses everything.
    const wellFormed = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.goalSet, { action: 'create', condition: 'Ship it' })
    expect(wellFormed.status).toBe(200)
    expect(wellFormed.body.error).toContain('Goal is unavailable for this session.')
  })
})

describe('the bridge is owner-bound', () => {
  it('rejects a foreign session id with 403 before any port is touched', async () => {
    const h = await codexSessionWithBridge()

    const rejected = await h.post(
      HOST_CALLBACK_BRIDGE_ROUTES.cronCreate,
      { schedule: '0 9 * * *', recurring: true, prompt: 'not mine' },
      'some-other-session',
    )

    expect(rejected.status).toBe(403)
    expect(rejected.body.error).toBe(HOST_CALLBACK_BRIDGE_SESSION_MISMATCH)
    // The detector that matters: nothing was written. A refusal that still ran
    // the port would look identical from the reply alone.
    expect(h.service!.list()).toEqual([])

    // Positive control: the same body with the right id is accepted.
    const accepted = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.cronCreate, {
      schedule: '0 9 * * *',
      recurring: true,
      prompt: 'mine',
    })
    expect(accepted.status).toBe(200)
    expect(h.service!.list().map(entry => entry.prompt)).toEqual(['mine'])
  })

  it('answers 404 for a route it does not serve, and 400 for an unreadable body', async () => {
    const h = await codexSessionWithBridge()

    const unknown = await fetch(`http://127.0.0.1:${h.bridge.port}/cron/whatever`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: h.sessionKey.sessionId }),
    })
    expect(unknown.status).toBe(404)

    const garbage = await fetch(`http://127.0.0.1:${h.bridge.port}${HOST_CALLBACK_BRIDGE_ROUTES.cronList}`, {
      method: 'POST',
      body: 'not json',
    })
    expect(garbage.status).toBe(400)

    // GET is not a route either — every RPC is a POST.
    const wrongMethod = await fetch(`http://127.0.0.1:${h.bridge.port}${HOST_CALLBACK_BRIDGE_ROUTES.cronList}`)
    expect(wrongMethod.status).toBe(404)
  })

  it('stops answering once closed', async () => {
    const h = await codexSessionWithBridge()
    const port = h.bridge.port
    await h.bridge.close()
    openBridges.splice(openBridges.indexOf(h.bridge), 1)
    await expect(fetch(`http://127.0.0.1:${port}${HOST_CALLBACK_BRIDGE_ROUTES.cronList}`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: h.sessionKey.sessionId }),
    })).rejects.toThrow()
  })
})

const codexAgentSource = (): string =>
  readFileSync(
    fileURLToPath(new URL('../../../../shared/src/agent/codex-agent.ts', import.meta.url)),
    'utf8',
  )

describe('the spawn side: one argument names the channel and proves it exists', () => {
  // `buildSessionMcpSpec` runs inside `createRuntime`, which spawns a real
  // app-server — the same reason T3 read `SessionManager.ts` as text. Each row
  // carries a positive control so an emptied or moved file cannot read as a pass.
  it('passes --host-callback-port only when a bridge started', () => {
    const source = codexAgentSource()
    expect(source).toContain("...(typeof bridgePort === 'number' ? ['--host-callback-port', String(bridgePort)] : [])")
    expect(source).toContain('sessionMcp: this.buildSessionMcpSpec(callbackBridge?.port)')
    // Positive control: the standalone flag it rides beside is still written.
    expect(source).toContain("'--external-standalone-only'")
  })

  /**
   * P3.13 — the advisor's flag rides the same rule, with one condition more.
   * `--host-callback-port` proves the channel exists; `--advisor-consult` proves
   * the channel exists AND the advisor is on, because a disabled advisor must be
   * invisible rather than advertised in order to refuse (the P2.1 fix wave).
   * Read as text for the same reason as the row above: `buildSessionMcpSpec`
   * runs inside `createRuntime`, which spawns a real app-server.
   */
  it('passes --advisor-consult only with a bridge AND the advisor enabled', () => {
    const source = codexAgentSource()
    expect(source).toContain(
      "...(typeof bridgePort === 'number' && getAdvisorEnabled() ? ['--advisor-consult'] : [])",
    )
    // The setting is READ here, at spawn — not assumed from a cached value.
    expect(source).toContain("import { getAdvisorEnabled } from '../config/storage.ts'")
    // And the consult itself is bound onto the bridge this agent owns, so the
    // route has something to reach.
    expect(source).toContain('advisorConsult: args => this.executeAdvisorConsult(args)')
    // Positive control: the flag it rides beside is still written.
    expect(source).toContain("...(typeof bridgePort === 'number' ? ['--host-callback-port', String(bridgePort)] : [])")
  })

  it('ties the bridge lifetime to the runtime it was written into', () => {
    const source = codexAgentSource()
    expect(source).toContain('callbackBridge = (await this.startCallbackBridge()) ?? null')
    expect(source).toContain('await resources.callbackBridge?.close()')
    // Positive control: the adapter, whose lifetime this copies, is still there.
    expect(source).toContain('await resources.adapter?.close()')
  })
})

/**
 * P6.45-adjacent — inter-session messaging over the bridge.
 *
 * The measured divergence this route closes: `list_sessions` needs no host
 * callback, so a codex session could always ENUMERATE its peers, while
 * `send_agent_message` sat in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` and
 * outside the bridged set, so the same session was refused when it tried to
 * write to one. Pi and claude reach the closure in-process. A switch to codex
 * therefore removed half a capability and left the other half advertised.
 *
 * These run against the REAL `bindSendAgentMessage` closure and a REAL peer
 * session, so what is asserted is that codex reaches the same
 * `deliverAgentMessage` — and the same loop guards — as the other two runtimes,
 * not that a stub was called.
 *
 * TWO bridges for five claims, not five: each `codexSessionWithBridge` builds a
 * whole session manager plus a loopback server, and this file already stands up
 * 21 of them. Adding five more made the shared `afterEach` (which closes every
 * bridge) exceed its 5s budget — a cost of the harness, not of the route, and
 * the claims group cleanly into "a sender is bound" and "no sender is bound".
 */
describe('agent-message/send reaches the host closure the other runtimes use', () => {
  async function withPeer(options?: { bindSender?: boolean }) {
    const h = await codexSessionWithBridge()
    const peerId = `session-codex-peer-${++sessionCounter}`
    const peer = createManagedSessionFn(
      { id: peerId, name: peerId, llmConnection: 'codex-gateway' },
      { id: WORKSPACE_ID, name: 'Codex Callback Bridge Workspace', slug: 'codex-callback-bridge-workspace', rootPath: workspaceRoot, createdAt: Date.now() } as never,
      { messagesLoaded: true, ephemeral: true },
    ) as unknown as ManagedForTest
    h.internals.sessions.set(`${WORKSPACE_ID}:${peerId}`, peer)
    if (options?.bindSender !== false) {
      mergeSessionScopedToolCallbacks(h.sessionKey, {
        sendAgentMessageFn: h.internals.bindSendAgentMessage(h.managed) as never,
      })
    }
    const pending = () => (peer as unknown as { pendingTaskNotifications?: string[] }).pendingTaskNotifications ?? []
    return { ...h, peer, peerId, pending }
  }

  it('delivers to a peer, stops the loop on the echo, and cannot write as another session', async () => {
    const h = await withPeer()
    const body = { sessionId: h.peerId, message: 'the migration finished' }

    const sent = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.agentMessageSend, body)
    expect(sent.status).toBe(200)
    expect(sent.body.result).toEqual({ status: 'delivered' })
    // The peer has no user message yet, so the notification is held as
    // first-turn context rather than starting a turn — the sink's own rule.
    expect(h.pending()).toEqual(['the migration finished'])

    // The SAME loop guards pi and claude get, reached through the bridge: this
    // is the claim that codex is not on a path of its own.
    const echo = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.agentMessageSend, body)
    expect(echo.status).toBe(200)
    const verdict = echo.body.result as { status: string; guard?: string; note?: string }
    expect(verdict.status).toBe('dropped')
    expect(verdict.guard).toBe('identical-repeat')
    expect(verdict.note).toMatch(/not resend/i)
    // N, observed: one delivery, and the second hop died. Not "nothing arrived".
    expect(h.pending()).toHaveLength(1)

    // The envelope owner check, on this route. The closure has the author baked
    // in, so a forged sender is unrepresentable — this pins that the envelope
    // refuses before the closure is even resolved.
    const forged = await h.post(
      HOST_CALLBACK_BRIDGE_ROUTES.agentMessageSend,
      { sessionId: h.peerId, message: 'forged' },
      'some-other-session',
    )
    expect(forged.body.error).toBe(HOST_CALLBACK_BRIDGE_SESSION_MISMATCH)
    expect(h.pending()).toHaveLength(1)
  })

  it('separates a malformed body (400) from an unbound capability (a message)', async () => {
    const h = await withPeer({ bindSender: false })
    for (const payload of [{ sessionId: '', message: 'hi' }, { sessionId: 'peer', message: '   ' }, {}]) {
      const response = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.agentMessageSend, payload)
      // 400 rather than the unbound-closure message: malformed outranks absent,
      // the line `cron/rearmWakeup` and `goal/set` already draw.
      expect(response.status).toBe(400)
      expect(response.body.error).toContain('agent-message/send')
    }

    // The negative control for the three above: a WELL-FORMED body on the same
    // bridge answers with the capability sentence, so the 400s were about the
    // payload and not about the missing binding.
    const unbound = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.agentMessageSend, {
      sessionId: h.peerId,
      message: 'anyone there',
    })
    expect(unbound.body.error).toBe('send_agent_message is unavailable for this session.')
    expect(h.pending()).toEqual([])
  })
})

describe('P3.276 · review/diff reaches the host closure the other runtimes use', () => {
  /** The port `SessionManager` publishes for claude, recording what it was asked. */
  function bindReviewDiff(h: Awaited<ReturnType<typeof codexSessionWithBridge>>) {
    const seen: unknown[] = []
    mergeSessionScopedToolCallbacks(h.sessionKey, {
      reviewDiff: {
        compute: async (request: unknown) => {
          seen.push(request)
          return {
            target: 'uncommitted changes (staged, unstaged, and untracked)',
            diff: 'diff --git a/x b/x\n+one line\n',
            task: 'Review the following uncommitted changes.',
            rubric: 'RUBRIC: correctness bugs first.',
            reviewerAgent: 'reviewer',
          }
        },
      } as never,
    })
    return seen
  }

  it('answers with the diff, the task and the rubric the reviewer needs', async () => {
    // Without this route the tool is ADVERTISED to a bridged codex session (it
    // is in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`) and every call answers
    // "not available in this context" — the shape P3.222 measured for the
    // roster pair, arriving on the next tool.
    const h = await codexSessionWithBridge()
    const seen = bindReviewDiff(h)

    const answered = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.reviewDiff, { scope: 'uncommitted' })

    expect(answered.status).toBe(200)
    const result = answered.body.result as { rubric?: string; task?: string; reviewerAgent?: string }
    // The rubric is the substitution Pi does per call as `reviewerDefWithRubric`;
    // claude cannot swap a subagent's system prompt, so it rides the answer.
    expect(result.rubric).toContain('RUBRIC')
    expect(result.task).toContain('Review the following')
    expect(result.reviewerAgent).toBe('reviewer')
    expect(seen).toEqual([{ scope: 'uncommitted' }])
  })

  it('narrows the payload to the declared target keys and drops everything else', async () => {
    // This body reaches a host sink that spreads it into `normalizeReviewTarget`,
    // so an unnarrowed field is a smuggling surface — `sessionList`'s own rule.
    // `paths` is filtered element-wise because a non-string entry would reach a
    // `git` argument list.
    const h = await codexSessionWithBridge()
    const seen = bindReviewDiff(h)

    const answered = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.reviewDiff, {
      base: '  main  ',
      paths: ['src/a.ts', 42, '   ', 'src/b.ts'],
      instructions: 'focus on the parser',
      sessionKey: { workspaceId: 'somewhere-else', sessionId: 'not-mine' },
      cwd: '/etc',
    })

    expect(answered.status).toBe(200)
    expect(seen).toEqual([{ base: 'main', paths: ['src/a.ts', 'src/b.ts'], instructions: 'focus on the parser' }])
  })

  it('reports the missing port by name instead of answering an empty diff', async () => {
    // A session with no bound port must not look like a repository with no
    // changes: the reviewer would then be delegated an empty task and report
    // that everything is fine.
    const h = await codexSessionWithBridge()

    const refused = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.reviewDiff, {})

    // 200 with `{ error }` is this bridge's own contract for a well-formed but
    // REFUSED request — the client re-throws it and the tool renders it as
    // text. Only a malformed request carries a 4xx. What matters is that the
    // reply is an error naming the capability, never a result.
    expect(refused.status).toBe(200)
    expect(refused.body.result).toBeUndefined()
    expect(String(refused.body.error)).toContain('ReviewDiff is unavailable for this session.')
  })

  it('refuses a request carrying another session\'s id', async () => {
    // The envelope owner check, on this route: the bridge answers for ONE
    // session and a loopback port is reachable by anything on the machine.
    const h = await codexSessionWithBridge()
    bindReviewDiff(h)

    const forged = await h.post(HOST_CALLBACK_BRIDGE_ROUTES.reviewDiff, {}, 'some-other-session')

    expect(forged.status).not.toBe(200)
    expect(String(forged.body.error)).toContain('does not match')
  })
})
