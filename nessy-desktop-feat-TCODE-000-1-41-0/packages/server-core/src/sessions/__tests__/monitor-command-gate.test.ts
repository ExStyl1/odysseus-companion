/**
 * T2 — the host-side permission gate for Monitor `command` watches on non-Pi
 * runtimes.
 *
 * `tools-reference.md`: a Monitor command "uses the same permission rules as
 * Bash, so `allow` and `deny` patterns you have set for Bash apply here too".
 * On Pi that sentence is already true and is enforced ONCE, by the subprocess's
 * PRE-TOOL gate — so `authorizeMonitor` deliberately does nothing there, and a
 * second host-side check would be a second gate that can disagree with the
 * first. Every other runtime reaches `SessionMonitorService.start` without ever
 * passing that gate, so for them the host is the only place the sentence can be
 * made true.
 *
 * D2: the gate lives here, in `authorizeMonitor`, rather than in a Claude
 * pre-tool hook — this is the one chokepoint EVERY producer of a watch goes
 * through, on every runtime, so a third runtime inherits it by construction
 * instead of needing its own copy.
 *
 * The rules are read through `permissionsConfigCache.getMergedConfig`, the same
 * merged layers the codex approval path and Pi's own answer path read — the
 * workspace `permissions.json` written below is a REAL layer of that merge, not
 * a hand-built policy object handed to the evaluator.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionRequest } from '@nessy-agent/core/types'
import type { AgentProvider } from '@nessy-agent/shared/agent'
import { permissionsConfigCache } from '@nessy-agent/shared/agent'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import type { MonitorSocket, MonitorSocketHandlers, SessionMonitorService } from '../session-monitor-service.ts'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const stateRoot = mkdtempSync(join(tmpdir(), 'sm-monitor-command-gate-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-monitor-command-gate'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Monitor Command Gate Workspace',
    slug: 'monitor-command-gate-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

/**
 * The same four cards T1's suite uses. `nestor-cloud-agent` is here for a
 * different reason than it was there: it is a NON-Pi provider that is OUTSIDE
 * `SCHEDULED_DELIVERY_RUNTIMES`, and it pins that this gate keys on "not Pi"
 * rather than on T1's delivery set — gating fewer runtimes than that would
 * leave a runtime executing unchecked commands.
 */
const TEST_CONNECTIONS = [
  {
    slug: 'pi-source',
    name: 'Pi Source',
    providerType: 'pi',
    authType: 'api_key',
    defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
    createdAt: Date.now(),
  },
  {
    slug: 'claude-gateway',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'bearer_token',
    defaultModel: 'claude-gw-model-a',
    createdAt: Date.now(),
  },
  {
    slug: 'codex-gateway',
    name: 'Codex (Nessy Gateway)',
    providerType: 'codex-runtime',
    authType: 'bearer_token',
    defaultModel: 'gpt-5.3-codex',
    createdAt: Date.now(),
  },
  {
    slug: 'nestor-cloud',
    name: 'Nestor Cloud Agent',
    providerType: 'nestor-cloud-agent',
    authType: 'bearer_token',
    createdAt: Date.now(),
  },
] as unknown as NonNullable<StoredConfig['llmConnections']>

type SessionManagerModule = typeof import('../SessionManager.ts')
type ManagedForTest = Record<string, unknown> & { id: string; workspace: { id: string } }

let createManagedSessionFn: SessionManagerModule['createManagedSession']
let createTestSessionManagerFn: typeof import('./test-session-manager.ts')['createTestSessionManager']
let restoreConfig: () => void = () => {}

