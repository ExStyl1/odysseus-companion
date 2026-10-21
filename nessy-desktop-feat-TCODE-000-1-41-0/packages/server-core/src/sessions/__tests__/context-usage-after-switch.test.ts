import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import type { ContextUsageSnapshot, SessionEvent } from '@nessy-agent/shared/protocol/dto'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

/**
 * T11 — does the context state survive a runtime switch?
 *
 * Lane F of `2026-08-14-runtime-icons-plates-model-sync.md` (F1–F9) made the
 * window, the threshold and the occupancy correct on each runtime STANDING
 * STILL: three arms, each inside one runtime, all live-proven. What that work
 * structurally could not cover is the move itself — the field that decides the
 * window (the connection, its models, each model's `contextWindow`) is exactly
 * what changes under a live session.
 *
 * So this file asserts lane F's properties ACROSS a switch rather than within
 * one runtime, on the three things the meter is made of:
 *
 * - the WINDOW — the divisor must belong to the runtime the session is on now;
 * - the THRESHOLD — `thresholdKind` must come from the target's own capability,
 *   never from the runtime the session left (F4: an invented threshold is worse
 *   than none, because the reader takes it as a measurement);
 * - the OCCUPANCY — the numerator, which is NOT cleared and heals on the first
 *   turn; recorded here because it is the half of the pair that survives.
 *
 * The turn is driven through `processEvent`, the same production seam
 * `context-usage-turn-persistence.test.ts` uses — the chat loop's own entry
 * point for a backend usage report.
 */