/**
 * The `beforeAll` below pulls `SessionManager.ts` and its graph, the same
 * module-graph hook two siblings in this directory already budget
 * (`context-usage-after-switch.test.ts`, `cold-session-branching.test.ts`).
 * Without a budget it dies on bun's 5 s default under concurrent-lane load and
 * takes the WHOLE file with it — `0 pass / 1 fail`, `(unnamed)`, "a
 * beforeEach/afterEach hook timed out", 33 tests unrun. That reads like a
 * regression in the permission floor and is not one.
 *
 * 600 s is set against the worst MEASURED wall time, not against the resting
 * one, because a knob set near the resting state manufactures its own failures
 * (the register's own lesson from P3.180). Measured 2026-09-07 on this box:
 *
 *   | Condition                          | Load  | Result              |
 *   | ---------------------------------- | ----- | ------------------- |
 *   | alone, first touch of the graph     | 14.75 | 33 pass / 0 fail, **481.96 s** |
 *   | alone, minutes later, graph warm    | 11.69 | 33 pass / 0 fail, **1.35 s**   |
 *   | the hook's own import, warm probe   | 11.69 | **39 ms**           |
 *
 * Byte-identical work, a ~350x spread — so the number to clear is the 482 s
 * whole-suite reading, whose split between this hook and the file's own
 * top-level imports was NOT separable (the probe that could split it only ever
 * caught the graph warm). It has never failed alone, at any load; the budget is
 * protection against where bun's yields land, not against a slow hook, and it
 * costs nothing on the warm path.
 *
 * RELABELLED 2026-09-07 (`P6.677`): "never failed alone" was this suite's evidence
 * for class (c) STARVATION, and that evidence cannot distinguish starvation from
 * an I/O-bound timer lottery. The zero-case control — `bun test <this file> -t`
 * with a name nothing matches, so no case runs and only the module graph is paid —
 * measured **275.17 s at 0.9 % cpu** (1.65 s user / 0.89 s sys, load 10.23) and
 * then **1.51 s at 80 % cpu** on the repeat: 175x on byte-identical work, with
 * total CPU flat. A process needing 2.5 s of CPU cannot wait 275 s for it at load
 * 10 on eight cores, so nothing starved it — the wall is blocked on reads. The
 * budget is unchanged and is still the right remedy; only the diagnosis moves.
 */
// P6.638 — the budget is the SHARED one now; the reasoning above is this
// file's own measurement and stays. The constant's docblock carries the
// sizing rule and the zero-case-control recipe for whoever sizes the next
// one, so a seventh suite does not rediscover them a seventh time.

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
  storage.saveConfig({ ...base, defaultLlmConnection: 'pi-source', llmConnections: TEST_CONNECTIONS })
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  restoreConfig()
  rmSync(stateRoot, { recursive: true, force: true })
})

/**
 * Write the workspace permission layer. `permissions.json` beside the workspace
 * config is one of the layers `getMergedConfig` composes, so the rules below
 * arrive through the production merge.
 */
function setWorkspaceRules(rules: Array<{ id: string; action: 'allow' | 'ask' | 'deny'; match: unknown }>): void {
  writeFileSync(
    join(workspaceRoot, 'permissions.json'),
    JSON.stringify(rules.length === 0 ? {} : { permissionDsl: { version: 1, rules } }),
    'utf-8',
  )
  permissionsConfigCache.clear()
}

afterEach(() => {
  setWorkspaceRules([])
})

/** `Bash(tail:*)` in the readable form the workspace file accepts. */
const bashPattern = (id: string, action: 'allow' | 'ask' | 'deny', pattern: string) => ({
  id,
  action,
  match: { kind: 'bash', pattern },
})

let sessionCounter = 0

interface Internals {
  sessions: Map<string, unknown>
  sessionMonitors: SessionMonitorService
  resolveManagedProvider(managed: unknown): AgentProvider
  authorizeMonitor(request: unknown): Promise<void>
  evaluateMonitorCommandRules(
    managed: unknown,
    command: string,
    cwd: string,
  ): { action: 'allow' | 'deny'; reason: string } | undefined
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  flushSession(sessionId: string, workspaceId?: string): Promise<void>
  sendMessage(...args: unknown[]): Promise<void>
  resolveNetworkAddressesFn: (host: string) => Promise<string[]>
}

function harness(options: { from: string }) {
  const manager = createTestSessionManagerFn()
  const internals = manager as unknown as Internals
  const workspace = {
    id: WORKSPACE_ID,
    name: 'Monitor Command Gate Workspace',
    slug: 'monitor-command-gate-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const id = `session-monitor-gate-${++sessionCounter}`
  const managed = createManagedSessionFn(
    { id, name: id, llmConnection: options.from },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  ) as unknown as ManagedForTest
  internals.sessions.set(`${workspace.id}:${id}`, managed)

  const prompts: PermissionRequest[] = []
  const openedUrls: string[] = []
  internals.sendEvent = (event: unknown) => {
    const typed = event as { type?: string; request?: PermissionRequest }
    if (typed.type === 'permission_request' && typed.request) prompts.push(typed.request)
  }
  internals.persistSession = () => undefined
  internals.flushSession = async () => undefined
  internals.sendMessage = async () => undefined
  // Pin DNS; name resolution has its own suite and is not what these rows test.
  internals.resolveNetworkAddressesFn = async () => ['93.184.216.34']

  const monitors = internals.sessionMonitors
  ;(monitors as unknown as { options: { openSocket?: unknown } }).options.openSocket = async (
    input: { url: string },
    _handlers: MonitorSocketHandlers,
  ): Promise<MonitorSocket> => {
    openedUrls.push(input.url)
    return { close: () => undefined }
  }

  const sessionKey = { workspaceId: workspace.id, sessionId: id }
  return {
    manager,
    internals,
    managed,
    monitors,
    prompts,
    openedUrls,
    sessionKey,
    startCommand: (command = 'tail -f /tmp/does-not-exist') => monitors.start({
      sessionKey,
      cwd: workspaceRoot,
      workspaceRoot,
      description: 'watch the log',
      timeoutMs: 300_000,
      persistent: false,
      command,
    }),
    /**
     * Call the gate directly, without the executor behind it. Used by the rows
     * that are about the gate's DECISION (which provider it thinks this is,
     * which field it dispatches on) rather than about the wiring — the wiring
     * is already pinned by the rows that go through `monitors.start`.
     */
    authorize: (overrides: Record<string, unknown>) => internals.authorizeMonitor({
      sessionKey,
      cwd: workspaceRoot,
      workspaceRoot,
      description: 'watch the log',
      timeoutMs: 300_000,
      persistent: false,
      ...overrides,
    }),
    startWs: (url = 'wss://events.example.test/stream') => monitors.start({
      sessionKey,
      cwd: workspaceRoot,
      workspaceRoot,
      description: 'watch the event stream',
      timeoutMs: 300_000,
      persistent: false,
      ws: { url },
    }),
    respond: (allowed: boolean) => manager.respondToPermission(
      id,
      prompts.at(-1)!.requestId,
      allowed,
      false,
      undefined,
      workspace.id,
    ),
  }
}

/**
 * Count the gate's OWN rule consultations. This is the detector for the Pi row:
 * "no card was raised" alone would also pass if the gate ran and happened to
 * find an allow rule, so the assertion that matters is that Pi never CONSULTS
 * the rules at all.
 *
 * The first version of this spy wrapped `permissionsConfigCache.getMergedConfig`
 * and was WRONG: that cache has other readers (`PermissionManager`,
 * `mode-manager`, the pre-tool path), so it read 0 when this file ran alone and
 * 2 when the full suite had warmed those paths — a detector measuring the
 * process, not the gate. It counts the gate's own seam instead.
 */
function countRuleConsultations(internals: Internals): { calls: () => number; restore: () => void } {
  const original = internals.evaluateMonitorCommandRules
  let calls = 0
  internals.evaluateMonitorCommandRules = function (this: unknown, ...args: unknown[]) {
    calls += 1
    return original.apply(this, args as never)
  } as Internals['evaluateMonitorCommandRules']
  return {
    calls: () => calls,
    restore: () => { internals.evaluateMonitorCommandRules = original },
  }
}

describe('a deny rule refuses a non-Pi command watch', () => {
  it('refuses with the rule surfaced, raises no card, and leaves no watch', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = harness({ from: 'claude-gateway' })

    let thrown: Error | undefined
    try {
      await h.startCommand('tail -f /var/log/system.log')
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown).toBeDefined()
    // The rule the user wrote is what the refusal names — an unattributed
    // refusal is indistinguishable from a bug in the gate.
    expect(thrown!.message).toContain('no-tail')
    // A refusal is not a decision to hand to the user.
    expect(h.prompts).toEqual([])
    expect(h.monitors.list(h.sessionKey)).toEqual([])
  })

  it('refuses on codex-runtime too', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = harness({ from: 'codex-gateway' })
    await expect(h.startCommand('tail -f /var/log/system.log')).rejects.toThrow('no-tail')
    expect(h.prompts).toEqual([])
  })

  // The gate keys on "not Pi", not on T1's `SCHEDULED_DELIVERY_RUNTIMES`: a
  // provider outside that set still executes the command, so it still needs
  // the check.
  it('refuses on a provider outside SCHEDULED_DELIVERY_RUNTIMES', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = harness({ from: 'nestor-cloud' })
    expect(h.internals.resolveManagedProvider(h.managed)).toBe('nestor-cloud-agent')
    await expect(h.startCommand('tail -f /var/log/system.log')).rejects.toThrow('no-tail')
  })

  // The positive control for all three rows above: the same session, the same
  // rule, a command the rule does not name.
  it('a command the deny rule does not name is not refused by it', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = harness({ from: 'claude-gateway' })
    const started = h.startCommand('echo hello').catch(error => error as Error)
    await Bun.sleep(0)
    // No rule matched `echo`, so this is the card path, not the deny path.
    expect(h.prompts).toHaveLength(1)
    h.respond(false)
    await started
  })
})