// CONFIG_DIR freezes at the first import of `config/paths.ts`, which the repo's
// `[test].preload` has already triggered by the time this module's body runs.
// Same shape as `runtime-switch-session.test.ts`: write the connections INTO
// the frozen dir in `beforeAll`, restore whatever was there in `afterAll`.
const stateRoot = mkdtempSync(join(tmpdir(), 'sm-context-after-switch-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-context-after-switch'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Context After Switch Workspace',
    slug: 'context-after-switch-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

/** Windows are per-connection on purpose: the switch is what changes them. */
const PI_WINDOW = 240_000
const PI_NARROW_WINDOW = 128_000
const CODEX_WINDOW = 272_000

const TEST_CONNECTIONS = [
  {
    slug: 'ctx-pi-wide',
    name: 'Pi Wide',
    providerType: 'pi',
    authType: 'api_key',
    models: [{ id: 'pi-wide-model', name: 'Pi Wide Model', contextWindow: PI_WINDOW }],
    defaultModel: 'pi-wide-model',
    createdAt: Date.now(),
  },
  {
    slug: 'ctx-pi-narrow',
    name: 'Pi Narrow',
    providerType: 'pi',
    authType: 'api_key',
    models: [{ id: 'pi-narrow-model', name: 'Pi Narrow Model', contextWindow: PI_NARROW_WINDOW }],
    defaultModel: 'pi-narrow-model',
    createdAt: Date.now(),
  },
  {
    slug: 'ctx-codex-gateway',
    name: 'Codex (Nessy Gateway)',
    providerType: 'codex-runtime',
    authType: 'bearer_token',
    models: [{ id: 'gpt-5.3-codex', name: 'gpt-5.3-codex', contextWindow: CODEX_WINDOW }],
    defaultModel: 'gpt-5.3-codex',
    createdAt: Date.now(),
  },
  {
    slug: 'ctx-claude-gateway',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'bearer_token',
    models: [{ id: 'claude-gw-model-a', name: 'Claude GW A', contextWindow: 200_000 }],
    defaultModel: 'claude-gw-model-a',
    createdAt: Date.now(),
  },
] as unknown as NonNullable<StoredConfig['llmConnections']>

type SessionManagerModule = typeof import('../SessionManager.ts')
type ManagerInstance = InstanceType<SessionManagerModule['SessionManager']>
type ManagedForTest = Record<string, unknown> & {
  id: string
  workspace: { id: string }
  contextUsage?: ContextUsageSnapshot
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    contextTokens: number
    contextWindow?: number
    contextUsage?: ContextUsageSnapshot
  }
}
type Internals = {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  sendCapabilitiesChanged(managed: unknown): void
}

let createManagedSessionFn: SessionManagerModule['createManagedSession']
let createTestSessionManagerFn: typeof import('./test-session-manager.ts')['createTestSessionManager']

let restoreConfig: () => void = () => {}

/**
 * P3.180 — this hook's budget was NINE TIMES below its own resting cost.
 *
 * The suite was registered as losing a lifecycle hook "only when sharing a
 * process with three other suites", which read like contention. Profiled
 * 2026-09-01 at load 7.8, step by step, it is nothing of the kind: the whole
 * hook is `import('../SessionManager.ts')` — **44 668 ms** of it, against
 * bun 1.3.14's default 5 000 ms — with the other three steps costing 52 ms, 0
 * and 0 together. `SessionManager.ts` is 27 286 lines and its graph is most of
 * this package.
 *
 * Why it looked like contention, and why the correlation was a red herring:
 * bun's hook budget is a TIMER, so it can only fire when the transpile lets the
 * loop breathe. A 1 s heartbeat armed beside the import ticked 13 times in
 * 44.7 s, with one gap of **31 512 ms**. Whether a run goes red is therefore
 * decided by where those few yields happen to land relative to the 5 s mark —
 * which is why the same suite measured 5 pass / 0 fail alone at 04:44 and
 * `(fail) (unnamed)` alone three times for three at 05:2x, and why it passed a
 * 4-suite batch at load 118 (81.64 s, 131/0) after failing one at load 9.
 *
 * So the fix is the budget, not the code under test and not the process it
 * shares. 120 s is set against the MEASURED floor rather than against zero: the
 * import alone has measured 44.7 s at load 7.8 and 57.2 s at load 82, and a
 * knob set near the resting state manufactures its own failures.
 */
// P6.638 — the budget is the SHARED one now; the reasoning above is this
// file's own measurement and stays. The constant's docblock carries the
// sizing rule and the zero-case-control recipe for whoever sizes the next
// one, so a seventh suite does not rediscover them a seventh time.

beforeAll(async () => {
  ;({ createManagedSession: createManagedSessionFn } = await import('../SessionManager.ts'))
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
  storage.saveConfig({ ...base, defaultLlmConnection: 'ctx-pi-wide', llmConnections: TEST_CONNECTIONS })
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  restoreConfig()
  rmSync(stateRoot, { recursive: true, force: true })
})

let sessionCounter = 0

function createHarness(options: { from: string; model?: string } = { from: 'ctx-pi-wide' }) {
  const manager = createTestSessionManagerFn()
  const events: SessionEvent[] = []
  manager.setEventSink(((...args: unknown[]) => { events.push(args[2] as SessionEvent) }) as never)
  const workspace = {
    id: WORKSPACE_ID,
    name: 'Context After Switch Workspace',
    slug: 'context-after-switch-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const id = `session-context-switch-${++sessionCounter}`
  const managed = createManagedSessionFn(
    {
      id,
      name: id,
      llmConnection: options.from,
      ...(options.model ? { model: options.model } : {}),
    },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  ) as unknown as ManagedForTest
  // A transcript, so the cross-runtime arms take the handoff branch a real
  // mid-conversation switch takes rather than the empty-session shortcut.
  managed.messages = [{ id: 'm1', role: 'user', content: 'add a retry' }] as never
  // T4's hostability precondition is stubbed here for the same reason
  // `runtime-switch-session.test.ts` stubs it: its verdict depends on this
  // machine (runtime binaries on disk, the process credential singleton), and
  // what THIS suite owns is context-window accounting across a switch, not
  // whether the target could start. Relying on the check's fail-open arms
  // instead would make the suite order-dependent — measured 2026-08-20: these
  // rows passed alone and failed in a full `bun test packages/server-core`,
  // because another file in the same process had bound the credential
  // singleton and the arm then refused `ctx-codex-gateway` for real.
  ;(manager as unknown as Record<string, unknown>).assertSwitchTargetHostable = async () => {}
  managed.agent = null
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${id}`, managed)
  return {
    manager: manager as ManagerInstance,
    managed,
    events,
    internals: manager as unknown as Internals,
  }
}

/** The shape Pi reports — the only runtime that sends a context SNAPSHOT. */
function piSnapshot(inputTokens: number, contextWindow: number): ContextUsageSnapshot {
  return {
    inputTokens,
    contextWindow,
    contextWindowSource: 'runtime',
    percent: Math.round((inputTokens / contextWindow) * 100),
    remainingWindow: contextWindow - inputTokens,
    autoCompactionEnabled: true,
    autoCompactionThreshold: Math.round(contextWindow * 0.8),
    source: 'sdk_usage',
  }
}

/** One turn's usage report, through the seam the chat loop feeds. */
function usageTurn(
  internals: Internals,
  managed: ManagedForTest,
  usage: Record<string, unknown>,
): Promise<void> {
  return internals.processEvent(managed, { type: 'usage_update', usage })
}

function thresholdKindOfLastCapabilities(events: SessionEvent[]): string | undefined {
  const changed = events.filter(event => event.type === 'capabilities_changed')
  const last = changed.at(-1) as { capabilities?: { contextUsage?: { thresholdKind?: string } } } | undefined
  return last?.capabilities?.contextUsage?.thresholdKind
}

describe('context state across a runtime switch', () => {
  it('divides by the TARGET runtime window, not the one the session left', async () => {
    const { manager, managed, internals } = createHarness({ from: 'ctx-pi-wide' })
    await usageTurn(internals, managed, {
      inputTokens: 150_000,
      contextWindow: PI_WINDOW,
      contextUsage: piSnapshot(150_000, PI_WINDOW),
    })
    expect(managed.contextUsage?.contextWindow).toBe(PI_WINDOW)
    expect(managed.tokenUsage?.contextWindow).toBe(PI_WINDOW)

    await manager.switchSessionRuntime(managed.id, 'ctx-codex-gateway', managed.workspace.id)

    // `applyContextUsageSnapshot` writes the snapshot in THREE places, so a
    // switch that cleared only `managed.contextUsage` would leave Pi's window
    // dividing codex's tokens until codex's first report.
    expect(managed.contextUsage).toBeUndefined()
    // The third place lives INSIDE `tokenUsage`, so `tokenUsage` itself has to
    // survive the switch for the next two lines to be about it. A switch that
    // dropped the whole record — losing the turn counts with it — would satisfy
    // both `?.` assertions while clearing far more than the snapshot.
    expect(managed.tokenUsage).toBeDefined()
    expect(managed.tokenUsage?.contextUsage).toBeUndefined()
    expect(managed.tokenUsage?.contextWindow).toBeUndefined()

    // Codex's first turn: it reports counts and a window (F3b writes
    // `model_context_window` from the spawn model's synced window) and never a
    // context SNAPSHOT — which is why its composer capability stays
    // `kind: 'unavailable'`.
    await usageTurn(internals, managed, { inputTokens: 12_000, contextWindow: CODEX_WINDOW })

    expect(managed.tokenUsage?.contextWindow).toBe(CODEX_WINDOW)
    expect(managed.tokenUsage?.inputTokens).toBe(12_000)
    expect(managed.contextUsage).toBeUndefined()
  })

  // CONTROL for the row above, and the one that would fail if the switch
  // cleared only `managed.contextUsage`: F3(b)'s rule is "no window, no
  // invented limit", so a target whose catalogue has no window must leave the
  // meter unknown. If the source's `tokenUsage.contextWindow` survived, this
  // reads 240 000 — a number no runtime in this session ever measured.
  it('leaves the window unknown when the target reports none, rather than reusing the source one', async () => {
    const { manager, managed, internals } = createHarness({ from: 'ctx-pi-wide' })
    await usageTurn(internals, managed, {
      inputTokens: 150_000,
      contextWindow: PI_WINDOW,
      contextUsage: piSnapshot(150_000, PI_WINDOW),
    })
    expect(managed.tokenUsage?.contextWindow).toBe(PI_WINDOW)

    await manager.switchSessionRuntime(managed.id, 'ctx-codex-gateway', managed.workspace.id)
    await usageTurn(internals, managed, { inputTokens: 9_000 })

    expect(managed.tokenUsage?.inputTokens).toBe(9_000)
    expect(managed.tokenUsage?.contextWindow).toBeUndefined()
  })

  it('carries no threshold from the runtime it left', async () => {
    // Pi reports its own threshold, so the composer draws the number the SDK
    // will act on: `real`. Captured on the same seam the switch emits from, so
    // the before/after pair is one measurement rather than two derivations.
    const toClaude = createHarness({ from: 'ctx-pi-wide' })
    toClaude.internals.sendCapabilitiesChanged(toClaude.managed)
    expect(thresholdKindOfLastCapabilities(toClaude.events)).toBe('real')

    await toClaude.manager.switchSessionRuntime(
      toClaude.managed.id, 'ctx-claude-gateway', toClaude.managed.workspace.id,
    )
    // The SDK does not report its threshold but derives it from the window F2
    // syncs, so the renderer computes the same number instead of guessing.
    expect(thresholdKindOfLastCapabilities(toClaude.events)).toBe('formula-claude')
    expect(thresholdKindOfLastCapabilities(toClaude.events)).not.toBe('legacy')

    // Codex has a limit nothing here can derive, so it gets NO warning rather
    // than a made-up one — a different value again, so neither arm can be
    // passing on a constant.
    const toCodex = createHarness({ from: 'ctx-pi-wide' })
    await toCodex.manager.switchSessionRuntime(
      toCodex.managed.id, 'ctx-codex-gateway', toCodex.managed.workspace.id,
    )
    expect(thresholdKindOfLastCapabilities(toCodex.events)).toBe('none')

    // And the return trip restores Pi's own kind — the threshold follows the
    // runtime in both directions, not just away from Pi.
    const backToPi = createHarness({ from: 'ctx-codex-gateway' })
    await backToPi.manager.switchSessionRuntime(
      backToPi.managed.id, 'ctx-pi-wide', backToPi.managed.workspace.id,
    )
    expect(thresholdKindOfLastCapabilities(backToPi.events)).toBe('real')
  })

  it('re-reads the window when the same runtime changes connection, and self-heals on the first turn', async () => {
    // The case lane F could not reach: the CONNECTION decides the window, and a
    // same-runtime move changes it without changing the runtime.
    //
    // `clearRuntimeScopedSessionState` runs only for `connection-cross-runtime`
    // (`SessionManager.ts:15107`), so the source's window survives the switch
    // itself. Recorded rather than fixed — it is bounded by the next turn (Pi
    // re-reports its window every turn, and this is the only runtime that
    // reports a snapshot at all), and the identical transient already exists on
    // the plain model-change path, which is not a runtime switch.
    const { manager, managed, internals } = createHarness({ from: 'ctx-pi-wide' })
    await usageTurn(internals, managed, {
      inputTokens: 100_000,
      contextWindow: PI_WINDOW,
      contextUsage: piSnapshot(100_000, PI_WINDOW),
    })

    const result = await manager.switchSessionRuntime(managed.id, 'ctx-pi-narrow', managed.workspace.id)
    expect(result.kind).toBe('connection-same-runtime')
    // The transient, stated so a later change to it is visible as a change.
    expect(managed.tokenUsage?.contextWindow).toBe(PI_WINDOW)

    await usageTurn(internals, managed, {
      inputTokens: 100_000,
      contextWindow: PI_NARROW_WINDOW,
      contextUsage: piSnapshot(100_000, PI_NARROW_WINDOW),
    })

    expect(managed.contextUsage?.contextWindow).toBe(PI_NARROW_WINDOW)
    expect(managed.tokenUsage?.contextWindow).toBe(PI_NARROW_WINDOW)
    expect(managed.contextUsage?.inputTokens).toBe(100_000)
  })

  it('keeps the occupancy counters across the switch and overwrites them on the first turn', async () => {
    // The numerator is deliberately NOT cleared where the divisor is: these two
    // counters are also the session's cumulative accounting (`totalTokens` is
    // `inputTokens + outputTokens`, and the cost rows read the same record), so
    // zeroing them at a switch would rewrite history rather than the meter.
    // Between the switch and the target's first report they therefore still
    // hold the source runtime's last reading — bounded, because every backend
    // writes `inputTokens` on its first usage event.
    const { manager, managed, internals } = createHarness({ from: 'ctx-pi-wide' })
    await usageTurn(internals, managed, {
      inputTokens: 150_000,
      contextWindow: PI_WINDOW,
      contextUsage: piSnapshot(150_000, PI_WINDOW),
    })
    expect(managed.tokenUsage?.contextTokens).toBe(150_000)

    await manager.switchSessionRuntime(managed.id, 'ctx-claude-gateway', managed.workspace.id)
    expect(managed.tokenUsage?.inputTokens).toBe(150_000)
    expect(managed.tokenUsage?.contextTokens).toBe(150_000)

    await usageTurn(internals, managed, { inputTokens: 31_000, contextWindow: 200_000 })

    expect(managed.tokenUsage?.inputTokens).toBe(31_000)
    expect(managed.tokenUsage?.contextWindow).toBe(200_000)
  })
})