// F1.1002 (option A's fail-closed half) — what still collapses the program (a
// broken MANAGED document, or P2.269's deny/ask cap overflow, the route a
// workspace file can reach) refuses a command watch here as Pi refuses every
// call, with the compiler's diagnostic and no rule id. It raised a card until then.
describe('a policy that failed closed refuses a non-Pi command watch (F1.1002)', () => {
  it('refuses with the diagnostic, raises no card, and leaves no watch', async () => {
    setWorkspaceRules(Array.from({ length: 513 }, (_, index) => ({ id: `d${index}`, action: 'deny' as const, match: { kind: 'bash', executable: `x${index}` } })))
    const h = harness({ from: 'claude-gateway' })
    const thrown = await h.startCommand('tail -f /var/log/system.log').then(() => undefined, (error: Error) => error)
    expect(thrown?.message).toContain('deny/ask permission rules')
    expect(thrown?.message).not.toContain('invalid-policy')
    expect(h.prompts).toEqual([])
    expect(h.monitors.list(h.sessionKey)).toEqual([])
  })

  // Boundary: an unreadable workspace document is dropped whole (F1.831) and is
  // not a refusal — the command reaches the card, as with no rule at all.
  it('an unreadable workspace document is not a refusal: the card is raised', async () => {
    writeFileSync(join(workspaceRoot, 'permissions.json'), JSON.stringify({ permissionDsl: 'x' }), 'utf-8')
    permissionsConfigCache.clear()
    const h = harness({ from: 'claude-gateway' })
    const started = h.startCommand('tail -f /var/log/system.log').catch(error => error as Error)
    await Bun.sleep(0)
    expect(h.prompts).toHaveLength(1)
    h.respond(false)
    await started
  })
})

describe('an allow rule starts the watch silently', () => {
  it('raises no card and registers the watch', async () => {
    setWorkspaceRules([bashPattern('allow-echo', 'allow', 'echo:*')])
    const h = harness({ from: 'claude-gateway' })

    await h.startCommand('echo hello')

    expect(h.prompts).toEqual([])
    expect(h.monitors.list(h.sessionKey)).toHaveLength(1)
  })
})

describe('no matching rule raises exactly one card', () => {
  it('approving the card starts the watch', async () => {
    setWorkspaceRules([])
    const h = harness({ from: 'claude-gateway' })

    const pending = h.startCommand('echo hello')
    await Bun.sleep(0)

    expect(h.prompts).toHaveLength(1)
    const prompt = h.prompts[0]!
    expect(prompt.toolName).toBe('Monitor')
    expect(prompt.command).toBe('echo hello')
    // Monitor approvals are per-watch on BOTH sources; `tools-reference.md`
    // records the no-skip-future-prompts property for the tool, not for ws only.
    expect(prompt.noAlwaysAllow).toBe(true)
    // Nothing has been started while the prompt is outstanding.
    expect(h.monitors.list(h.sessionKey)).toEqual([])

    expect(h.respond(true)).toBe(true)
    await pending
    expect(h.monitors.list(h.sessionKey)).toHaveLength(1)
    // Exactly one card, not one per layer consulted.
    expect(h.prompts).toHaveLength(1)
  })

  it('denying the card refuses the watch and leaves nothing behind', async () => {
    setWorkspaceRules([])
    const h = harness({ from: 'claude-gateway' })

    const pending = h.startCommand('echo hello')
    await Bun.sleep(0)
    expect(h.respond(false)).toBe(true)

    await expect(pending).rejects.toThrow('denied')
    expect(h.monitors.list(h.sessionKey)).toEqual([])
  })

  // An `ask` rule is the third documented action and must reach the human, not
  // be mistaken for an allow.
  it('an ask rule raises the card rather than starting', async () => {
    setWorkspaceRules([bashPattern('ask-echo', 'ask', 'echo:*')])
    const h = harness({ from: 'claude-gateway' })

    const pending = h.startCommand('echo hello')
    await Bun.sleep(0)
    expect(h.prompts).toHaveLength(1)
    h.respond(true)
    await pending
    expect(h.monitors.list(h.sessionKey)).toHaveLength(1)
  })
})

describe('Pi keeps its single pre-tool gate', () => {
  it('a Pi command watch consults no rules and raises no card, under a rule that would deny it', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = harness({ from: 'pi-source' })
    expect(h.internals.resolveManagedProvider(h.managed)).toBe('pi')

    const spy = countRuleConsultations(h.internals)
    try {
      // The very command the workspace rule denies. It starts, because on Pi
      // that rule was already applied by the subprocess's pre-tool gate before
      // execution ever reached this service.
      await h.startCommand('tail -f /var/log/system.log')
      expect(spy.calls()).toBe(0)
    } finally {
      spy.restore()
    }
    expect(h.prompts).toEqual([])
    expect(h.monitors.list(h.sessionKey)).toHaveLength(1)
  })

  // The control that keeps the spy honest: the same probe on the same rig, on a
  // runtime that IS gated, must count reads.
  it('the same probe on claude-runtime does consult the rules', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = harness({ from: 'claude-gateway' })

    const spy = countRuleConsultations(h.internals)
    try {
      await expect(h.startCommand('tail -f /var/log/system.log')).rejects.toThrow('no-tail')
      expect(spy.calls()).toBe(1)
    } finally {
      spy.restore()
    }
  })
})

/**
 * The gate's Pi skip must key on the runtime that will RUN the command, not on
 * what the config would resolve today.
 *
 * `resolveManagedProvider` honours the `activeProvider` latch only when it says
 * `'pi'`, and otherwise re-resolves from CURRENT config — session slug →
 * workspace default → global default → `'pi'` when nothing resolves. Every
 * session below has a live agent and a connection slug that resolves to
 * NOTHING, so config falls all the way through to the global default
 * (`pi-source`) and `resolveManagedProvider` answers `'pi'` — the fail-open:
 * a live claude/codex agent skipping the gate entirely and executing an
 * unchecked command.
 */
describe('a live agent decides the provider, not the config', () => {
  /** A live agent handle. Only its presence is read here. */
  const liveAgent = () => ({}) as unknown

  it('resolveManagedProvider really does answer pi for this shape (the fail-open, pinned)', () => {
    const h = harness({ from: 'slug-that-was-deleted' })
    h.managed.agent = liveAgent()
    // No `activeProvider` latch: the agent was published by a non-Pi path.
    expect(h.internals.resolveManagedProvider(h.managed)).toBe('pi')
  })

  it('a live non-Pi agent whose slug was deleted is still gated: a deny rule refuses', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = harness({ from: 'slug-that-was-deleted' })
    h.managed.agent = liveAgent()

    const spy = countRuleConsultations(h.internals)
    try {
      await expect(h.authorize({ command: 'tail -f /var/log/system.log' })).rejects.toThrow('no-tail')
      expect(spy.calls()).toBe(1)
    } finally {
      spy.restore()
    }
    expect(h.prompts).toEqual([])
  })

  it('a live non-Pi agent whose slug was deleted still reaches the card when no rule matches', async () => {
    setWorkspaceRules([])
    const h = harness({ from: 'slug-that-was-deleted' })
    h.managed.agent = liveAgent()

    const pending = h.authorize({ command: 'echo hello' }).catch(error => error as Error)
    await Bun.sleep(0)
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]!.command).toBe('echo hello')
    h.respond(false)
    await pending
  })

  // The other half of the same predicate: a genuinely-Pi live session carries
  // the latch, and still consults nothing.
  it('a genuinely-Pi live session still skips the gate', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = harness({ from: 'pi-source' })
    h.managed.agent = liveAgent()
    h.managed.activeProvider = 'pi'

    const spy = countRuleConsultations(h.internals)
    try {
      await h.authorize({ command: 'tail -f /var/log/system.log' })
      expect(spy.calls()).toBe(0)
    } finally {
      spy.restore()
    }
    expect(h.prompts).toEqual([])
  })

  // A session with NO live agent has nothing else to ask, so config resolution
  // stays the answer there — including its `null → 'pi'` fallback.
  it('an agentless session still resolves through the config', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = harness({ from: 'slug-that-was-deleted' })
    expect(h.managed.agent).toBeFalsy()

    const spy = countRuleConsultations(h.internals)
    try {
      await h.authorize({ command: 'tail -f /var/log/system.log' })
      expect(spy.calls()).toBe(0)
    } finally {
      spy.restore()
    }
    expect(h.prompts).toEqual([])
  })
})

/**
 * An allow rule may save a click; it may not widen the permission MODE.
 *
 * `codex-agent.ts`'s R6 answer path records skipping this exact re-check as a
 * measured bug — "in `plan` or `explore` an allow rule auto-approved a write,
 * with no card" — and Pi's pre-tool gate binds allow rules to the mode too.
 * Without it the host gate was the one path where a rule outranked the mode.
 */
describe('an allow rule is bound to the permission mode', () => {
  /** Not in the read-only set, and it parses — so the mode has a real opinion. */
  const writeCommand = `touch ${join(stateRoot, 'mode-scratch.txt')}`

  for (const mode of ['plan'] as const) {
    it(`falls through to the card in ${mode} mode instead of starting silently`, async () => {
      setWorkspaceRules([bashPattern('allow-touch', 'allow', 'touch:*')])
      const h = harness({ from: 'claude-gateway' })
      h.managed.permissionMode = mode

      const pending = h.authorize({ command: writeCommand }).catch(error => error as Error)
      await Bun.sleep(0)
      // The rule matched and said allow; the mode refused, so the human decides.
      expect(h.prompts).toHaveLength(1)
      expect(h.prompts[0]!.command).toBe(writeCommand)
      h.respond(false)
      await pending
    })
  }

  // The positive control on the same rig: the same rule, the same command, a
  // mode the primitive permits. Without this row the two above would pass on a
  // gate that had stopped honouring allow rules at all.
  for (const mode of ['default', 'auto'] as const) {
    it(`the same allow rule still starts silently in ${mode} mode`, async () => {
      setWorkspaceRules([bashPattern('allow-touch', 'allow', 'touch:*')])
      const h = harness({ from: 'claude-gateway' })
      h.managed.permissionMode = mode

      await h.authorize({ command: writeCommand })

      expect(h.prompts).toEqual([])
    })
  }

  /**
   * P6.191 — auto mode's DEFAULT-ON suspension of BROAD shell grants, at the
   * one site the page names by name.
   *
   * `auto-mode-config.md#route-all-shell-commands-through-the-classifier`:
   * "By default, narrow Bash and PowerShell allow rules such as `Bash(npm test)`
   * stay in effect in auto mode … Claude Code suspends only the broad rules that
   * grant arbitrary code execution, such as `Bash(*)` or wildcarded
   * interpreters, together with every rule that names `Monitor`, because Monitor
   * commands run through the shell."
   *
   * The narrow half is already pinned by the `touch:*` rows above, which is why
   * they are the control this block leans on: `Bash(touch:*)` names a program,
   * so it keeps starting the watch silently in `auto` while the rules below stop
   * doing so.
   */
  describe('auto mode suspends a BROAD grant here, and only in auto (P6.191)', () => {
    // Each case carries the command its own rule actually matches — otherwise
    // the auto-mode arm would pass for the wrong reason (a card raised because
    // nothing matched, not because the grant was suspended), and the default
    // arm is what proves the rule does match and does allow.
    for (const [label, rule, command] of [
      ['Bash(*)', bashPattern('allow-anything', 'allow', '*'), writeCommand],
      ['a wildcarded interpreter', bashPattern('allow-sh', 'allow', 'sh *'), `sh ${join(stateRoot, 'watch.sh')}`],
      [
        'a bare Monitor grant',
        { id: 'allow-monitor', action: 'allow' as const, match: { kind: 'tool', semanticId: 'Monitor' } },
        writeCommand,
      ],
    ] as const) {
      it(`${label} falls through to the card in auto mode`, async () => {
        setWorkspaceRules([rule])
        const h = harness({ from: 'claude-gateway' })
        h.managed.permissionMode = 'auto'

        const pending = h.authorize({ command }).catch(error => error as Error)
        await Bun.sleep(0)
        expect(h.prompts).toHaveLength(1)
        h.respond(false)
        await pending
      })

      // "Leaving auto mode restores the rule verbatim" — the same stored rule,
      // the same command, no recompilation: only the evaluation differs. This is
      // also the positive control for the row above.
      it(`${label} still starts the watch silently in default mode`, async () => {
        setWorkspaceRules([rule])
        const h = harness({ from: 'claude-gateway' })
        h.managed.permissionMode = 'default'

        await h.authorize({ command })

        expect(h.prompts).toEqual([])
      })
    }

    // The NARROW half of the same sentence, in auto mode: `Bash(npm test)`-shaped
    // rules "stay in effect", so a program-named grant still answers.
    it('a narrow grant still starts the watch silently in auto mode', async () => {
      setWorkspaceRules([bashPattern('allow-touch', 'allow', 'touch:*')])
      const h = harness({ from: 'claude-gateway' })
      h.managed.permissionMode = 'auto'

      await h.authorize({ command: writeCommand })

      expect(h.prompts).toEqual([])
    })

    // No RESTRICTION is lifted by the suspension: a broad DENY is untouched, so
    // auto mode cannot become the loosest mode by way of this branch.
    it('a broad deny rule still refuses terminally in auto mode', async () => {
      setWorkspaceRules([bashPattern('deny-anything', 'deny', '*')])
      const h = harness({ from: 'claude-gateway' })
      h.managed.permissionMode = 'auto'

      await expect(h.authorize({ command: writeCommand })).rejects.toThrow('deny-anything')
      expect(h.prompts).toEqual([])
    })
  })

  // Deny outranks everything and is decided before the mode is consulted: a
  // read-only mode must not turn a terminal refusal into a card.
  it('a deny rule still refuses terminally in plan mode', async () => {
    setWorkspaceRules([bashPattern('no-touch', 'deny', 'touch:*')])
    const h = harness({ from: 'claude-gateway' })
    h.managed.permissionMode = 'plan'

    await expect(h.authorize({ command: writeCommand })).rejects.toThrow('no-touch')
    expect(h.prompts).toEqual([])
  })
})

/**
 * The gate and the executor must select on the SAME field.
 * `SessionMonitorService.start` runs `request.command !== undefined ?
 * startCommand : startWebSocket`; this gate used to select on `!request.ws`,
 * the inverse. A request carrying both fields was therefore authorized as a
 * `ws` watch and then executed as a command.
 */
describe('the gate dispatches on the same field the executor does', () => {
  it('a request carrying both command and ws is authorized as a command', async () => {
    setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
    const h = harness({ from: 'claude-gateway' })

    await expect(h.authorize({
      command: 'tail -f /var/log/system.log',
      ws: { url: 'wss://events.example.test/stream' },
    })).rejects.toThrow('no-tail')
    // The `ws` path would have raised its own card; the command path refused
    // before any decision was offered.
    expect(h.prompts).toEqual([])
  })
})

describe('the ws source is unchanged on every runtime', () => {
  for (const from of ['pi-source', 'claude-gateway'] as const) {
    it(`still raises its own one-shot card on ${from}, with a command deny rule standing`, async () => {
      // The deny rule names a command; a ws watch carries none, so it must not
      // inherit anything from it.
      setWorkspaceRules([bashPattern('no-tail', 'deny', 'tail:*')])
      const h = harness({ from })

      const pending = h.startWs()
      await Bun.sleep(0)

      expect(h.prompts).toHaveLength(1)
      const prompt = h.prompts[0]!
      expect(prompt.toolName).toBe('Monitor')
      expect(prompt.command).toBe('wss://events.example.test/stream')
      expect(prompt.noAlwaysAllow).toBe(true)
      expect(h.openedUrls).toEqual([])

      expect(h.respond(true)).toBe(true)
      await pending
      expect(h.openedUrls).toEqual(['wss://events.example.test/stream'])
      expect(h.monitors.list(h.sessionKey)).toHaveLength(1)
    })

    it(`still refuses a denied ws watch on ${from}`, async () => {
      const h = harness({ from })
      const pending = h.startWs()
      await Bun.sleep(0)
      expect(h.respond(false)).toBe(true)
      await expect(pending).rejects.toThrow('was denied')
      expect(h.openedUrls).toEqual([])
      expect(h.monitors.list(h.sessionKey)).toEqual([])
    })
  }
})
