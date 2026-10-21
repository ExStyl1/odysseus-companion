import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentProvider, PermissionMode, ThinkingLevel } from '@nessy-agent/shared/agent'
import type { HistoryCarryPlan } from '@nessy-agent/shared/protocol'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { initializeCredentialManagerV2 } from '@nessy-agent/shared/credentials'
import { gatewayModelFixture } from '@nessy-agent/shared/config/__tests__/fixtures/gateway-connection-fixture.ts'
import { hookEventColumnMeasured, hookEventNativeRoute, hookEventsThatNeverFire } from '@nessy-agent/shared/automations'
import { AGENT_PROVIDERS } from '@nessy-agent/shared/agent/backend/runtime-vocabulary'
import {
  createComponentHookLayer,
  parseSkillFrontmatterHooks,
  type SkillInvocationRecord,
} from '@nessy-agent/shared/capabilities/runtime-skill-content'
import { buildRuntimeHandoffPayload, HANDOFF_IMAGE_NOTE } from '../runtime-handoff.ts'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// CONFIG_DIR freezes at the first import of `config/paths.ts`, which the repo's
// `[test].preload` (isolate-shared-config-dir.ts) has already triggered by the
// time this module's body runs. Setting `NESSY_CONFIG_DIR` here would be a
// no-op, so the connections are written INTO the frozen dir in `beforeAll` and
// whatever was there is restored in `afterAll`.
const stateRoot = mkdtempSync(join(tmpdir(), 'sm-runtime-switch-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-runtime-switch'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Runtime Switch Workspace',
    slug: 'runtime-switch-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

/**
 * P3/A3 · the catalogs are OBJECT-shaped, the way a real one-click card is.
 *
 * `getDefaultModelsForConnection` returns `[]` for `pi_compat`,
 * `claude-runtime` and `codex-runtime`, and `MODEL_REGISTRY` holds no `tgpt/`
 * ids — so for a gateway connection the ONLY tier of `resolveContextWindow`
 * that can produce a window is an object-shaped `connection.models` carrying
 * `contextWindow`. With bare id strings here, every window in this suite
 * resolves `'unavailable'` and the carry planner's whole size arm is untested
 * from this side.
 *
 * **The ids are unchanged on purpose.** `pi-source` and `codex-gateway` carry
 * DISJOINT catalogs, and the model-reset row below is the negative control T3
 * must not disturb — adding `contextWindow` must not quietly make them overlap.
 */
const modelDef = (
  id: string,
  contextWindow: number,
  provider: string,
  /**
   * Left off unless a row's subject IS the declaration. After `ebbfca53d` an
   * undeclared model is deliberately un-gated — the host carries the modality
   * and the endpoint refuses — so an omitted `supportsImages` here means
   * "nobody said", which is a different fixture from "said no".
   */
  supportsImages?: boolean,
) => gatewayModelFixture({
  // P6.784 — the shape now comes from the card's own builder, which is what
  // puts `supportsThinking: false` into every row here. Written by hand it was
  // absent, and `ModelDefinition` documents that field as *"Defaults to true
  // when undefined"* while both shipped gateway rows declare `false` — so every
  // fixture in this suite stood for a card that reasons, which the shipped one
  // does not, and the reasoning-carry switch costs read exactly that field.
  //
  // `imagesUndeclared` is the escape the builder grew for this file: the third
  // state above cannot be said with a value, so it is said by deleting the key.
  id,
  contextWindow,
  provider,
  ...(supportsImages === undefined
    ? { imagesUndeclared: true }
    : { overrides: { supportsImages } }),
})

const TEST_CONNECTIONS = [
  {
    slug: 'pi-source',
    name: 'Pi Source',
    providerType: 'pi',
    authType: 'api_key',
    models: [modelDef('tgpt/qwen35-397b-a17b-fp8', 262_144, 'pi')],
    defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
    createdAt: Date.now(),
  },
  {
    slug: 'claude-max',
    name: 'Claude Pro/Max',
    providerType: 'anthropic',
    authType: 'oauth',
    createdAt: Date.now(),
  },
  {
    slug: 'claude-gateway',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'bearer_token',
    // Both entries DECLARE `supportsImages: false`, exactly as the shipped card
    // does (`nessy-gateway.ts` — both `NESSY_GATEWAY_MODELS` rows carry it, and
    // `fetchNestorModels` spreads the stored override back over every refresh).
    // This is the T12 subject: a target that has SAID it takes no images. It was
    // undeclared here until P3.152, which made the fixture depend on the
    // undeclared default `ebbfca53d` removed rather than on a declaration.
    models: [
      modelDef('claude-gw-model-a', 200_000, 'anthropic', false),
      modelDef('claude-gw-model-b', 200_000, 'anthropic', false),
    ],
    defaultModel: 'claude-gw-model-a',
    createdAt: Date.now(),
  },
  {
    slug: 'codex-gateway',
    name: 'Codex (Nessy Gateway)',
    providerType: 'codex-runtime',
    authType: 'bearer_token',
    models: [
      modelDef('gpt-5.3-codex', 272_000, 'codex-runtime'),
      modelDef('gpt-5.3-codex-mini', 272_000, 'codex-runtime'),
    ],
    defaultModel: 'gpt-5.3-codex',
    createdAt: Date.now(),
  },
  // ── T3 fixtures ────────────────────────────────────────────────────────────
  //
  // The four above cannot express T3's subject, and that is deliberate: they are
  // the negative control. These five carry the shapes the guards exist for.
  //
  // `pi-shared` / `claude-shared` are the OVERLAPPING pair — the real product
  // shape, not a contrivance. Both gateway cards are seeded from the identical
  // `NESSY_GATEWAY_MODELS` catalogue against the identical base URL
  // (`apps/electron/src/renderer/components/apisetup/nessy-gateway.ts`), so the
  // two real ids are used verbatim: the coder default and "Qwen Fast".
  {
    slug: 'pi-shared',
    name: 'Nessy Gateway (Pi)',
    providerType: 'pi',
    authType: 'bearer_token',
    models: [
      modelDef('tgpt/qwen35-397b-a17b-fp8', 262_144, 'pi'),
      modelDef('tgpt/qwen36-35b-a3b-fp8', 262_144, 'pi'),
    ],
    defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
    createdAt: Date.now(),
  },
  {
    slug: 'claude-shared',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'bearer_token',
    models: [
      modelDef('tgpt/qwen35-397b-a17b-fp8', 262_144, 'anthropic'),
      modelDef('tgpt/qwen36-35b-a3b-fp8', 262_144, 'anthropic'),
    ],
    defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
    createdAt: Date.now(),
  },
  // Guard 1, the arm with a default: a BYO Anthropic key. No `models` at all —
  // a custom endpoint that has never been listed, which is the ordinary state
  // of a connection before its first catalogue fetch.
  {
    slug: 'anthropic-byo',
    name: 'Anthropic (BYO key)',
    providerType: 'anthropic',
    authType: 'api_key',
    defaultModel: 'claude-sonnet-4-6',
    createdAt: Date.now(),
  },
  // Guard 2: a `pi` connection whose declared default is not in its own
  // catalogue — the model was retired from the gateway and the record kept it.
  {
    slug: 'pi-stale-default',
    name: 'Pi (stale default)',
    providerType: 'pi',
    authType: 'bearer_token',
    models: [
      modelDef('tgpt/qwen35-397b-a17b-fp8', 262_144, 'pi'),
      modelDef('tgpt/qwen36-35b-a3b-fp8', 262_144, 'pi'),
    ],
    defaultModel: 'tgpt/retired-model',
    createdAt: Date.now(),
  },
  // Guard 3: a `codex-runtime` connection that declares NO default. Reaching
  // `resolveModelForProvider`'s `default:` arm with nothing to fall back on is
  // what would hand a Codex session an Opus id.
  // P6.86's subject, and the only reason it is here: the ONE provider whose
  // hook-event column carries no claim. It exists so the refusal that keeps that
  // silence safe can be DRIVEN through the real method rather than read off the
  // source line that implements it.
  {
    slug: 'nestor-remote',
    name: 'Nestor Cloud Agent',
    providerType: 'nestor-cloud-agent',
    authType: 'bearer_token',
    createdAt: Date.now(),
  },
  {
    slug: 'codex-nodefault',
    name: 'Codex (no default)',
    providerType: 'codex-runtime',
    authType: 'bearer_token',
    models: [
      modelDef('gpt-5.3-codex', 272_000, 'codex-runtime'),
      modelDef('gpt-5.3-codex-mini', 272_000, 'codex-runtime'),
    ],
    createdAt: Date.now(),
  },
] as unknown as NonNullable<StoredConfig['llmConnections']>

type SessionManagerModule = typeof import('../SessionManager.ts')
type ManagerInstance = InstanceType<SessionManagerModule['SessionManager']>
type ManagedForTest = Record<string, unknown> & { id: string; workspace: { id: string } }

let createManagedSessionFn: SessionManagerModule['createManagedSession']
let setSessionPlatformFn: SessionManagerModule['setSessionPlatform']
let createHeadlessPlatformFn: typeof import('../../runtime/platform-headless.ts')['createHeadlessPlatform']
let createTestSessionManagerFn: typeof import('./test-session-manager.ts')['createTestSessionManager']
let readRuntimeAnchorFn: typeof import('@nessy-agent/shared/sessions')['readRuntimeAnchor']
let writeRuntimeAnchorFn: typeof import('@nessy-agent/shared/sessions')['writeRuntimeAnchor']
let getPermissionModeDiagnosticsFn: typeof import('@nessy-agent/shared/agent')['getPermissionModeDiagnostics']
let setPermissionModeFn: typeof import('@nessy-agent/shared/agent')['setPermissionMode']
let defaultManagedPiPolicy: typeof import('@nessy-agent/shared/agent/pi-harness/managed-policy')['DEFAULT_MANAGED_PI_POLICY']
let getLlmConnectionFn: typeof import('@nessy-agent/shared/config/storage')['getLlmConnection']

let restoreConfig: () => void = () => {}

beforeAll(async () => {
  ;({ createManagedSession: createManagedSessionFn, setSessionPlatform: setSessionPlatformFn } = await import('../SessionManager.ts'))
  ;({ createHeadlessPlatform: createHeadlessPlatformFn } = await import('../../runtime/platform-headless.ts'))
  ;({ createTestSessionManager: createTestSessionManagerFn } = await import('./test-session-manager.ts'))
  const sessions = await import('@nessy-agent/shared/sessions')
  readRuntimeAnchorFn = sessions.readRuntimeAnchor
  writeRuntimeAnchorFn = sessions.writeRuntimeAnchor
  ;({ getPermissionModeDiagnostics: getPermissionModeDiagnosticsFn, setPermissionMode: setPermissionModeFn } =
    await import('@nessy-agent/shared/agent'))
  ;({ DEFAULT_MANAGED_PI_POLICY: defaultManagedPiPolicy } =
    await import('@nessy-agent/shared/agent/pi-harness/managed-policy'))

  const storage = await import('@nessy-agent/shared/config/storage')
  getLlmConnectionFn = storage.getLlmConnection
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
  // W2-l, 2026-09-03 — AN EXPLICIT BUDGET, SET AGAINST THE MEASURED FLOOR.
  //
  // The known-failing register carried this file as "cannot run ALONE under
  // wave load; zero tests executed", filed as starvation. PROFILED, it is
  // AGENTS.md's OTHER cause: this hook's first `await import` pulls
  // `SessionManager.ts`'s whole module graph, and the five imports after it are
  // then free.
  //
  // Measured outside the runner (`bun -e`, so no lock and no test contention),
  // both readings with their load quoted beside them as the timing rule asks:
  // **161.9 s at load 7.78 on a cold transpile cache**, and **16.2 s at load
  // 10.53 warm** — the second run's `SessionManager.ts` import alone accounts
  // for the whole 16.2 s, with `platform-headless.ts` after it costing 0.1 ms.
  // Both are far past bun's 5 s default, so the file was never green solo; a
  // BATCH pays the import once in some other file and this hook then costs
  // nothing, which is exactly why it passed there and looked like contention.
  //
  // The budget is set above the COLD reading, because a cold cache is the
  // ordinary state of a fresh checkout or a CI runner. It is not zero and it is
  // not "large enough to never fire": a hang here still fails, ten minutes
  // later, instead of being reported as an import that got slower.
  //
  // P6.870, 2026-09-10 — the hand-written 240_000 that carried those readings
  // became `MODULE_GRAPH_HOOK_BUDGET_MS` (600 000). The measurements above are
  // unchanged and still the reason this hook is budgeted at all; what changed is
  // that the number is now the family's one site rather than a fourth bare
  // literal nothing could re-derive. 600 000 is still above the 161.9 s cold
  // reading, which is the condition this paragraph sets.
  //
  // The runner's own message is a MISNOMER worth knowing before reading a
  // failure here: bun prints "a beforeEach/afterEach hook timed out" for the
  // `beforeAll` family too, and reports ZERO tests executed with exit 1 — so
  // read the executed-test COUNT, never the message's hook kind.
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  restoreConfig()
  rmSync(stateRoot, { recursive: true, force: true })
})

let sessionCounter = 0

interface HarnessOptions {
  /** Slug the session starts on. */
  from?: string
  isProcessing?: boolean
  model?: string
  thinkingLevel?: ThinkingLevel
  permissionMode?: PermissionMode
  /** Written into `sdkSessionAnchors` for the STARTING provider's key. */
  anchor?: { provider: 'pi' | 'anthropic'; id: string }
  /** Written into the legacy single-slot `sdkSessionId`. */
  legacyAnchor?: string
  disabledPermissionModes?: PermissionMode[]
  /**
   * Blocks the agent's automation-event drain — the first `await` the switch
   * reaches while holding the mutation boundary — until the harness's
   * `releaseDrain()` is called. Implies the agent stub.
   */
  holdDrain?: boolean
  /**
   * Keep the REAL T4 hostability precondition instead of the harness's stub.
   * The real check consults the feature flags, the on-disk runtime binaries
   * and the credential store — three inputs that vary by machine (the codex
   * binary is gitignored, the isolated credential store is empty), which is
   * why every other row stubs it. The refusal row sets this and also needs
   * `setSessionPlatform` for `buildBackendHostRuntimeContext`.
   */
  realHostability?: boolean
}

function createSwitchHarness(options: HarnessOptions = {}) {
  const manager = createTestSessionManagerFn(
    options.disabledPermissionModes
      ? { managedPiPolicy: { ...defaultManagedPiPolicy, disabledPermissionModes: options.disabledPermissionModes } }
      : {},
  )
  const workspace = {
    id: WORKSPACE_ID,
    name: 'Runtime Switch Workspace',
    slug: 'runtime-switch-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const id = `session-switch-${++sessionCounter}`
  const managed = createManagedSessionFn(
    {
      id,
      name: id,
      llmConnection: options.from ?? 'pi-source',
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  ) as unknown as ManagedForTest
  if (options.anchor) {
    managed.sdkSessionAnchors = writeRuntimeAnchorFn(undefined, options.anchor.provider, options.anchor.id)
  }
  if (options.legacyAnchor) managed.sdkSessionId = options.legacyAnchor
  // Same shape as `refresh-connection-runtime.test.ts`'s stub: the strict drain
  // calls every one of these and FAILS the switch if one is missing, which is
  // the behaviour under test.
  let releaseDrain: () => void = () => {}
  const drainGate = options.holdDrain
    ? new Promise<void>(resolve => { releaseDrain = resolve })
    : undefined
  managed.agent = options.isProcessing === undefined && !options.holdDrain
    ? null
    : {
        isProcessing: () => options.isProcessing === true,
        setAutomationSystem: () => {},
        setCapabilityTurnRuntime: () => {},
        setPermissionMode: () => {},
        drainAutomationEvents: async () => { if (drainGate) await drainGate },
        endLifecycle: async () => {},
        captureLifecycleState: () => undefined,
        forceAbort: () => {},
        dispose: () => {},
      }
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${id}`, managed)
  // T4's hostability precondition is stubbed out the same way rows stub
  // `strictDrainSessionForMutation`: its verdict depends on this machine
  // (binaries, credential store), its decision logic is unit-tested in
  // `../runtime-switch.test.ts`, and what THIS suite owns is the seam's
  // position. The refusal row opts back into the real method.
  if (!options.realHostability) {
    ;(manager as unknown as Record<string, unknown>).assertSwitchTargetHostable = async () => {}
  }
  return { manager: manager as ManagerInstance, managed, workspace, releaseDrain }
}

/**
 * One active goal record, in the shape `GoalService` persists. Module-level
 * because P2.2 needs it in two describes: the switch-survival row and the
 * continuation-gate rows further down.
 */
function activeGoalStateFixture() {
  return {
    schemaVersion: 1,
    goal: {
      schemaVersion: 1,
      id: 'goal-1',
      revision: 1,
      source: 'user',
      creator: 'owner',
      condition: 'ship the retry',
      status: 'active',
      budgets: { turnLimit: 32, tokenLimit: 250_000, costLimitUsd: 20, elapsedLimitMs: 7_200_000 },
      accounting: { turns: 0, tokens: 0, costUsd: 0, elapsedMs: 0, startedAt: Date.now(), lastResumedAt: Date.now(), resumeCount: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  }
}

function boundaryHeld(manager: ManagerInstance, managed: ManagedForTest): boolean {
  return (manager as unknown as { projectMutationSessions: Set<string> })
    .projectMutationSessions.has(`${managed.workspace.id}:${managed.id}`)
}

describe('switchSessionRuntime refusals', () => {
  it('refuses while a turn is running', async () => {
    const { manager, managed } = createSwitchHarness({ isProcessing: true })
    await expect(manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id))
      .rejects.toThrow(/running a turn/)
  })

  it('refuses an unknown connection', async () => {
    const { manager, managed } = createSwitchHarness()
    await expect(manager.switchSessionRuntime(managed.id, 'does-not-exist', managed.workspace.id))
      .rejects.toThrow(/not found/)
  })

  // Negative subject for the refusal above: an IDLE session on the very same
  // harness must go through, or "refuses while a turn is running" would pass on
  // a method that refuses everything.
  it('does not refuse an idle session', async () => {
    const { manager, managed } = createSwitchHarness({ isProcessing: false })
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-cross-runtime')
  })

  it('refuses a session whose boundary another mutation already holds', async () => {
    const { manager, managed } = createSwitchHarness()
    ;(manager as unknown as { projectMutationSessions: Set<string> })
      .projectMutationSessions.add(`${managed.workspace.id}:${managed.id}`)
    await expect(manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id))
      .rejects.toThrow(/another session mutation/)
  })

  // T4's load-bearing row: the refusal must land BEFORE the irreversible
  // teardown, and the only way to prove the position is to run the REAL check
  // (`realHostability`) and watch nothing get torn down. A correct
  // `canHostSession` wired AFTER `exitWorktreeBeforeRuntimeSwitch` and the
  // strict drain would pass the four unit cases and every other row here — the
  // switch would still be refused, on a session already stripped of its
  // worktree, agent and runtime state. The target is `codex-gateway` in the
  // isolated store: its credential is never written, so the real check refuses
  // on every machine (`credentials-missing` where the gitignored codex binary
  // exists, `runtime-binary-missing` where it does not — one wire code either
  // way).
  //
  // The credential arm fails OPEN on an UNBOUND credential singleton (an
  // unbound store means "not asked", never "refused" — see `canHostSession`),
  // so this row must bind it or it silently stops testing a refusal on any
  // machine that has the codex binary: measured 2026-08-20, it reported
  // `undefined` instead of `RUNTIME_UNHOSTABLE` on exactly that path. Binding
  // is process-global and every other row here stubs the check, so this
  // affects nothing else.
  it('refuses a target that cannot start, before any teardown', async () => {
    try {
      initializeCredentialManagerV2({ storageLayoutVersion: 2, verificationId: 'test-runtime-switch-session' })
    } catch {
      // Already bound by another suite in this process — a manager exists either way.
    }
    setSessionPlatformFn(createHeadlessPlatformFn())
    const { manager, managed } = createSwitchHarness({ isProcessing: false, realHostability: true })

    // A held worktree lease, the cwd inside it, and recorders on every
    // teardown surface the refusal must never reach.
    const leasePath = '/tmp/nessy-worktrees/project/worktree-t4'
    const lease = { worktreeLeaseId: 'worktree-t4', path: leasePath, branch: 'nessy/session/worktree-t4', baseSha: 'abc' }
    const leaseService = { setEmit: () => {}, list: () => [lease], touch: async () => {} }
    ;(manager as unknown as { piWorktreeLeaseServices: Map<string, unknown> })
      .piWorktreeLeaseServices.set(`${managed.workspace.id}:${managed.id}`, leaseService)
    managed.sdkCwd = workspaceRoot
    managed.workingDirectory = leasePath
    managed.messages = [{ id: 'm1', role: 'user', content: 'hello' }] as never
    const cwdMoves: string[] = []
    ;(manager as unknown as Record<string, unknown>).mutateWorkingDirectory = async (
      m: ManagedForTest, input: { path: string },
    ) => {
      cwdMoves.push(input.path)
      m.workingDirectory = input.path
    }
    let drained = false
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async () => { drained = true }
    let disposed = false
    ;(managed.agent as { dispose: () => void }).dispose = () => { disposed = true }

    const error = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
      .then(() => undefined, (e: unknown) => e as { code?: string })

    expect(error?.code).toBe('RUNTIME_UNHOSTABLE')
    // The session is intact: the lease is still installed and untouched, the
    // cwd never moved, the drain never ran, the agent lives, the connection
    // and runtime-scoped state are unchanged, and no `contextCarried` was ever
    // computed — no handoff armed, no notice appended.
    expect((manager as unknown as { piWorktreeLeaseServices: Map<string, unknown> })
      .piWorktreeLeaseServices.get(`${managed.workspace.id}:${managed.id}`)).toBe(leaseService)
    expect(cwdMoves).toEqual([])
    expect(managed.workingDirectory).toBe(leasePath)
    expect(drained).toBe(false)
    expect(disposed).toBe(false)
    expect(managed.agent).not.toBeNull()
    expect(managed.llmConnection).toBe('pi-source')
    expect(managed.model).toBeUndefined()
    expect(managed.runtimeHandoffFrom).toBeUndefined()
    expect(managed.messages).toHaveLength(1)
    // Refused before the boundary acquire and the quit-path registration.
    expect(boundaryHeld(manager, managed)).toBe(false)
    expect((manager as unknown as { runtimeSwitchesInFlight: Map<string, unknown> })
      .runtimeSwitchesInFlight.size).toBe(0)
  })
})

describe('switchSessionRuntime holds the session mutation boundary', () => {
  // A3. The boundary must be HELD across the teardown, not merely read before
  // it. `strictDrainSessionForMutation`'s third argument is `boundaryHeld`, so
  // passing `true` without owning the boundary is a lie the type system cannot
  // catch. This records what the drain actually sees.
  it('owns the boundary when the drain runs, and passes boundaryHeld', async () => {
    const { manager, managed } = createSwitchHarness()
    let heldAtDrain: boolean | undefined
    let heldFlag: unknown
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async (
      m: ManagedForTest, _reason: string, held: unknown,
    ) => {
      heldAtDrain = boundaryHeld(manager, m)
      heldFlag = held
    }

    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(heldAtDrain).toBe(true)
    expect(heldFlag).toBe(true)
    // …and released afterwards, or the session is bricked for every later
    // mutation (rewind, cwd change, delete, quit).
    expect(boundaryHeld(manager, managed)).toBe(false)
  })

  it('releases the boundary even when the switch throws', async () => {
    const { manager, managed } = createSwitchHarness()
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async () => {
      throw new Error('drain exploded')
    }

    await expect(manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id))
      .rejects.toThrow(/drain exploded/)
    expect(boundaryHeld(manager, managed)).toBe(false)
  })
})

describe('switchSessionRuntime effects', () => {
  it('same-runtime switch keeps the runtime anchor and reports it', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'claude-max',
      anchor: { provider: 'anthropic', id: 'claude-1' },
    })
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-same-runtime')
    expect(result.contextCarried).toBe('runtime-anchor')
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')).toBe('claude-1')
  })

  it('reports no carried context when the target runtime has no anchor', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'claude-max' })
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-same-runtime')
    expect(result.contextCarried).toBe('none')
  })

  it('cross-runtime switch reports a handoff and clears Pi-scoped state', async () => {
    const { manager, managed } = createSwitchHarness({
      anchor: { provider: 'pi', id: 'pi-1' },
    })
    // T4: `handoff` is now reported only when there is a transcript to hand
    // over — an empty session reports `none`. The transcript is what makes this
    // a handoff case, so the fixture has to carry one.
    managed.messages = [{ id: 'm1', role: 'user', content: 'add a retry' }] as never
    managed.piContinuationEnvelope = { schemaVersion: 1 } as never
    managed.deferredToolCall = { schemaVersion: 1 } as never
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-cross-runtime')
    expect(result.contextCarried).toBe('handoff')
    expect(managed.piContinuationEnvelope).toBeUndefined()
    expect(managed.deferredToolCall).toBeUndefined()
  })

  /**
   * P2.2 — the storage-audit amendment, and the INVERSION of what the row above
   * used to assert about `goalState`.
   *
   * The goal was cleared here because it was Pi's: its port was bound on the Pi
   * path and no other runtime could read, report or terminate it, so carrying it
   * across would have left a session holding an objective nothing could act on.
   * P2.2 made the goal host-side on all three coding runtimes, so the premise is
   * gone and the clearing became the defect — a user who moves a session from Pi
   * to Claude mid-goal loses the objective, silently.
   *
   * Both halves are asserted, because dropping the clear is only correct if the
   * state that is genuinely runtime-scoped still goes: the persisted goal
   * SURVIVES, and the live `GoalService` INSTANCE — which closes over the
   * runtime being torn down — does not. The far side re-hydrates a NEW service
   * from the surviving record at the switch's own arming point, which is the
   * same shape T1/T8 (d) gave the cron store, so the detector is instance
   * identity rather than the map entry's presence.
   */
  it('carries an active goal across a cross-runtime switch and rebuilds the goal service', async () => {
    const { manager, managed } = createSwitchHarness({
      anchor: { provider: 'pi', id: 'pi-1' },
    })
    managed.messages = [{ id: 'm1', role: 'user', content: 'add a retry' }] as never
    managed.goalState = activeGoalStateFixture() as never
    // The switch's arming point re-arms the continuation, whose asynchronous
    // half really sends — which on a gateway target means building an agent and
    // spawning a subprocess that outlives this row. What this row measures is
    // the record and the service, so the send is stubbed inert.
    ;(manager as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {}
    const services = (manager as unknown as { piGoalServices: Map<string, unknown> }).piGoalServices
    // A LIVE service, built the way every reader builds it, so "a different
    // instance" measures the teardown rather than a map that was always empty.
    const before = (manager as unknown as { getOrCreatePiGoalService: (m: unknown) => unknown })
      .getOrCreatePiGoalService(managed)
    const key = `${managed.workspace.id}:${managed.id}`
    expect(services.get(key)).toBe(before)

    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect((managed.goalState as { goal?: { id?: string; status?: string } } | undefined)?.goal)
      .toMatchObject({ id: 'goal-1', status: 'active' })
    // Re-hydrated on the far side rather than carried: a fresh instance, holding
    // the record that survived.
    const after = services.get(key) as { snapshot(): { goal?: { id: string; status: string } } } | undefined
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
    expect(after!.snapshot().goal).toMatchObject({ id: 'goal-1', status: 'active' })
    // Positive control for the survival above: the neighbouring fields that ARE
    // runtime-scoped still go, so this is not a teardown that stopped running.
    expect(managed.piContinuationEnvelope).toBeUndefined()
    expect(managed.childSessionState).toBeUndefined()
  })

  /**
   * The arming point's OTHER half: the continuation is re-armed at the switch,
   * not deferred to the next turn — a user who switches mid-goal and walks away
   * is the case the goal exists for (the deferral T6 measured for the
   * scheduler).
   *
   * The detector is `piGoalContinuationRunning`, which only
   * `schedulePiGoalContinuation` sets, and it is a POSITION test as much as a
   * behaviour one: that gate refuses any session holding the mutation boundary,
   * which `switchSessionRuntime` holds for its whole body — so an arming call
   * made inside the switch would leave this flag untouched and pass for nothing.
   */
  it('re-arms the goal continuation once the switch releases the session boundary', async () => {
    const { manager, managed } = createSwitchHarness({ anchor: { provider: 'pi', id: 'pi-1' } })
    managed.messages = [{ id: 'm1', role: 'user', content: 'add a retry' }] as never
    managed.goalState = activeGoalStateFixture() as never
    ;(manager as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {}

    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(managed.piGoalContinuationRunning).toBe(true)
    // …and the boundary really is free by then, which is what makes the arming
    // above reachable rather than incidental.
    expect(boundaryHeld(manager, managed)).toBe(false)
  })

  /**
   * The other side of the arming point: a session with NO goal must not have a
   * service minted for it by the switch. `getOrCreatePiGoalService` builds one
   * unconditionally, so an unguarded call would leave every switched session
   * holding an empty service and re-arming a continuation against it.
   */
  it('mints no goal service on a switch when the session has no goal', async () => {
    const { manager, managed } = createSwitchHarness({ anchor: { provider: 'pi', id: 'pi-1' } })
    managed.messages = [{ id: 'm1', role: 'user', content: 'add a retry' }] as never

    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(managed.goalState).toBeUndefined()
    expect((manager as unknown as { piGoalServices: Map<string, unknown> }).piGoalServices
      .has(`${managed.workspace.id}:${managed.id}`)).toBe(false)
    expect(managed.piGoalContinuationRunning).toBeUndefined()
  })

  // T18. A RETURN leg is the case where both mechanisms fire: the target
  // resumes its own conversation from the anchor that `clearRuntimeScopedSessionState`
  // deliberately kept, AND — before the fix — was handed the whole transcript
  // again as text. Measured live on packaged 1.26.1 (RTS-3): Pi appended to the
  // sidecar it wrote before leaving while both of its pre-switch replies came
  // back inside `<runtime_handoff_context>`.
  it('reports anchor-and-handoff when the target has been here before', async () => {
    const { manager, managed } = createSwitchHarness({
      anchor: { provider: 'anthropic', id: 'claude-1' },
    })
    managed.messages = [
      { id: 'm1', role: 'user', content: 'first' },
      { id: 'm2', role: 'assistant', content: 'answered on claude', runtime: 'anthropic' },
    ] as never
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-cross-runtime')
    // Both: the anchor resumes the conversation, the text carries what it missed.
    expect(result.contextCarried).toBe('anchor-and-handoff')
  })

  // The negative subject: a target that has never run this session still gets
  // the whole transcript. Without this row the fix above could over-trim and
  // every fresh cross-runtime switch would arrive with no history at all —
  // which is the failure the trim exists to avoid causing.
  it('still reports a plain handoff when the target has never been here', async () => {
    const { manager, managed } = createSwitchHarness({
      anchor: { provider: 'pi', id: 'pi-1' },
    })
    managed.messages = [
      { id: 'm1', role: 'user', content: 'first' },
      { id: 'm2', role: 'assistant', content: 'answered on pi', runtime: 'pi' },
    ] as never
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.contextCarried).toBe('handoff')
  })

  // The legacy single anchor slot is adopted by `migrateLegacyAnchor` for
  // whichever provider comes next, so a Pi id left there becomes Claude's
  // resume target on the very first switch. It must move into the outgoing
  // provider's own key and leave the slot empty.
  it('does not let the legacy anchor slot poison the incoming runtime', async () => {
    const { manager, managed } = createSwitchHarness({ legacyAnchor: 'pi-legacy-1' })
    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(managed.sdkSessionId).toBeUndefined()
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')).toBeUndefined()
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'pi')).toBe('pi-legacy-1')
  })

  // T3's NEGATIVE CONTROL — do not amend it. `pi-source` and `codex-gateway`
  // carry disjoint catalogs, so the carried id is genuinely unservable by the
  // target and the reset is the correct outcome. A carry implemented without a
  // catalogue check would still pass every row in the block below; only this
  // one fails it.
  it('cross-runtime switch resets the model to the target default', async () => {
    const { manager, managed } = createSwitchHarness({ model: 'tgpt/qwen35-397b-a17b-fp8' })
    const result = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    expect(result.model).not.toBe('tgpt/qwen35-397b-a17b-fp8')
    expect(result.model).toBe('gpt-5.3-codex')
    expect(managed.model).toBe('gpt-5.3-codex')
  })

  it('clamps a thinking level the target runtime does not offer', async () => {
    const { manager, managed } = createSwitchHarness({ thinkingLevel: 'max' })
    await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    expect(managed.thinkingLevel).toBe('high')
  })

  // Negative subject for the clamp: Pi→Claude keeps 'max', because the target
  // offers it. A clamp that fires unconditionally would pass the test above.
  it('leaves a thinking level the target does offer alone', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'claude-max', thinkingLevel: 'max' })
    await manager.switchSessionRuntime(managed.id, 'claude-max', managed.workspace.id)
    expect(managed.thinkingLevel).toBe('max')
  })

  // A1. The permission mode must travel through `setSessionPermissionMode`, not
  // by assignment: enforcement reads the mode-manager singleton, not
  // `managed.permissionMode`. The diagnostics read below is the authority the
  // agent consults — a bare field assignment leaves it on the OLD mode while
  // the record and the UI claim the new one.
  //
  // P6.714 closed the third door: `manager.setSessionPermissionMode` now clamps
  // a disabled mode on every runtime, so this case can no longer park the
  // session in `bypassPermissions` through the manager. The runtime state a
  // switch can still meet is the PRE-POLICY one — a mode-manager entry written
  // before the administrator set the key — so it is seeded at the singleton
  // directly, the one path with no door.
  it('routes a clamped permission mode through the mode manager, not the record', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'codex-gateway',
      permissionMode: 'bypassPermissions',
      disabledPermissionModes: ['bypassPermissions'],
    })
    const key = { workspaceId: managed.workspace.id, sessionId: managed.id }
    setPermissionModeFn(key, 'bypassPermissions')
    const seeded = getPermissionModeDiagnosticsFn(key).permissionMode
    expect(seeded).toBe('bypassPermissions')

    await manager.switchSessionRuntime(managed.id, 'pi-source', managed.workspace.id)

    // The graded chain, not a fixed `'default'`: bypass → auto.
    expect(managed.permissionMode).toBe('auto')
    expect(getPermissionModeDiagnosticsFn({ workspaceId: managed.workspace.id, sessionId: managed.id }).permissionMode)
      .toBe('auto')
  })

  it('clears the context meter AND the window it was divided by', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.contextUsage = { inputTokens: 120_000, contextWindow: 200_000, percent: 60 } as never
    managed.tokenUsage = {
      inputTokens: 120_000, outputTokens: 10, totalTokens: 120_010, contextTokens: 120_000, costUsd: 0,
      contextWindow: 200_000,
      contextUsage: { inputTokens: 120_000, contextWindow: 200_000, percent: 60 },
    } as never
    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(managed.contextUsage).toBeUndefined()
    expect((managed.tokenUsage as { contextUsage?: unknown }).contextUsage).toBeUndefined()
    expect((managed.tokenUsage as { contextWindow?: unknown }).contextWindow).toBeUndefined()
  })

  it('keeps the transcript and the queued messages', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = [{ id: 'm1', role: 'user', content: 'hello' }] as never
    managed.messageQueue = [{ message: 'queued' }] as never
    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    // The original row survives untouched; T4 APPENDS the switch notice after
    // it. What this test guards is that nothing is dropped or rewritten.
    const messages = managed.messages as Array<{ id: string; content: string }>
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: 'm1', content: 'hello' })
    expect(managed.messageQueue).toHaveLength(1)
  })

  it('takes the connection and drops the Pi stickiness latch', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.activeProvider = 'pi'
    await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    expect(managed.llmConnection).toBe('codex-gateway')
    expect(managed.activeProvider).toBeUndefined()
    expect(managed.connectionLocked).toBe(true)
    expect(managed.backendRuntimeSignature).toBeUndefined()
    expect(managed.backendRestartSignature).toBeUndefined()
  })

  // The refusal this method replaces: `setSessionConnection` threw
  // "Cannot change connection after session has started" on any session with a
  // transcript. It now delegates, so the same call succeeds.
  it('setSessionConnection delegates instead of refusing a started session', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = [{ id: 'm1', role: 'user', content: 'hello' }] as never
    await manager.setSessionConnection(managed.id, 'codex-gateway', managed.workspace.id)
    expect(managed.llmConnection).toBe('codex-gateway')
  })
})

describe('cross-runtime handoff', () => {
  it("arms the handoff with the session's own transcript", async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = [
      { id: 'm1', role: 'user', content: 'add a retry' },
      { id: 'm2', role: 'assistant', content: 'done' },
    ] as never
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.contextCarried).toBe('handoff')
    expect(managed.runtimeHandoffFrom).toBe('pi')
    expect(managed.runtimeHandoffApplied).toBe(false)
  })

  // Negative subject for both the arming and the notice: neither may fire on a
  // session with nothing to hand over. Without this, code that armed
  // unconditionally would pass every other assertion here.
  it('does not arm a handoff, or write a notice, for a session with no transcript', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = [] as never
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.contextCarried).toBe('none')
    expect(managed.runtimeHandoffFrom).toBeUndefined()
    expect(managed.messages).toHaveLength(0)
  })

  // Negative subject for the RUNTIME half: a same-runtime connection change is
  // not a handoff, so it must arm nothing even though it has a transcript.
  it('does not arm a handoff for a same-runtime connection change', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'claude-max' })
    managed.messages = [{ id: 'm1', role: 'user', content: 'hello' }] as never
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-same-runtime')
    expect(managed.runtimeHandoffFrom).toBeUndefined()
    expect(managed.messages).toHaveLength(1)
  })

  // `managed.messages` is lazy. A session the user has not opened in this
  // process reads `[]` in memory while its JSONL holds the whole conversation,
  // so the switch must load it before deciding whether a handoff is owed —
  // otherwise the feature is inert on exactly the sessions that need it while
  // every other test here stays green (the harness builds `messagesLoaded:
  // true` sessions). Remove the `ensureMessagesLoaded` await in
  // `switchSessionRuntime` and this is the only test that goes red.
  it('loads a cold transcript before deciding whether a handoff is owed', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messagesLoaded = false
    managed.messages = [] as never
    ;(manager as unknown as Record<string, unknown>).ensureMessagesLoaded = async (m: ManagedForTest) => {
      m.messages = [{ id: 'm1', role: 'user', content: 'from disk' }]
      m.messagesLoaded = true
    }

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(result.contextCarried).toBe('handoff')
    expect(managed.runtimeHandoffFrom).toBe('pi')
  })

  it('writes a switch notice into the transcript', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = [{ id: 'm1', role: 'user', content: 'hi' }] as never
    await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    const last = (managed.messages as Array<{ role: string; content: string }>).at(-1)
    // R1 · the marker carries WHAT CROSSED as a JSON tail, appended after the
    // two segments so `[from, to]` stay exactly where every existing reader
    // (ours, and iOS's raw render) expects them. `codex-gateway` plans `native`
    // — the one tier a Codex target reaches since T1a flipped the capability
    // map — so this row is the positive arm of the tail's value.
    expect(last?.content).toBe('runtime_switched:pi:codex-runtime:{"carry":"native"}')
    // `MessageRole` has no `'system'` member, so the marker rides an `info` row
    // (plan decision D1) and the renderer translates it.
    expect(last?.role).toBe('info')
  })

  // The seam the backend actually reads. `getRuntimeHandoffMessages` is a thin
  // closure over `buildRuntimeHandoffPayload` since T1a, so this CALLS the
  // shipped projection against the same managed session rather than restating
  // it: armed → the transcript; applied → null. (It used to restate it, which
  // is why the anchor-vs-provenance divergence T1a fixed went unseen —
  // `runtime-handoff-payload.test.ts` now owns that case.)
  it('hands the transcript over exactly once', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = [
      { id: 'm1', role: 'user', content: 'add a retry' },
      { id: 'm2', role: 'assistant', content: 'done', isIntermediate: true },
    ] as never
    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    const readHandoff = () => buildRuntimeHandoffPayload({
      rows: managed.messages as never,
      from: managed.runtimeHandoffFrom as AgentProvider | undefined,
      applied: managed.runtimeHandoffApplied as boolean | undefined,
      target: 'anthropic',
      targetHasAnchor: false,
      plan: managed.runtimeHandoffPlan as HistoryCarryPlan | undefined,
    })

    const first = readHandoff()
    expect(first?.from).toBe('pi')
    // The streaming-scaffolding row is excluded, the real turn is not.
    expect(first?.messages).toEqual([{ type: 'user', content: 'add a retry' }])

    managed.runtimeHandoffApplied = true
    managed.runtimeHandoffFrom = undefined
    expect(readHandoff()).toBeNull()
  })

  /**
   * T1b · THE ARMING LEG of the plan's DONE criterion.
   *
   * *"a Pi session with real tool traffic, switched to `codex-gateway`, can
   * answer a question whose only source is a tool result."* The projection and
   * the Responses mapping are proven in `runtime-handoff-payload.test.ts`; what
   * only THIS suite can prove is that a real `switchSessionRuntime` onto a real
   * Codex connection arms the state those two need — `from: 'pi'` and a
   * `native` plan — rather than the `text` tier the feature shipped with.
   *
   * Driven end to end from here: the switch runs, then the SHIPPED projection
   * reads the SAME managed session the backend closure reads
   * (`SessionManager.ts:14068`), and the fact that exists only inside a
   * `rawToolResult` is in its payload.
   */
  it('arms a native plan on a switch into Codex, and the tool result crosses', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = [
      { id: 'k1', role: 'user', content: 'what is in the deploy key file?' },
      { id: 'k2', role: 'assistant', content: 'let me read it', isIntermediate: true },
      {
        id: 'k3',
        role: 'tool',
        content: '',
        toolName: 'Read',
        toolStatus: 'completed',
        rawToolInput: { file_path: './deploy.key' },
        rawToolResult: 'DEPLOY_FINGERPRINT=opal-lantern-77',
      },
      { id: 'k4', role: 'assistant', content: 'I have read the file.' },
    ] as never

    const result = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-cross-runtime')
    // The plan the modal promised, persisted for the turn that will deliver it.
    expect(managed.runtimeHandoffPlan).toBe('native')
    expect(managed.runtimeHandoffFrom).toBe('pi')

    const payload = buildRuntimeHandoffPayload({
      rows: managed.messages as never,
      from: managed.runtimeHandoffFrom as AgentProvider | undefined,
      applied: managed.runtimeHandoffApplied as boolean | undefined,
      target: 'codex-runtime',
      targetHasAnchor: false,
      plan: managed.runtimeHandoffPlan as HistoryCarryPlan | undefined,
    })

    // The fact appears in NO prose row — the premise of the whole criterion.
    expect(payload?.messages.map(m => m.content).join(' ')).not.toContain('opal-lantern-77')
    // …and it crosses, as a closed tool pair, in the row projection.
    expect(payload?.history).toContainEqual({
      kind: 'tool',
      callId: 'nessy_handoff_k3',
      name: 'Read',
      input: { file_path: './deploy.key' },
      output: 'DEPLOY_FINGERPRINT=opal-lantern-77',
    })
  })
})

/**
 * T3. A switch KEEPS the model when the target can serve it.
 *
 * The whole point of the row: all three gateway cards are seeded from one
 * `NESSY_GATEWAY_MODELS` catalogue, so "the target can serve it" is the common
 * case and the unconditional `managed.model = target.defaultModel` was silently
 * returning a user who picked Qwen Fast to the coder default on every switch.
 *
 * The three guards below are NOT symmetry with that carry — each one exists
 * because feeding the carried id through `resolveModelForProvider` alone
 * produces something the old line never did, and in all three the old outcome
 * was the better one.
 */
describe('a switch keeps the model the target can serve', () => {
  // The subject. Pi → Claude Code, one shared catalogue, "Qwen Fast" picked.
  it('carries the picked model across a cross-runtime switch onto a shared catalogue', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'pi-shared',
      model: 'tgpt/qwen36-35b-a3b-fp8',
    })
    const result = await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)
    expect(result.kind).toBe('connection-cross-runtime')
    expect(managed.model).toBe('tgpt/qwen36-35b-a3b-fp8')
    expect(result.model).toBe('tgpt/qwen36-35b-a3b-fp8')
    // …and NOT the target's own default, which is the other id in the same
    // catalogue — the assertion that fails if the carry silently no-ops.
    expect(result.model).not.toBe('tgpt/qwen35-397b-a17b-fp8')
  })

  // Guard 1, the arm that costs a user their default. `anthropic-byo` lists no
  // models, so `resolveModelForProvider`'s catalogue filter — which lives
  // entirely inside `if (connection?.models?.length)` — never runs, and the
  // bare resolver would carry a `tgpt/…` gateway id onto a BYO Anthropic key
  // that has never heard of it.
  it('does not carry onto a target with no catalogue to check against', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'pi-shared',
      model: 'tgpt/qwen36-35b-a3b-fp8',
    })
    const result = await manager.switchSessionRuntime(managed.id, 'anthropic-byo', managed.workspace.id)
    expect(managed.model).toBe('claude-sonnet-4-6')
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(result.model).not.toBe('tgpt/qwen36-35b-a3b-fp8')
  })

  // Guard 1, the arm with nothing to fall back to. `claude-max` lists no models
  // AND declares no default, so the field going `undefined` is exactly today's
  // outcome — the guard must not substitute anything for it.
  it('leaves the model unset when a catalogue-less target declares no default', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'pi-shared',
      model: 'tgpt/qwen36-35b-a3b-fp8',
    })
    const result = await manager.switchSessionRuntime(managed.id, 'claude-max', managed.workspace.id)
    expect(managed.model).toBeUndefined()
    expect(result.model).toBe('')
  })

  // Guard 2 — ASSERTED, not guarded. `pi-stale-default`'s declared default is
  // off its own catalogue, and `resolveModelForProvider` substitutes
  // `connectionModelIds[0]` for it (pi only). That substitution is left to
  // stand: `resolveBackendContext` runs the same resolver at agent
  // construction, so it was ALREADY the model that ran — `managed.model` merely
  // disagreed with it. Refusing here would be a second refusal path, and a
  // switch is never refused over a model.
  it('lets the pi off-catalogue default substitution stand', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'codex-gateway',
      model: 'gpt-5.3-codex-mini',
    })
    const result = await manager.switchSessionRuntime(managed.id, 'pi-stale-default', managed.workspace.id)
    expect(result.model).toBe('tgpt/qwen35-397b-a17b-fp8')
    expect(managed.model).toBe('tgpt/qwen35-397b-a17b-fp8')
    // The stale record is NOT what the session lands on.
    expect(result.model).not.toBe('tgpt/retired-model')
  })

  // Guard 3 — CLAMPED. `codex-nodefault` declares no default, so the carried
  // gateway id is cleared by the catalogue filter and the resolver falls
  // through to `default: return managedModel || connectionDefault ||
  // DEFAULT_MODEL` — and `DEFAULT_MODEL` is an Opus id. A Codex session must
  // not come out of a switch holding a Claude model; today the field goes
  // `undefined`, and that is what it must keep doing.
  it('never invents the Opus fallback for a target that declares no default', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'pi-shared',
      model: 'tgpt/qwen36-35b-a3b-fp8',
    })
    const result = await manager.switchSessionRuntime(managed.id, 'codex-nodefault', managed.workspace.id)
    expect(managed.model).toBeUndefined()
    expect(result.model).toBe('')
    expect(result.model).not.toContain('opus')
  })

  // Guard 3's positive control: the clamp is scoped to a model NOBODY chose. A
  // genuine carry onto the same default-less target still crosses, so the clamp
  // cannot be passing by blanking the field unconditionally.
  it('still carries onto a default-less target when the target lists the model', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'pi-shared',
      model: 'gpt-5.3-codex-mini',
    })
    const result = await manager.switchSessionRuntime(managed.id, 'codex-nodefault', managed.workspace.id)
    expect(managed.model).toBe('gpt-5.3-codex-mini')
    expect(result.model).toBe('gpt-5.3-codex-mini')
  })

  // `2026-07-29-inert-worklist.md` §3.2 — the owner decision this row sits next
  // to: model filtering happens at the READ boundary and NOT at the persistence
  // boundary, because a round-trip through `updateLlmConnection` "would
  // permanently destroy a user's model list". T3 persists `managed.model` and
  // nothing else. Asserted on the switch that exercises every arm of the
  // resolver — the substitution one — and on both connections, since a switch
  // reads two.
  it('leaves both connections byte-identical — it persists the session, never the catalogue', async () => {
    const before = {
      source: JSON.stringify(getLlmConnectionFn('codex-gateway')),
      target: JSON.stringify(getLlmConnectionFn('pi-stale-default')),
    }
    const { manager, managed } = createSwitchHarness({
      from: 'codex-gateway',
      model: 'gpt-5.3-codex-mini',
    })
    await manager.switchSessionRuntime(managed.id, 'pi-stale-default', managed.workspace.id)
    expect(JSON.stringify(getLlmConnectionFn('codex-gateway'))).toBe(before.source)
    expect(JSON.stringify(getLlmConnectionFn('pi-stale-default'))).toBe(before.target)
  })
})

/**
 * T3 · `previousModel`, and the toast it drives.
 *
 * Carrying the model makes a switch quieter; without this the quiet becomes
 * opaque — a session lands on a different model and nothing on screen says so.
 * `ChatPage` raises `chat.runtimeSwitch.modelReset` when the two differ, so the
 * payload is the contract: equal means the renderer says nothing, different
 * means it names both ends.
 */
describe('the switch reports the model the session came from', () => {
  it('reports a previousModel equal to the landed model when the carry succeeds — no toast', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'pi-shared',
      model: 'tgpt/qwen36-35b-a3b-fp8',
    })
    const result = await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)
    expect(result.previousModel).toBe('tgpt/qwen36-35b-a3b-fp8')
    expect(result.previousModel).toBe(result.model)
  })

  it('names both ends when the target cannot serve the picked model — toast', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'claude-max',
      model: 'claude-opus-4-8',
    })
    const result = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    expect(result.previousModel).toBe('claude-opus-4-8')
    expect(result.model).toBe('gpt-5.3-codex')
    expect(result.previousModel).not.toBe(result.model)
  })

  it('omits previousModel entirely for a session that was on no model', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared' })
    const result = await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)
    expect(result.previousModel).toBeUndefined()
  })
})

/**
 * T12. The confirmation dialog runs BEFORE the switch and is computed in the
 * renderer from the two connection records, so anything the server only learns
 * while switching has to come back on the result instead.
 *
 * P3.152 · what `attachments.images === 'no'` means changed under this test, and
 * the resolution is that the WARNING IS KEPT AND ITS KEY IS NARROWED, not that
 * the warning is withdrawn.
 *
 * `ebbfca53d` stopped defaulting an undeclared model to "no images" — the owner
 * ruling of 2026-08-28, *carry the modality faithfully and let the endpoint
 * refuse*: the host is a faithful translator, not a capability oracle. After it,
 * `modelSupportsImages` reaches `false` only where somebody DECLARED it — a
 * per-model `supportsImages`, a connection-level `customEndpoint.supportsImages`,
 * or the `pi_compat` default that is lockstep with a value we author downstream
 * — and never from a guess about a model nobody described.
 *
 * So the gate in `SessionManager` is already keyed on something known and needs
 * no change: it fires where a declaration exists to honour and is silent where
 * the endpoint is the one that answers. What was stale was THIS FIXTURE, whose
 * `claude-gateway` models carried no declaration and were therefore text-only
 * only by way of the guess that was deleted. The shipped card declares it; the
 * fixture now does too, and the row below pins the other half of the ruling.
 */
describe('the switch reports what the target cannot read', () => {
  const withImages = () => ([
    {
      id: 'm1',
      role: 'user',
      content: 'look at this',
      attachments: [
        { type: 'image', path: '/tmp/shot.png', name: 'shot.png', mimeType: 'image/png', size: 1 },
        { type: 'text', path: '/tmp/note.txt', name: 'note.txt', mimeType: 'text/plain', size: 1 },
      ],
    },
    {
      id: 'm2',
      role: 'user',
      content: 'and again',
      attachments: [
        { type: 'image', path: '/tmp/shot.png', name: 'shot.png', mimeType: 'image/png', size: 1 },
      ],
    },
  ] as never)

  it('names the transcript images a target that DECLARED text-only will never receive', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = withImages()

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    // Deduplicated: the same screenshot on two turns is one thing lost.
    expect(result.droppedAttachments).toEqual(['shot.png'])
  })

  // The other half of the ruling, and the half that has no other pin: an
  // UNDECLARED model is not warned about, because nothing of ours knows. The
  // images travel, and the endpoint answers for itself with its own named 400
  // if it cannot take them. Before `ebbfca53d` this same switch reported
  // `['shot.png']` — a prediction dressed as a measurement, on a model that may
  // very well accept the image.
  //
  // `claude-shared` is the same provider type as `claude-gateway` above, with
  // the same transcript and the same cross-runtime hop; the ONLY difference is
  // that its catalogue entries declare nothing. So this row and that one
  // together say the field keys on the declaration and on nothing else.
  it('says nothing about images when nobody declared whether the target takes them', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = withImages()

    const result = await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)

    expect(result.kind).toBe('connection-cross-runtime')
    expect(result.droppedAttachments).toBeUndefined()
  })

  // The negative subject. `codex-gateway` is a cross-runtime switch from the
  // same harness with the same transcript, and its capability resolves
  // `images: 'yes'` — so a field filled for every switch, or for every
  // cross-runtime switch, fails here while the test above still passes.
  it('stays silent when the target does take images', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = withImages()

    const result = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)

    expect(result.kind).toBe('connection-cross-runtime')
    expect(result.droppedAttachments).toBeUndefined()
  })

  it('stays silent when a declared text-only target has no images to lose', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messages = [{ id: 'm1', role: 'user', content: 'hi' }] as never

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(result.droppedAttachments).toBeUndefined()
  })
})

/**
 * T7. Two of the three loops the task names were already closed by T3's
 * `clearRuntimeScopedSessionState` (it deletes the goal service, `stop()`s and
 * deletes the cron service and calls `sessionMonitors.stopAll`), so the task's
 * original three tests measure T3. What is left is the two provider GATES: the
 * goal continuation's choke point, which is reachable without a switch at all,
 * and the scheduling monitor producers, whose shared sink must stay open for
 * every runtime.
 *
 * P2.2 INVERTED the goal gate's rows, the way T1 inverted the delivery row
 * below, and for the same shape of reason: the gate was
 * `resolveManagedProvider(managed) === 'pi'` because the goal's port, budgets
 * and continuation were bound on the Pi path, and it is now
 * `SCHEDULED_DELIVERY_RUNTIMES.includes(…)` because they are bound for all
 * three coding runtimes. The runtime OUTSIDE the set still does not re-arm —
 * that control lives in `scheduled-delivery-runtimes.test.ts`, which owns a
 * `nestor-cloud-agent` connection this suite does not.
 */
describe('schedulers do not outlive a runtime that cannot run them', () => {
  const activeGoalState = activeGoalStateFixture

  /**
   * Arm the continuation with its DISPATCH stubbed out.
   *
   * These rows measure the provider gate, which is the synchronous half. The
   * asynchronous half really does send — and on a gateway runtime that means
   * building an agent and spawning a subprocess, whose lifetime outlives the
   * row and lands in whatever test the suite runs next (measured: a codex
   * runtime spawn surfacing as a failure inside the unrelated quit-path row).
   * Stubbing `sendMessage` keeps the arming observable and the send inert.
   */
  const scheduleGoal = (manager: ManagerInstance, managed: ManagedForTest): void => {
    ;(manager as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {}
    ;(manager as unknown as { schedulePiGoalContinuation: (m: unknown) => void })
      .schedulePiGoalContinuation(managed)
  }

  const goalServices = (manager: ManagerInstance): Map<string, unknown> =>
    (manager as unknown as { piGoalServices: Map<string, unknown> }).piGoalServices

  // P2.2 — the gate now ADMITS the two gateway runtimes, and the same two
  // observables that used to prove exclusion prove admission: the running flag
  // and the service the continuation lazily builds from the persisted state.
  // `pi-source` is the third member and the row that never changed.
  it.each(['claude-gateway', 'codex-gateway', 'pi-source'])(
    're-arms the goal continuation on %s',
    from => {
      const { manager, managed } = createSwitchHarness({ from })
      managed.goalState = activeGoalState() as never
      scheduleGoal(manager, managed)
      expect(managed.piGoalContinuationRunning).toBe(true)
      expect(goalServices(manager).has(`${managed.workspace.id}:${managed.id}`)).toBe(true)
    },
  )

  // Negative subject for the three rows above, and the reason the gate still
  // exists: a session with no ACTIVE goal must not arm on ANY of them, or the
  // rows would pass just as well against a gate that was deleted rather than
  // widened. (The runtime outside `SCHEDULED_DELIVERY_RUNTIMES` is the other
  // half and lives in `scheduled-delivery-runtimes.test.ts`, which owns a
  // `nestor-cloud-agent` connection this suite does not.)
  it.each(['claude-gateway', 'codex-gateway', 'pi-source'])(
    'does not re-arm on %s when there is no goal to continue',
    from => {
      const { manager, managed } = createSwitchHarness({ from })
      scheduleGoal(manager, managed)
      expect(managed.piGoalContinuationRunning).toBeUndefined()
      expect(goalServices(manager).has(`${managed.workspace.id}:${managed.id}`)).toBe(false)
    },
  )

  const delivery = (managed: ManagedForTest) => ({
    sessionKey: { workspaceId: managed.workspace.id, sessionId: managed.id },
    taskId: 'monitor-1',
    text: 'watch fired',
  })

  /**
   * T1 INVERTED this row, and the inversion is the point of the task.
   *
   * It used to read "drops a Pi monitor/cron delivery once the session has left
   * Pi", because the producer gate was `resolveManagedProvider(managed) === 'pi'`
   * and codex was outside it. The gate is now
   * `SCHEDULED_DELIVERY_RUNTIMES.includes(…)`, which holds all three coding
   * runtimes, so a switch to Codex or Claude no longer silences the scheduler
   * that switch is meant to carry over (decision D5). The runtime OUTSIDE the
   * set still drops — that control lives in
   * `scheduled-delivery-runtimes.test.ts`, which owns a `nestor-cloud-agent`
   * connection this suite does not.
   */
  it('delivers a scheduled monitor/cron event after the switch to Codex', () => {
    const { manager, managed } = createSwitchHarness({ from: 'codex-gateway' })
    ;(manager as unknown as { deliverScheduledMonitorEvent: (d: unknown) => void })
      .deliverScheduledMonitorEvent(delivery(managed))
    expect(managed.pendingTaskNotifications).toEqual(['watch fired'])
  })

  it('still delivers a scheduled monitor/cron event while the session is on Pi', () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-source' })
    ;(manager as unknown as { deliverScheduledMonitorEvent: (d: unknown) => void })
      .deliverScheduledMonitorEvent(delivery(managed))
    expect(managed.pendingTaskNotifications).toEqual(['watch fired'])
  })

  // The anti-over-gate control. `deliverMonitorEvent` is the SHARED sink: MCP
  // channel pushes and detached MCP results reach it on every runtime, so a
  // gate placed there instead would silently break channels on a runtime the
  // scheduling set does not cover.
  it('leaves the shared monitor sink open on a non-Pi provider', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'codex-gateway' })
    await (manager as unknown as { deliverMonitorEvent: (d: unknown) => Promise<void> })
      .deliverMonitorEvent(delivery(managed))
    expect(managed.pendingTaskNotifications).toEqual(['watch fired'])
  })
})

/**
 * T8. `cleanup()` takes the session mutation boundary for EVERY session and
 * lets the throw escape (`:21782`), and a runtime switch holds that boundary
 * for its whole teardown. A quit landing mid-switch therefore rejected at the
 * first busy session and skipped everything after it — SessionEnd hooks, Pi
 * drains, watchers, MCP pools, cron and LSP teardown, and the server lock-file
 * release the Electron quit handler runs after `cleanup()`.
 */
describe('a switch in flight and the quit path', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  const inFlight = (manager: ManagerInstance): Map<string, unknown> =>
    (manager as unknown as { runtimeSwitchesInFlight: Map<string, unknown> }).runtimeSwitchesInFlight

  it('lets cleanup finish while a switch is in flight', async () => {
    const { manager, managed, releaseDrain } = createSwitchHarness({ holdDrain: true })
    const switching = manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    // Let the switch reach the drain: by here it owns the boundary.
    await settle()
    expect(inFlight(manager).size).toBe(1)
    expect(boundaryHeld(manager, managed)).toBe(true)

    const cleaning = manager.cleanup()
    releaseDrain()
    await expect(cleaning).resolves.toBeUndefined()
    await switching.catch(() => undefined)
  })

  // Negative subject. The wait must be scoped to switches that are actually in
  // flight: an ordinary quit must not depend on the new await at all, or the
  // row above would pass just as well on a `cleanup()` that always waits for
  // something that never arrives.
  it('does not wait when no switch is in flight', async () => {
    const { manager } = createSwitchHarness({ isProcessing: false })
    expect(inFlight(manager).size).toBe(0)
    await expect(manager.cleanup()).resolves.toBeUndefined()
  })

  // The registration is a promise the quit path awaits; leaving it behind on a
  // failed switch would make every later quit hang forever.
  it('clears the registration when the switch fails', async () => {
    const { manager, managed } = createSwitchHarness({ isProcessing: false })
    await expect(manager.switchSessionRuntime(managed.id, 'no-such-connection', managed.workspace.id))
      .rejects.toThrow(/not found/)
    expect(inFlight(manager).size).toBe(0)
    expect(boundaryHeld(manager, managed)).toBe(false)
  })

  // `setProjectTrust`'s revoke has the identical shape: it takes the boundary
  // for every session in the workspace, in one loop, with no catch.
  it('lets a project-trust revoke finish while a switch is in flight', async () => {
    const { manager, managed, releaseDrain } = createSwitchHarness({ holdDrain: true })
    // Required to reach the boundary loop at all: without it the method
    // short-circuits on `session-project-unavailable` and the row would pass
    // on a revoke that never got near the boundary.
    managed.workingDirectory = workspaceRoot
    const switching = manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    await settle()
    expect(boundaryHeld(manager, managed)).toBe(true)

    const revoking = manager.setProjectTrust({
      session: { workspaceId: managed.workspace.id, sessionId: managed.id },
      state: 'untrusted',
    }).then(() => 'ok', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    releaseDrain()
    expect(await revoking).toBe('ok')
    await switching.catch(() => undefined)
  })
})

/**
 * T10 on the real switch path. The unit coverage for the stamp is in
 * `message-provenance.test.ts`; this is the end-to-end half, and it also
 * measures the two `RuntimeSwitchResult` fields T16 declared and left empty.
 */
describe('provenance across a switch', () => {
  it('fills the result\'s from/to with the two runtimes', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-source' })
    managed.messages = [{ id: 'm1', role: 'user', content: 'hi' }] as never
    const result = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    expect(result).toMatchObject({ from: 'pi', to: 'codex-runtime' })
  })

  // The notice row is appended BEFORE `llmConnection` is rewritten, so it
  // belongs to the runtime being left — which is what puts the boundary
  // between the two runtimes rather than inside the new one.
  it('stamps the switch notice with the runtime it is leaving', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-source' })
    managed.messages = [{ id: 'm1', role: 'user', content: 'hi' }] as never
    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    const notice = (managed.messages as Array<{ content: string; runtime?: string; llmConnection?: string }>).at(-1)
    // R1's tail rides along: `claude-gateway`'s default is `claude-gw-model-a`,
    // whose 200 000 window the fixture declares on the connection. Since P6.10
    // a `claude-*` id takes the fit arithmetic like any other, and one `hi`
    // fits — so this row is also the control for the tail's VALUE, not just for
    // its presence. It read `"text"` until 2026-09-01, off the collapsed arm.
    expect(notice?.content).toBe('runtime_switched:pi:anthropic:{"carry":"native"}')
    expect(notice).toMatchObject({ runtime: 'pi', llmConnection: 'pi-source' })
  })
})

/**
 * T13. `EnterWorktree`/`ExitWorktree` and every child control are
 * `visibility: 'pi-only'`, so anything the session is still holding when it
 * leaves Pi becomes unreachable. The drain already releases the leases and
 * stops the children — what it does not do is move the session out of the
 * directory it is about to reap, or say which children it stopped.
 */
describe('the switch leaves the worktree and lands the children first', () => {
  const LEASE_PATH = '/tmp/nessy-worktrees/project/worktree-a'

  /**
   * A stub `WorktreeLeaseService`. Installing it in `piWorktreeLeaseServices`
   * is what makes `createPiWorktreeLeaseService` return it instead of building
   * a real one — the real one resolves a project handle and shells out to git.
   */
  function installLease(manager: ManagerInstance, managed: ManagedForTest, path = LEASE_PATH) {
    const lease = { worktreeLeaseId: 'worktree-a', path, branch: 'nessy/session/worktree-a', baseSha: 'abc' }
    ;(manager as unknown as { piWorktreeLeaseServices: Map<string, unknown> })
      .piWorktreeLeaseServices.set(`${managed.workspace.id}:${managed.id}`, {
        setEmit: () => {},
        list: () => [lease],
        touch: async () => {},
      })
    return lease
  }

  /** Records the cwd moves the port asks for, instead of performing them. */
  function captureCwdMoves(manager: ManagerInstance, managed: ManagedForTest): string[] {
    const moves: string[] = []
    ;(manager as unknown as Record<string, unknown>).mutateWorkingDirectory = async (
      m: ManagedForTest, input: { path: string },
    ) => {
      moves.push(input.path)
      m.workingDirectory = input.path
    }
    return moves
  }

  it('returns the session to the launch directory before the runtime changes', async () => {
    const { manager, managed } = createSwitchHarness()
    installLease(manager, managed)
    managed.sdkCwd = workspaceRoot
    managed.workingDirectory = LEASE_PATH
    const moves = captureCwdMoves(manager, managed)

    // The ORDER is the point, and the only way to see it is from inside the
    // drain: it releases the lease and `git worktree remove`s the directory, so
    // an exit that ran afterwards would move the session into a path that no
    // longer exists.
    let cwdAtDrain: unknown
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async (m: ManagedForTest) => {
      cwdAtDrain = m.workingDirectory
    }

    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(moves).toEqual([workspaceRoot])
    expect(cwdAtDrain).toBe(workspaceRoot)
    expect(managed.workingDirectory).toBe(workspaceRoot)
  })

  // Negative subject: the same switch on a session that is NOT inside a lease
  // must not touch the working directory at all. Without this, an exit that
  // fired unconditionally would pass the row above.
  it('leaves the working directory alone when the session is not in a worktree', async () => {
    const { manager, managed } = createSwitchHarness()
    installLease(manager, managed)
    managed.sdkCwd = workspaceRoot
    managed.workingDirectory = workspaceRoot
    const moves = captureCwdMoves(manager, managed)
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async () => {}

    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(moves).toEqual([])
    expect(managed.workingDirectory).toBe(workspaceRoot)
  })

  it('refuses when the cwd is inside a worktree the port cannot leave', async () => {
    const { manager, managed } = createSwitchHarness()
    installLease(manager, managed)
    managed.sdkCwd = workspaceRoot
    // A `/cd` into a SUBDIRECTORY of the worktree. `SessionWorktreePort.exit`
    // matches the lease root exactly, so it resolves null here.
    managed.workingDirectory = `${LEASE_PATH}/src`
    captureCwdMoves(manager, managed)

    const error = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
      .then(() => undefined, (e: unknown) => e as { code?: string })
    expect(error?.code).toBe('WORKTREE_EXIT_UNAVAILABLE')
  })

  it('re-codes the drain\'s dirty-worktree refusal so the user can act on it', async () => {
    const { manager, managed } = createSwitchHarness()
    const { WorktreeLeaseError } = await import('../../pi-harness/worktree-lease-service.ts')
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async () => {
      // The shape the real drain produces: the lease error on `cause`, under
      // `pi-session-drain-failed`.
      throw new Error('pi-session-drain-failed:runtime switch (connection-cross-runtime)', {
        cause: new WorktreeLeaseError('worktree-dirty', [
          { resourceType: 'worktree', resourceId: 'worktree-a', code: 'worktree-dirty' },
        ]),
      })
    }

    const error = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
      .then(() => undefined, (e: unknown) => e as { code?: string; message?: string })
    expect(error?.code).toBe('WORKTREE_DIRTY')
    expect(error?.message).toContain('worktree-a')
  })

  // Negative subject for the re-code: any OTHER drain failure keeps its own
  // error. A catch that coded everything `WORKTREE_DIRTY` would pass above.
  it('leaves an unrelated drain failure untouched', async () => {
    const { manager, managed } = createSwitchHarness()
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async () => {
      throw new Error('pi-session-drain-failed:runtime switch', {
        cause: new AggregateError([new Error('pi-session-shell-owner-residual')], 'pi-session-drain-failed'),
      })
    }

    const error = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
      .then(() => undefined, (e: unknown) => e as { code?: string; message?: string })
    expect(error?.code).toBeUndefined()
    expect(error?.message).toContain('pi-session-drain-failed')
  })

  it('names the background children the switch stopped', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.childSessionState = {
      schemaVersion: 1,
      revision: 1,
      sealedOwnerTaskIds: [],
      children: [
        { agent: 'reviewer', agentId: 'a1', status: 'running' },
        { agent: 'tester', agentId: 'a2', status: 'starting' },
        { agent: 'archivist', agentId: 'a3', status: 'completed' },
      ],
    } as never
    // The drain itself is not under test here — and with live children the real
    // one builds a worktree service and shells out to git. It DOES clear the
    // children though, and the stub does the same on purpose: that is what
    // makes this row fail if the accounting is read after the drain instead of
    // before it, which is the whole reason the read sits where it does.
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async (m: ManagedForTest) => {
      m.childSessionState = { schemaVersion: 1, revision: 2, sealedOwnerTaskIds: [], children: [] } as never
    }

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    // Only the ones that were still doing something. `archivist` had already
    // finished, so the switch cost the user nothing there.
    expect(result.stoppedChildren).toEqual(['reviewer', 'tester'])
  })

  it('says nothing about children when there were none running', async () => {
    const { manager, managed } = createSwitchHarness()
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.stoppedChildren).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // P6.113 — the background COMMANDS the same drain kills
  // ---------------------------------------------------------------------------

  it('names the background commands the switch stopped, by their command lines', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.backgroundShellCommands = new Map([
      ['shell-1', 'npm run dev'],
      ['shell-2', 'tail -f server.log'],
      // `adoptSupervisedShellCommands` stores an empty string for a record that
      // carried no command; a row for it must still be countable, so the handle
      // stands in rather than an empty name in the middle of a list.
      ['shell-3', '   '],
    ]) as never
    // Same shape as the children row above and for the same reason: the REAL
    // drain kills these and then the switch clears the map, so a stub that
    // clears it is what makes this fail if the read moves after the drain.
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async (m: ManagedForTest) => {
      (m.backgroundShellCommands as Map<string, string>).clear()
    }

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(result.stoppedBackgroundShells).toEqual(['npm run dev', 'tail -f server.log', 'shell-3'])
  })

  it('says nothing about background commands when the session holds none', async () => {
    // The negative: a switch on a session with no background shell must add
    // nothing, or every switch would carry a warning nobody can act on.
    const { manager, managed } = createSwitchHarness()
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.stoppedBackgroundShells).toBeUndefined()
  })

  it('reports them on a SAME-runtime connection change too, because that drain kills them as well', async () => {
    // The measurement that decided the field's home. The row's own done_means
    // said a same-runtime change should list nothing — refuted at HEAD:
    // `strictDrainSessionForMutation` runs for EVERY switch kind (the call site
    // passes `runtime switch (${kind})`) and its own comment says it "kills
    // background shells". Had this ridden `capabilityDelta`, which returns
    // undefined whenever `from === to`, this case would have stayed silent.
    const { manager, managed } = createSwitchHarness({ from: 'pi-source' })
    managed.backgroundShellCommands = new Map([['shell-1', 'npm run dev']]) as never
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async (m: ManagedForTest) => {
      (m.backgroundShellCommands as Map<string, string>).clear()
    }

    const result = await manager.switchSessionRuntime(managed.id, 'pi-shared', managed.workspace.id)

    expect(result.kind).toBe('connection-same-runtime')
    expect(result.capabilityDelta).toBeUndefined()
    expect(result.stoppedBackgroundShells).toEqual(['npm run dev'])
  })
})

/**
 * T17. Nothing about the capability layer SWITCHES — it is destroyed and
 * re-resolved from the same records, so the inventory comes back identical. The
 * execution does not: LSP servers, monitors and four of five hook action kinds
 * are wired behind `provider === 'pi'`. This is the only thing in the product
 * that can say so.
 */
describe('the switch names what stops executing', () => {
  function withPeripherals(managed: ManagedForTest) {
    managed.capabilityRuntime = {
      provider: 'pi',
      view: {
        generation: 'g1',
        sources: [], skills: [], mcpServers: [], automations: [], agents: [],
        promptLayers: [], memory: [], permissionLayers: [], commands: [],
        promptCommands: [], apps: [],
        hooks: [
          { key: 'h1', event: 'PreToolUse', type: 'command' },
          { key: 'h2', event: 'PreToolUse', type: 'agent' },
          { key: 'h3', event: 'PostToolUse', type: 'mcp' },
          { key: 'h4', event: 'SessionStart', type: 'http' },
          { key: 'h5', event: 'SessionEnd', type: 'prompt' },
          // A second `agent` hook: the kinds are deduplicated, not counted.
          { key: 'h6', event: 'Stop', type: 'agent' },
        ],
        lspServers: [{ key: 'l1', lspId: 'tsserver' }],
        monitors: [{ key: 'm1', monitorId: 'dev-server' }],
      },
    } as never
  }

  it('names the peripherals and the hook kinds the target will not run', async () => {
    const { manager, managed } = createSwitchHarness()
    withPeripherals(managed)

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(result.capabilityDelta).toEqual({
      // P6.175 — EMPTY on purpose, and this is the row's own acceptance
      // criterion. The monitors do not stop on a claude target: the scheduled
      // ones steer through `ClaudeAgent.redirect` and the command ones are
      // ordinary supervised processes delivering through
      // `deliverScheduledMonitorEvent`, whose runtime set has listed all three
      // coding runtimes since T1. The list beside it is the control that keeps
      // this from reading as an emptied delta.
      stoppedMonitors: [],
      lostLsp: ['tsserver'],
      // Command hooks run on every runtime and are never listed; after P6.117
      // neither are `http`, `mcp` and `prompt`, and after P6.590 neither is
      // `agent` — the child-session port its runner needs is assigned on every
      // runtime now, so a claude target takes away no hook KIND at all. The
      // list is subtracted from the record the builder spreads, so it cannot
      // claim a runner is missing that the builder supplies. `lostLsp` beside
      // it is what keeps this from reading as an emptied delta.
      inertHookKinds: [],
      // P3.350 · the claude arm adds NOTHING, and that is the row's own
      // requirement rather than an accident of this fixture. WHY it is empty
      // changed under P6.89 and the difference matters: it used to be what an
      // UNMEASURED column owes — `anthropic` had no column at all, the SDK
      // being a closed bundle. The column is now measured in one direction
      // (the SDK's own `HookEvent` union plus the shipped binary's per-event
      // payload construction), every event in our vocabulary is `emitted`
      // there, and the list is empty because nothing is lost rather than
      // because nothing was read.
      inertHookEvents: [],
      nativeHookEventRoutes: [],
      // P3.340 · the post-edit diagnostics and the `format` tool are host-side
      // runners injected only where `HOST_EDIT_TOOLING_SUPPORT` says so, and
      // this is the only surface that says they stopped.
      hostEditToolingLost: true,
    })
  })

  /**
   * P6.175 · THE RECORD THAT DECIDED THREE UNRELATED THINGS.
   *
   * `PLUGIN_PERIPHERAL_SUPPORT` answered one question — "does this runtime run
   * a plugin's peripherals?" — and four sites read it: the monitors, the
   * language servers, MCP channel push and, one package over, the inert hook
   * kinds. Three records and one runner table now, so a switch report can say
   * that the monitors survive while the language servers do not, which is the
   * truth and was unsayable before.
   *
   * The negative side is the point of the pair: an emptied `stoppedMonitors`
   * that came from an emptied delta would be a regression wearing the fix's
   * clothes, so the LSP list beside it must stay populated on the same switch.
   */
  it('separates the monitors from the language servers on a claude target', async () => {
    const { manager, managed } = createSwitchHarness()
    withPeripherals(managed)

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(result.capabilityDelta?.stoppedMonitors).toEqual([])
    expect(result.capabilityDelta?.lostLsp).toEqual(['tsserver'])
    // The delta itself is still produced — the row is about WHICH entries it
    // carries, not about silencing it.
    expect(result.capabilityDelta).toBeDefined()
  })

  /**
   * P6.176 — the codex arm of the same property, whose value sits in the record
   * P6.175 split. Its delivery primitive is codex's OWN `turn/steer`, which
   * `CodexAgent.redirect` already drives, and whose `false` is inert by contract
   * — so unlike the claude arm this one cannot abort a turn even in the
   * fallback. `lostLsp` beside it is the negative control AND a structural
   * finding: the shipped binary carries no `lsp_servers` at all.
   */
  it('separates the monitors from the language servers on a codex target', async () => {
    const { manager, managed } = createSwitchHarness()
    withPeripherals(managed)

    const result = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)

    expect(result.capabilityDelta?.stoppedMonitors).toEqual([])
    expect(result.capabilityDelta?.lostLsp).toEqual(['tsserver'])
    // `inertHookKinds` is a different record from the monitors'. P6.117 gave
    // codex three of its four runners and P6.590 the fourth, so no hook kind is
    // lost on this target; `lostLsp` above is the non-vacuous half.
    expect(result.capabilityDelta?.inertHookKinds).toEqual([])
  })

  /**
   * P3.350 · the arm the claude row above cannot reach.
   *
   * `hookEventsThatNeverFire` answers non-empty for codex alone — after P6.89
   * and P6.90 the other two columns are measured and carry no `unwired` or
   * `unreachable` cell at all — so this is still the only target for which the
   * event list can be non-empty, and the
   * `command` hook on `PreToolUse` in the fixture is the subject: it keeps its
   * runner on every runtime (`pluginCommandHookRunner` is supplied
   * unconditionally), so `inertHookKinds` excludes it by construction and
   * nothing in the product could say the moment itself stops happening.
   *
   * Derived, never transcribed: the expectation is computed from the same
   * table the production path reads, so a codex bump that moves a cell moves
   * this row with it instead of failing it.
   */
  it('names the hook EVENTS a codex target never reaches, and its own key for them', async () => {
    const { manager, managed } = createSwitchHarness()
    withPeripherals(managed)

    const result = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)

    const registered = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop']
    const expectedEvents = hookEventsThatNeverFire('codex-runtime')
      .filter(event => registered.includes(event))
    // Positive control on the derivation itself: an emptied table, or a needle
    // that stopped matching, must not read as agreement-by-vacuum.
    expect(expectedEvents.length).toBeGreaterThan(0)
    // …and a PROPER subset, so the row keeps a negative side: the three events
    // codex DOES emit must not be listed.
    expect(expectedEvents.length).toBeLessThan(registered.length)
    expect(result.capabilityDelta?.inertHookEvents).toEqual([...expectedEvents])

    // P6.14's honesty half: every listed event that codex hooks itself is named
    // by the config key a fix would be written under.
    expect(result.capabilityDelta?.nativeHookEventRoutes).toEqual([
      ...new Set(expectedEvents
        .map(event => hookEventNativeRoute('codex-runtime', event))
        .filter((route): route is NonNullable<typeof route> => route !== undefined)),
    ])
    expect(result.capabilityDelta?.nativeHookEventRoutes.length).toBeGreaterThan(0)
  })

  /**
   * P6.120 — the COMPONENT hook layer, which the switch report could not see.
   *
   * `describeCapabilityDelta` derived its registered-event set from
   * `view.hooks` alone — the plugin/config capability view. A skill's or an
   * agent's frontmatter hooks live in a separate layer that is resolved fresh
   * per dispatch, so `capabilities/runtime-automations.ts` says in its own
   * words that it "has no event set at build time" and that its events are
   * "reported by whoever gains that surface". Nobody had. A skill whose
   * frontmatter hooks `PreToolUse` therefore stopped firing on a switch to
   * codex with nothing said.
   *
   * Built from a REAL frontmatter parse and the REAL layer factory, not a
   * hand-made `hasMatchers`: what is being pinned is that the report asks the
   * same question the dispatcher asks, so a stub that answered `true` would
   * pin nothing.
   */
  function withActiveSkillHook(managed: ManagedForTest, frontmatter: string) {
    // No plugin hooks at all, so the component layer is the ONLY source the
    // event can come from and the row cannot pass on `view.hooks`.
    managed.capabilityRuntime = {
      provider: 'pi',
      view: {
        generation: 'g1',
        sources: [], skills: [], mcpServers: [], automations: [], agents: [],
        promptLayers: [], memory: [], permissionLayers: [], commands: [],
        promptCommands: [], apps: [], hooks: [], lspServers: [], monitors: [],
      },
    } as never
    const active: SkillInvocationRecord[] = frontmatter
      ? [{ key: 'skill:guard', componentHooks: parseSkillFrontmatterHooks(frontmatter) } as SkillInvocationRecord]
      : []
    ;(managed.agent as Record<string, unknown>).getComponentHookLayer =
      () => createComponentHookLayer(() => active, new Set())
    return active
  }

  it("names a skill's frontmatter hook on an event the target never reaches", async () => {
    const { manager, managed } = createSwitchHarness({ isProcessing: false })
    const active = withActiveSkillHook(
      managed,
      '---\nname: guard\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n---\nbody',
    )
    // The fixture really did produce a hook — otherwise the assertion below
    // would be satisfied by a parse that silently returned nothing.
    expect(active[0]?.componentHooks?.always?.automations.PreToolUse?.length).toBe(1)

    const result = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)

    // `PreToolUse` is `unwired` on codex, so it is named — and its native route
    // is named with it, because codex hooks the moment itself.
    expect(result.capabilityDelta?.inertHookEvents).toEqual(['PreToolUse'])
    expect(result.capabilityDelta?.nativeHookEventRoutes).toEqual(['PreToolUse'])
    // …and the plugin arms stay empty, which is the proof the event came from
    // the component layer rather than from `view.hooks`.
    expect(result.capabilityDelta?.inertHookKinds).toEqual([])
  })

  it('says nothing when no component hook is active — the control', async () => {
    const { manager, managed } = createSwitchHarness({ isProcessing: false })
    withActiveSkillHook(managed, '')

    const result = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)

    // The same switch, the same empty `view.hooks`, no skill: the arm must add
    // nothing. Without this the row above would pass on a report that named
    // every never-firing event whether or not anything was registered on it.
    expect(result.capabilityDelta?.inertHookEvents).toEqual([])
    expect(result.capabilityDelta?.nativeHookEventRoutes).toEqual([])
  })

  /**
   * P6.86 — the caveat an UNMEASURED hook column owes, and why this is a pin
   * rather than a line in the toast.
   *
   * The row was born against a real hole: `hookEventsThatNeverFire` answers `[]`
   * both for a runtime measured to lose nothing AND for one nobody has read, and
   * the switch report could not tell those apart, so a switch onto Pi or claude
   * said nothing where it owed *"we have not measured this"*.
   *
   * That premise is CLOSED AT HEAD, by the two rows immediately before this one
   * in the same lane: P6.89 measured claude's column from the SDK's own
   * `HookEvent` union and P6.90 measured Pi's from its three emitter surfaces.
   * What is left of the hole is `nestor-cloud-agent` — and it is refused as a
   * switch target BY NAME before any delta is computed, so the caveat has no
   * reachable subject at all.
   *
   * A user-visible line for a state no user can reach would be a locale key in
   * every locale and a wire field that is always false — the documented-and-
   * unbuilt shape this tree keeps finding. So the guarantee is asserted instead,
   * TOTALLY over the provider vocabulary and with the refusal DRIVEN rather than
   * quoted: the day a runtime is added with no column, or the day the remote
   * connection becomes switchable, this row goes red — and that is the day the
   * line has to be written.
   */
  it('every runtime reachable as a switch TARGET has a measured hook-event column', async () => {
    // Total over the vocabulary, never a retyped list: `AGENT_PROVIDERS` is the
    // same constant `runtime-vocabulary.ts` exists to make a new runtime a
    // decision against.
    const unmeasured = AGENT_PROVIDERS.filter(provider => !hookEventColumnMeasured(provider))
    expect(unmeasured).toEqual(['nestor-cloud-agent'])

    // The refusal, driven through the real method on a real connection of that
    // provider — the half that makes the silence safe. Asserting the source line
    // instead would pass on a method that had stopped calling it.
    const { manager, managed } = createSwitchHarness()
    await expect(manager.switchSessionRuntime(managed.id, 'nestor-remote', managed.workspace.id))
      .rejects.toThrow(/cannot be switched/)

    // Positive control on the same rig: the refusal is specific to that
    // provider, not a method that refuses everything — a MEASURED target goes
    // through, and its delta is computed rather than skipped.
    const measured = createSwitchHarness()
    const result = await measured.manager.switchSessionRuntime(
      measured.managed.id, 'claude-gateway', measured.managed.workspace.id,
    )
    expect(result.kind).toBe('connection-cross-runtime')
  })

  /**
   * P3.340's negative side — the one the peripherals rows cannot supply,
   * because a session with no plugin at all still loses the edit tooling.
   */
  it('says the host edit tooling stopped even with nothing plugin-shaped installed', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.capabilityRuntime = {
      provider: 'pi',
      view: {
        generation: 'g1',
        sources: [], skills: [], mcpServers: [], automations: [], agents: [],
        promptLayers: [], memory: [], permissionLayers: [], commands: [],
        promptCommands: [], apps: [], hooks: [], lspServers: [], monitors: [],
      },
    } as never

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(result.capabilityDelta).toEqual({
      stoppedMonitors: [],
      lostLsp: [],
      inertHookKinds: [],
      inertHookEvents: [],
      nativeHookEventRoutes: [],
      hostEditToolingLost: true,
    })
  })

  // The negative subject, and the one the plan calls for by name: a switch
  // BACK onto Pi costs none of this. Without it, a delta that simply reports
  // the whole view on every switch passes the row above.
  it('says nothing when the target runs the peripherals', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'claude-gateway' })
    withPeripherals(managed)

    const result = await manager.switchSessionRuntime(managed.id, 'pi-source', managed.workspace.id)

    expect(result.kind).toBe('connection-cross-runtime')
    expect(result.capabilityDelta).toBeUndefined()
  })

  // The remaining silence: no capability view at all, so there is nothing to
  // read. (A session that HAS a view but no plugins still loses the host edit
  // tooling — the row above.)
  it('says nothing when the session never resolved a capability view', async () => {
    const { manager, managed } = createSwitchHarness()
    expect(managed.capabilityRuntime).toBeUndefined()
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.capabilityDelta).toBeUndefined()
  })

  // Read from the OUTGOING view, and the drain disposes it. Same placement
  // rule the children accounting follows, for the same reason.
  it('reads the outgoing runtime\'s view, before the drain disposes it', async () => {
    const { manager, managed } = createSwitchHarness()
    withPeripherals(managed)
    ;(manager as unknown as Record<string, unknown>).strictDrainSessionForMutation = async (m: ManagedForTest) => {
      m.capabilityRuntime = undefined
    }

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(result.capabilityDelta?.lostLsp).toEqual(['tsserver'])
  })
})

/**
 * P3 · the carry plan is decided on a LOADED transcript, and while declining is
 * still free.
 *
 * The planner's own arithmetic is unit-tested in `../runtime-switch.test.ts`.
 * What this suite owns is the SEAM'S POSITION, which is the thing A1 found
 * wrong in the plan's first draft.
 */
describe('the pre-switch carry plan', () => {
  const sessionManagerSource = readFileSync(
    fileURLToPath(new URL('../SessionManager.ts', import.meta.url)),
    'utf8',
  )

  // A1. `managed.messages` is LAZY, so a plan computed before
  // `ensureMessagesLoaded` reads `[]` on any session the user has not opened in
  // this process, estimates a payload of zero, and answers `native`
  // unconditionally — the promise would be WIDEST on exactly the sessions
  // nobody has looked at. And it must be decided before the boundary acquire,
  // because everything past that point is irreversible.
  //
  // Asserted on the source because the invariant is an ORDER and no black-box
  // outcome can currently discriminate it: with
  // `NATIVE_HISTORY_CARRY_IMPLEMENTED` false for every runtime, both orderings
  // produce the same `text` plan today. The day T1a or T2 flips a line, a
  // mis-ordered plan starts promising the whole conversation on cold sessions
  // silently — so this catches it in advance rather than after.
  it('sits after the transcript load and before the boundary acquire', () => {
    const start = sessionManagerSource.indexOf('  async switchSessionRuntime(')
    const end = sessionManagerSource.indexOf('  describeCapabilityDelta(')
    // Positive controls: an unfound anchor is -1, and -1 satisfies every
    // ordering assertion below vacuously.
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)

    const body = sessionManagerSource.slice(start, end)
    const load = body.indexOf('await this.ensureMessagesLoaded(managed)')
    const carry = body.indexOf('planHistoryCarry({')
    const boundary = body.indexOf('this.acquireSessionMutationBoundary(managed)')
    expect(load).toBeGreaterThan(0)
    expect(carry).toBeGreaterThan(0)
    expect(boundary).toBeGreaterThan(0)

    expect(load).toBeLessThan(carry)
    expect(carry).toBeLessThan(boundary)
  })

  // A1's behavioural half, through the one surface that reports the plan:
  // `previewRuntimeSwitch`, the read-only command the confirmation modal calls.
  //
  // **T1a made this test able to fail for the first time.** It used to assert
  // `historyCarry === 'text'` for a cold codex target, which held only because
  // the capability map was false everywhere — a plan computed BEFORE the load
  // would have produced the same `text` and scored green. Now that Codex has a
  // native carry, the transcript loaded here is one no window can hold, so the
  // two orderings give DIFFERENT answers: computed before the load the payload
  // is zero tokens and the plan is `native`; computed after it, `text`. That is
  // exactly A1's claim, and this is now a measurement of it.
  it('loads a cold transcript BEFORE planning, so the plan is about what is really there', async () => {
    const { manager, managed } = createSwitchHarness()
    managed.messagesLoaded = false
    managed.messages = [] as never
    let loads = 0
    ;(manager as unknown as Record<string, unknown>).ensureMessagesLoaded = async (m: ManagedForTest) => {
      loads += 1
      // Comfortably past `gpt-5.3-codex`'s 272 000-token window once the margin
      // and the resting context are added.
      m.messages = [{ id: 'm1', role: 'user', content: 'from disk '.repeat(200_000) }]
      m.messagesLoaded = true
    }

    const preview = await manager.previewRuntimeSwitch(managed.id, 'codex-gateway', managed.workspace.id)

    expect(loads).toBe(1)
    expect(preview.kind).toBe('connection-cross-runtime')
    expect(preview.hasHistory).toBe(true)
    // The plan saw the loaded transcript. A plan computed before the load reads
    // `[]`, estimates zero, and answers `native`.
    expect(preview.historyCarry).toBe('text')

    // POSITIVE CONTROL for the assertion above: the same cold session with a
    // transcript that DOES fit comes back `native`, so the `text` is the
    // payload speaking and not the capability map or a preview that refuses.
    const { manager: m2, managed: g2 } = createSwitchHarness()
    g2.messagesLoaded = false
    g2.messages = [] as never
    ;(m2 as unknown as Record<string, unknown>).ensureMessagesLoaded = async (m: ManagedForTest) => {
      m.messages = [{ id: 'm1', role: 'user', content: 'from disk' }]
      m.messagesLoaded = true
    }
    expect((await m2.previewRuntimeSwitch(g2.id, 'codex-gateway', g2.workspace.id)).historyCarry).toBe('native')
  })

  // D7. A returning leg promises something different, and the modal has to say
  // so: the target resumes its OWN transcript, so nothing is rebuilt.
  it('reports the anchored tier when the target has been here before', async () => {
    const { manager, managed } = createSwitchHarness({
      anchor: { provider: 'anthropic', id: 'claude-1' },
    })
    managed.messages = [{ id: 'm1', role: 'user', content: 'add a retry' }] as never

    const preview = await manager.previewRuntimeSwitch(managed.id, 'claude-gateway', managed.workspace.id)

    expect(preview.historyCarry).toBe('anchor')
  })

  // Nothing to decide, so nothing is promised: the modal's carry line is
  // omitted rather than filled with a tier that does not apply.
  it('promises nothing for a same-runtime switch or an empty session', async () => {
    const sameRuntime = createSwitchHarness({ from: 'claude-max' })
    sameRuntime.managed.messages = [{ id: 'm1', role: 'user', content: 'hi' }] as never
    const sameRuntimePreview = await sameRuntime.manager.previewRuntimeSwitch(
      sameRuntime.managed.id, 'claude-gateway', sameRuntime.managed.workspace.id,
    )
    expect(sameRuntimePreview.kind).toBe('connection-same-runtime')
    expect(sameRuntimePreview.historyCarry).toBeUndefined()

    const empty = createSwitchHarness()
    const emptyPreview = await empty.manager.previewRuntimeSwitch(
      empty.managed.id, 'codex-gateway', empty.managed.workspace.id,
    )
    expect(emptyPreview.hasHistory).toBe(false)
    expect(emptyPreview.historyCarry).toBeUndefined()
  })

  /**
   * P3.266 · the preview answers WHY, and it answers it beside the plan.
   *
   * The consumer (`runtimeSwitchCopyKey`) gates the reason line on having a plan
   * next to it, so the two fields have to leave the server together — and the
   * reason is sent UNFILTERED, because `REASON_KEY_BY_REASON` maps `fits` and
   * `target-already-anchored` to `null` in the renderer on purpose. Filtering
   * here would be a second copy of that judgement in the one place that cannot
   * see the copy it is written to agree with.
   */
  it('reports the carry REASON alongside the plan, including the non-degrading ones', async () => {
    const degrading = createSwitchHarness()
    degrading.managed.messagesLoaded = false
    degrading.managed.messages = [] as never
    ;(degrading.manager as unknown as Record<string, unknown>).ensureMessagesLoaded = async (m: ManagedForTest) => {
      m.messages = [{ id: 'm1', role: 'user', content: 'from disk '.repeat(200_000) }]
      m.messagesLoaded = true
    }
    const overflow = await degrading.manager.previewRuntimeSwitch(
      degrading.managed.id, 'codex-gateway', degrading.managed.workspace.id,
    )
    expect(overflow.historyCarry).toBe('text')
    // The one reason a user can act on — continue on a bigger window, or accept
    // the summary — so it is the one that must reach the modal.
    expect(overflow.historyCarryReason).toBe('does-not-fit')

    // The non-degrading arms are answered too, not withheld: the pair travels
    // together and the renderer decides what to draw.
    const fitting = createSwitchHarness()
    fitting.managed.messages = [{ id: 'm1', role: 'user', content: 'add a retry' }] as never
    const fits = await fitting.manager.previewRuntimeSwitch(
      fitting.managed.id, 'codex-gateway', fitting.managed.workspace.id,
    )
    expect(fits.historyCarry).toBe('native')
    expect(fits.historyCarryReason).toBeDefined()
    expect(fits.historyCarryReason).not.toBe('does-not-fit')

    // …and where there is no plan there is no reason, so the modal can never be
    // handed an explanation for a promise it is not making.
    const empty = createSwitchHarness()
    const emptyPreview = await empty.manager.previewRuntimeSwitch(
      empty.managed.id, 'codex-gateway', empty.managed.workspace.id,
    )
    expect(emptyPreview.historyCarry).toBeUndefined()
    expect(emptyPreview.historyCarryReason).toBeUndefined()
  })

  // A preview must not touch the session. It runs before the user has agreed to
  // anything, so a preview that armed a handoff, took the boundary or dropped
  // runtime state would make cancelling the dialog destructive.
  it('changes nothing — it is a question, not a switch', async () => {
    const { manager, managed } = createSwitchHarness({ anchor: { provider: 'pi', id: 'pi-1' } })
    managed.messages = [{ id: 'm1', role: 'user', content: 'add a retry' }] as never
    managed.piContinuationEnvelope = { schemaVersion: 1 } as never

    await manager.previewRuntimeSwitch(managed.id, 'codex-gateway', managed.workspace.id)

    expect(managed.llmConnection).toBe('pi-source')
    expect(managed.runtimeHandoffFrom).toBeUndefined()
    expect(managed.piContinuationEnvelope).toBeDefined()
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'pi')).toBe('pi-1')
    expect(managed.messages).toHaveLength(1)
    expect(boundaryHeld(manager, managed)).toBe(false)
  })
})

/**
 * T2 · a switch INTO Claude rebuilds the SDK's own session transcript.
 *
 * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`, T2.
 *
 * What is owned HERE is the wiring: the trigger, the anchor, the plan gate, and
 * the two decisions that would be invisible anywhere else — that it fires on
 * `providerType` rather than on `AgentProvider`, and that it never overwrites a
 * Claude anchor the vendor already owns (D7).
 *
 * What is NOT owned here: the record envelope, the path derivation and the
 * chaining, which are `claude-transcript-rebuild.test.ts`'s against the SDK's
 * own 166 real project directories; and the four integrity guards, which are
 * `runtime-handoff-payload.test.ts`'s against the corpus counts they were
 * measured at. The end-to-end proof that the SDK loads what we write and puts
 * it on the wire is `claude-transcript-resume-e2e.test.ts`.
 *
 * **The fixture that matters is `claude-shared`, not `claude-gateway`.**
 * `claude-shared` carries the real gateway catalogue (`tgpt/…`, the ids the 200
 * real transcripts were written under) and is the shape the product actually
 * ships. Until P6.10 there was a second, stronger reason — P3's collapsed
 * `claude-*` arm meant a target defaulting to `claude-gw-model-a` never planned
 * `native` at all — and that reason is gone: such a target now takes the fit
 * arithmetic. The catalogue argument is the one that survives, so it is the one
 * left standing here.
 */
const sessionManagerSourceForRebuild = readFileSync(
  fileURLToPath(new URL('../SessionManager.ts', import.meta.url)),
  'utf8',
)

/**
 * The path the SDK would open for this session, derived the way the spawn path
 * derives it. Module-scoped because R1's crash block asks the same question of
 * the same sessions, and two derivations of a transcript path is the defect the
 * extracted `resolveClaudeTranscriptCwd` exists to prevent.
 */
async function transcriptPathFor(managed: ManagedForTest, sdkSessionId: string): Promise<string> {
  const agent = await import('@nessy-agent/shared/agent')
  const configDir = agent.workspaceClaudeConfigDir((managed.workspace as { id: string }).id)!
  const cwd = agent.resolveClaudeTranscriptCwd({
    isRetry: false,
    branchFromSdkSessionId: null,
    branchFromSdkCwd: null,
    sdkCwd: (managed as { sdkCwd?: string }).sdkCwd ?? null,
    workspaceId: (managed.workspace as { id: string }).id,
    sessionId: managed.id,
    workspaceRootPath: workspaceRoot,
  })
  return agent.claudeTranscriptPath({ configDir, cwd, sdkSessionId })
}

describe('a switch into Claude rebuilds the SDK transcript', () => {
  const carriedRows = () => ([
    { id: 'm1', role: 'user', content: 'read the config', timestamp: 1_760_000_000_000, runtime: 'pi' },
    { id: 'm2', role: 'assistant', content: 'reading it now', isIntermediate: true, timestamp: 1_760_000_001_000, runtime: 'pi' },
    {
      id: 'm3',
      role: 'tool',
      content: '',
      toolName: 'Read',
      toolStatus: 'completed',
      rawToolInput: { file_path: '/tmp/config.json' },
      rawToolResult: 'the fixture port is 8123',
      timestamp: 1_760_000_002_000,
      runtime: 'pi',
    },
    { id: 'm4', role: 'assistant', content: 'the port is 8123', timestamp: 1_760_000_003_000, runtime: 'pi' },
  ])

  it('writes the transcript, anchors it, and carries the tool result the text handoff would have dropped', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    managed.messages = carriedRows() as never

    const result = await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)

    expect(result.kind).toBe('connection-cross-runtime')
    const anchor = readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')
    expect(anchor).toBeTruthy()
    // Lowercase UUIDv4, which is what the SDK's own validator accepts and what
    // the file's basename has to be.
    expect(anchor).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    const filePath = await transcriptPathFor(managed, anchor!)
    expect(existsSync(filePath)).toBe(true)
    const records = readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)

    // Five records from four rows: the tool row becomes a call/result PAIR.
    expect(records).toHaveLength(5)
    expect(records.map(r => r.type)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant'])
    const serialized = JSON.stringify(records)
    // The fact that exists ONLY in a tool result — the thing `getRuntimeHandoffMessages`
    // drops on the floor, and the reason this task exists.
    expect(serialized).toContain('the fixture port is 8123')
    // §P.2(b): the intermediate assistant row crosses, unlike in the text tier.
    expect(serialized).toContain('reading it now')
    // OMIT, all of them.
    expect(serialized).not.toContain('compactMetadata')
    expect(serialized).not.toContain('"type":"system"')

    // The handoff stays ARMED across the write — the fail-safe. Nothing marks
    // it applied until `ClaudeAgent` sees the child reach `system`/`init` on
    // the rebuilt anchor.
    expect(managed.runtimeHandoffFrom).toBe('pi')
    expect(managed.runtimeHandoffApplied).toBe(false)
    expect(managed.runtimeHandoffPlan).toBe('native')

    rmSync(filePath, { force: true })
  })

  /**
   * **The trigger is `providerType`, not `AgentProvider`.** Both Claude cards
   * collapse onto `anthropic`, and `toProvider === 'anthropic'` is the exact
   * conflation T5 records as a trap. D8's decision to leave
   * `classifyRuntimeSwitch` alone only holds if BOTH cards are covered without
   * touching it — so both are driven here.
   */
  it('fires for the plain `anthropic` card too, not just `claude-runtime`', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    managed.messages = carriedRows() as never
    const byo = getLlmConnectionFn('anthropic-byo')
    expect(byo?.providerType).toBe('anthropic')

    const result = await manager.switchSessionRuntime(managed.id, 'anthropic-byo', managed.workspace.id)
    expect(result.kind).toBe('connection-cross-runtime')
    // P6.10 · this row asserted `text` and an ABSENT anchor until 2026-09-01,
    // and the reason was P3's collapsed `claude-*` arm rather than anything
    // about the providerType. `anthropic-byo` has no catalogue, so the model
    // cannot be carried and the session lands on `claude-sonnet-4-6` — whose
    // 200 000 window the SDK enforces itself. Four rows estimate a handful of
    // tokens, so the plan is `native` and the rebuild really does fire on the
    // plain card. The row is stronger for it: it now proves the behaviour it
    // was named for instead of proving a gate refused before reaching it.
    expect(managed.runtimeHandoffPlan).toBe('native')
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')).toBeTruthy()

    // The structural half: the trigger names BOTH providerTypes and does not
    // name `toProvider`.
    const start = sessionManagerSourceForRebuild.indexOf('  async switchSessionRuntime(')
    const end = sessionManagerSourceForRebuild.indexOf('  private async rebuildClaudeTranscriptForSwitch(')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const body = sessionManagerSourceForRebuild.slice(start, end)
    expect(body).toContain("target.providerType === 'claude-runtime' || target.providerType === 'anthropic'")
    // The conflation, absent — asserted with its own positive control, because
    // `.not.toContain` over a 300-line slice is otherwise the kind of assertion
    // that passes because the slice is wrong.
    expect(body).not.toContain("toProvider === 'anthropic'")
    expect(body).toContain('providerTypeToAgentProvider(target.providerType)')
    expect(body).toContain('rebuildClaudeTranscriptForSwitch')
  })

  /**
   * D7 — the rebuild never fires on a returning Claude leg.
   *
   * The planner answers `anchor` first, before size is even considered, so this
   * is normally settled before the wiring is reached. Both halves are asserted:
   * the plan the switch records, and the vendor's anchor left untouched. What
   * "always rebuild" would destroy is NOT recoverable — the SDK's own native
   * records for that session — which is why the decision went the other way.
   */
  it('does not rebuild when Claude already holds an anchor of its own (D7)', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'pi-shared',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      anchor: { provider: 'anthropic', id: 'claude-session-from-leg-1' },
    })
    managed.messages = carriedRows() as never

    const result = await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)

    expect(result.contextCarried).toBe('anchor-and-handoff')
    expect(managed.runtimeHandoffPlan).toBe('anchor')
    // The vendor's own transcript id survives, byte for byte.
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')).toBe('claude-session-from-leg-1')
  })

  it('does nothing at all on a `text` plan', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    // A transcript no window can hold: `text`, by the fit arm rather than by
    // the capability map.
    managed.messages = [
      { id: 'big', role: 'user', content: 'x'.repeat(4_000_000), timestamp: 1_760_000_000_000 },
    ] as never

    await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)

    expect(managed.runtimeHandoffPlan).toBe('text')
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')).toBeUndefined()
    // The text handoff is armed and unchanged — the tier is byte-identical to
    // what shipped before T2.
    expect(managed.runtimeHandoffFrom).toBe('pi')
  })

  /**
   * The failure path, which is the one that must never cost the user the
   * conversation. The switch is already past the point of no return when the
   * rebuild runs, so a converter failure leaves the armed TEXT handoff and no
   * anchor — R1's invariant: the rebuild or the text handoff, never both.
   */
  it('leaves the armed text handoff and no anchor when the write fails', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    managed.messages = carriedRows() as never
    const agent = await import('@nessy-agent/shared/agent')
    const configDir = agent.workspaceClaudeConfigDir(managed.workspace.id)!
    // Make the projects root un-creatable by putting a FILE where the directory
    // has to be. A real failure of the real writer, not a stubbed throw.
    const projects = join(configDir, 'projects')
    rmSync(projects, { recursive: true, force: true })
    writeFileSync(projects, 'not a directory')

    const result = await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)

    expect(result.kind).toBe('connection-cross-runtime')
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')).toBeUndefined()
    expect(managed.runtimeHandoffFrom).toBe('pi')
    expect(managed.runtimeHandoffApplied).toBe(false)
    // The session still switched — a converter failure is not a reason to leave
    // it runtime-less.
    expect(managed.llmConnection).toBe('claude-shared')

    rmSync(projects, { force: true })
  })

  /**
   * D6 · an attachment crosses as the text block our own agent already sends
   * every turn, resolved through the EXISTING realpath + containment +
   * stale-handle resolver. No image block is synthesized — 217 vendor
   * transcripts hold zero image blocks and zero base64, so there is no evidence
   * the SDK round-trips one written by us.
   *
   * Both arms, because the loss has to be visible: a file that resolves gets
   * its path, and one that is gone gets a marker the model can read rather than
   * silently disappearing.
   */
  it('carries attachments as a text reference, with a visible marker when the file is gone (D6)', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    // The RESOLVING arm: a real file inside the session's own storage root, so
    // the existing resolver's realpath + containment check both pass. Without
    // this row the test would only ever exercise the failure arm, which is how
    // "both arms" becomes a claim rather than a measurement.
    const sessions = await import('@nessy-agent/shared/sessions')
    const sessionDir = sessions.getSessionDirPath(managed.workspace.id, managed.id)
    mkdirSync(sessionDir, { recursive: true })
    const storedPath = join(sessionDir, 'notes.txt')
    writeFileSync(storedPath, 'the note body')
    // D4 · the IMAGE arm, which is the one whose loss has to be named: a live
    // turn sends this file as a real content block and the rebuild sends text.
    const imagePath = join(sessionDir, 'shot.png')
    writeFileSync(imagePath, 'not really a png, and the resolver does not care')

    managed.messages = [
      {
        id: 'a1',
        role: 'user',
        content: 'look at this',
        timestamp: 1_760_000_000_000,
        attachments: [
          { id: 'att-1', name: 'notes.txt', type: 'file', mimeType: 'text/plain', size: 13, storedPath },
          { id: 'att-2', name: 'gone.txt', type: 'file', mimeType: 'text/plain', size: 4, storedPath: '/nowhere/gone.txt' },
          { id: 'att-3', name: 'shot.png', type: 'image', mimeType: 'image/png', size: 48, storedPath: imagePath },
        ],
      },
      { id: 'a2', role: 'assistant', content: 'looked', timestamp: 1_760_000_001_000 },
    ] as never

    const result = await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)
    expect(result.kind).toBe('connection-cross-runtime')
    const anchor = readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')!
    const filePath = await transcriptPathFor(managed, anchor)
    const serialized = readFileSync(filePath, 'utf8')

    // The resolving arm: name AND the path the model can actually Read from.
    expect(serialized).toContain('[Attached file: notes.txt]')
    expect(serialized).toContain(`[Stored at: ${realpathSync(storedPath)}]`)
    // The failing arm: the resolver refuses a path outside the session root, so
    // the loss is NAMED rather than dropped — the model has to be able to tell
    // "there was a file and it is gone" from "there was no file".
    expect(serialized).toContain('[Attached file: gone.txt]')
    expect(serialized).toContain('[Unavailable: the stored copy could not be opened]')
    // The user's own words survive alongside both.
    expect(serialized).toContain('look at this')
    // No base64 and no image block is synthesized — 217 vendor transcripts hold
    // zero of either, so there is no evidence the SDK round-trips one we wrote.
    expect(serialized).not.toContain('"type":"image"')
    expect(serialized).not.toContain('base64')

    // D4 · the image arm reaches the transcript NAMED as an image, with the
    // path it can be recovered from and the sentence that says recovering it is
    // worth a tool call. `tools-reference.md#read-tool-behavior`: *"Images: PNG,
    // JPG, and other image formats are returned as visual content that Claude
    // can see, not as raw bytes."*
    expect(serialized).toContain('[Attached image: shot.png]')
    expect(serialized).toContain(`[Stored at: ${realpathSync(imagePath)}]`)
    expect(serialized).toContain(HANDOFF_IMAGE_NOTE)

    rmSync(filePath, { force: true })
    rmSync(storedPath, { force: true })
    rmSync(imagePath, { force: true })
  })
})

/**
 * T7 · a FIRST switch INTO Pi writes a Pi session file for the subprocess to
 * fork from.
 *
 * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`, T7,
 * unparked by owner gate G2 (2026-08-21).
 *
 * What is owned HERE is the wiring, exactly as the Claude block above owns its
 * own: the trigger, the file, the plan gate, the anchor rule, and the failure
 * path. What is NOT owned here: the entry envelope and the chaining, which are
 * `packages/shared/src/agent/__tests__/pi-session-rebuild.test.ts`'s against
 * upstream's own `buildContextEntries` / `sessionEntryToContextMessages`; and
 * the proof that a real Pi runtime forks the file, loads it and emits nothing
 * while doing so, which is
 * `packages/pi-agent-server/src/compat/pi-carry-session.test.ts` — with a
 * positive control, because "no events arrived" is otherwise the same
 * observation as "no listener was attached".
 *
 * **The direction is the point.** Every other row in this suite switches OFF
 * Pi; these switch ONTO it from Claude, because a first entry into Pi is the
 * one shape the matrix had no native carry for — the return leg already
 * resumes its own `.pi-sessions` sidecar through `RuntimeAnchorMap`.
 */
describe('a first switch into Pi rebuilds a Pi session file', () => {
  const carriedRows = () => ([
    { id: 'p1', role: 'user', content: 'read the config', timestamp: 1_760_000_000_000, runtime: 'anthropic' },
    { id: 'p2', role: 'assistant', content: 'reading it now', isIntermediate: true, timestamp: 1_760_000_001_000, runtime: 'anthropic' },
    {
      id: 'p3',
      role: 'tool',
      content: '',
      toolName: 'Read',
      toolStatus: 'completed',
      rawToolInput: { file_path: '/tmp/config.json' },
      rawToolResult: 'the fixture port is 8123',
      timestamp: 1_760_000_002_000,
      runtime: 'anthropic',
    },
    { id: 'p4', role: 'assistant', content: 'the port is 8123', timestamp: 1_760_000_003_000, runtime: 'anthropic' },
  ])

  async function carryPathFor(managed: ManagedForTest): Promise<string> {
    const agent = await import('@nessy-agent/shared/agent')
    return agent.piCarrySessionPath({ workspaceId: managed.workspace.id, sessionId: managed.id })
  }

  it('writes the carry session and carries the tool result the text handoff would have dropped', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'claude-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    managed.messages = carriedRows() as never

    const result = await manager.switchSessionRuntime(managed.id, 'pi-shared', managed.workspace.id)

    expect(result.kind).toBe('connection-cross-runtime')
    expect(managed.runtimeHandoffPlan).toBe('native')

    const filePath = await carryPathFor(managed)
    expect(existsSync(filePath)).toBe(true)
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)

    // Six lines from four rows: the header, then five entries — the tool row
    // becomes a call/result PAIR, which is the pairing every provider requires.
    expect(lines).toHaveLength(6)
    expect(lines[0]).toMatchObject({ type: 'session', version: 3 })
    expect(lines.slice(1).map(line => (line.message as { role: string }).role))
      .toEqual(['user', 'assistant', 'assistant', 'toolResult', 'assistant'])
    const serialized = JSON.stringify(lines)
    // The fact that exists ONLY in a tool result — what `getRuntimeHandoffMessages`
    // drops on the floor, and the reason this task exists.
    expect(serialized).toContain('the fixture port is 8123')
    // §P.2(b): the intermediate assistant row crosses, unlike in the text tier.
    expect(serialized).toContain('reading it now')

    // NO anchor is written. Pi resumes by DIRECTORY and `forkFrom` mints the id
    // of the session it will actually run — the subprocess reports that id back
    // and the ordinary anchor write records it. Claiming one here would make
    // the NEXT switch into Pi plan `anchor` against a session that never
    // existed.
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'pi')).toBeUndefined()

    // The handoff stays ARMED across the write — the fail-safe. Nothing marks
    // it applied until the subprocess reports `carriedHistory` on
    // `session_id_update`.
    expect(managed.runtimeHandoffFrom).toBe('anthropic')
    expect(managed.runtimeHandoffApplied).toBe(false)

    rmSync(filePath, { force: true })
  })

  /**
   * D7 — the rebuild never fires on a returning Pi leg, and `'pi'` is in
   * `ANCHORED_PROVIDERS` precisely so that a return HAS an anchor to find. The
   * planner answers `anchor` before size is even considered; what would be
   * destroyed otherwise is not recoverable — a second, newer file in
   * `.pi-sessions` orphans everything Pi actually did.
   */
  it('does not write a carry session when Pi already holds an anchor of its own (D7)', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'claude-shared',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      anchor: { provider: 'pi', id: 'pi-session-from-leg-1' },
    })
    managed.messages = carriedRows() as never

    const result = await manager.switchSessionRuntime(managed.id, 'pi-shared', managed.workspace.id)

    expect(result.contextCarried).toBe('anchor-and-handoff')
    expect(managed.runtimeHandoffPlan).toBe('anchor')
    expect(existsSync(await carryPathFor(managed))).toBe(false)
    // Pi's own session id survives, byte for byte.
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'pi')).toBe('pi-session-from-leg-1')
  })

  /**
   * The failure path. The switch is already past the point of no return when
   * the rebuild runs, so a writer failure leaves the armed TEXT handoff and no
   * carry file — R1's invariant, in the Pi arm: the rebuild or the text
   * handoff, never both.
   */
  it('leaves the armed text handoff when the write fails', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'claude-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    managed.messages = carriedRows() as never
    const filePath = await carryPathFor(managed)
    // Make the carry directory un-creatable by putting a FILE where it has to
    // be. A real failure of the real writer, not a stubbed throw.
    const carryDir = dirname(filePath)
    rmSync(carryDir, { recursive: true, force: true })
    mkdirSync(dirname(carryDir), { recursive: true })
    writeFileSync(carryDir, 'not a directory')

    const result = await manager.switchSessionRuntime(managed.id, 'pi-shared', managed.workspace.id)

    expect(result.kind).toBe('connection-cross-runtime')
    expect(managed.runtimeHandoffFrom).toBe('anthropic')
    expect(managed.runtimeHandoffApplied).toBe(false)
    // The session still switched — a converter failure is not a reason to
    // leave it runtime-less.
    expect(managed.llmConnection).toBe('pi-shared')
    // …and the durable notice records `text`, not the `native` the plan
    // decided, because `text` is what the armed handoff will actually deliver.
    const notice = (managed.messages as Array<{ role: string; content: string }>)
      .filter(row => row.role === 'info' && row.content.startsWith('runtime_switched:'))
      .at(-1)
    expect(notice?.content).toContain('"carry":"text"')

    rmSync(carryDir, { force: true })
  })

  /**
   * The structural half, and it is the mirror image of the Claude block's:
   * Claude's rebuild triggers on `providerType` because its two cards collapse
   * onto one `AgentProvider` and naming the provider would be the conflation T5
   * records; Pi's triggers on the collapsed provider because the file it writes
   * is keyed by the SESSION, so `pi` and `pi_compat` are the same question.
   * Asserting both here keeps the asymmetry deliberate rather than accidental.
   */
  it('triggers on the collapsed Pi provider, and the notice correction covers both rebuilds', () => {
    const start = sessionManagerSourceForRebuild.indexOf('  async switchSessionRuntime(')
    const end = sessionManagerSourceForRebuild.indexOf('  private async rebuildClaudeTranscriptForSwitch(')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const body = sessionManagerSourceForRebuild.slice(start, end)
    expect(body).toContain("historyCarry?.plan === 'native' && toProvider === 'pi'")
    expect(body).toContain('rebuildPiSessionForSwitch')
    // One correction, both arms: a planned rebuild that did not land records
    // `text` in the durable notice.
    expect(body).toContain('const rebuildPlanned = rebuildsClaudeTranscript || rebuildsPiSession')
    expect(body).toContain('rebuildPlanned && !rebuildLanded ? \'text\' : historyCarry?.plan')
  })
})

/**
 * R1 · what a crash mid-switch leaves behind, and what the next start does with
 * it.
 *
 * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`, R1 item 1.
 * The invariant is one sentence: **the next start either completes the rebuild
 * or falls back to the armed text handoff — never both, and never neither.**
 *
 * **The row's own model of the crash window is corrected here, and the
 * correction is the reason this block reads the way it does.** R1 says the next
 * start may see "an armed handoff + a possibly half-written transcript +
 * possibly a set anchor", which reads as three independent dials. Measured on
 * this tree: `switchSessionRuntime` has exactly ONE persistence point
 * (`persistSession` + `flushSession`, `SessionManager.ts`, immediately before it
 * builds its result), and it sits AFTER the arm, after the rebuild and after the
 * notice. So a process that dies anywhere inside the switch persists nothing at
 * all: the on-disk record is still pre-switch, nothing is armed, nothing is
 * owed, and the invariant holds vacuously — the only residue is an orphan
 * transcript, which is exactly what T8's retention class sweeps.
 *
 * What the next start CAN see is therefore the post-persist state, and the dials
 * that actually vary in it are two: **is the anchor set, and is a loadable
 * transcript at the path the spawn will use.** Those two produce the crash
 * shapes R1 names, and this block drives all four of them:
 *
 * | shape | anchor | transcript | owed |
 * | --- | --- | --- | --- |
 * | died before the write | unset | absent | text |
 * | died between the write and the rename | unset | only a `.tmp` sibling | text |
 * | died after the write, before the disarm | set | present | native |
 * | reopened after the transcript was swept | set | gone | text |
 *
 * **Both deciders are the shipped ones, and they live in different packages** —
 * which is the whole reason this is here rather than in either half's own
 * suite. `buildRuntimeHandoffPayload` is the body of the closure
 * `SessionManager` hands the backend; `ClaudeAgent.shouldSuppressTextHandoff` is
 * what the first turn asks. `claude-transcript-handoff-arm.test.ts` owns the
 * arm's own table; what is owned HERE is that a REAL switch, in each crash
 * shape, feeds that arm a state whose answer is one delivery and not two.
 */
describe('R1 · a crash mid-switch leaves the rebuild or the text handoff', () => {
  const carriedRows = () => ([
    { id: 'c1', role: 'user', content: 'what is the deploy fingerprint?', timestamp: 1_760_000_000_000, runtime: 'pi' },
    { id: 'c2', role: 'assistant', content: 'it is opal-lantern-77', timestamp: 1_760_000_001_000, runtime: 'pi' },
  ])

  type Delivery = 'native-transcript' | 'text' | 'none'

  /**
   * The first turn after the crash, as the two shipped deciders answer it.
   *
   * Deliberately NOT a re-implementation of `BaseAgent.chat`'s two lines — the
   * trap T1a paid for once, when a test restated the closure it was supposed to
   * be testing. The exclusive-or below is asserted against `base-agent.ts`'s own
   * source in the last row of this block, so the shape of this helper is bound
   * to the shipped composer rather than to a belief about it.
   */
  async function firstTurnAfterCrash(managed: ManagedForTest): Promise<{
    delivery: Delivery
    /** What the SHIPPED code reported through `markRuntimeHandoffApplied`. */
    reported: string[]
    /** Whether the armed handoff survives for a later turn. */
    stillArmed: boolean
  }> {
    const anchor = readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')
    const payload = buildRuntimeHandoffPayload({
      rows: managed.messages as never,
      from: managed.runtimeHandoffFrom as AgentProvider | undefined,
      applied: managed.runtimeHandoffApplied as boolean | undefined,
      target: 'anthropic',
      targetHasAnchor: Boolean(anchor),
      plan: managed.runtimeHandoffPlan as HistoryCarryPlan | undefined,
    })
    if (!payload) return { delivery: 'none', reported: [], stillArmed: false }

    const agentModule = await import('@nessy-agent/shared/agent')
    const reported: string[] = []
    const agent = new agentModule.ClaudeAgent({
      provider: 'anthropic',
      providerType: 'claude-runtime',
      connectionSlug: 'claude-shared',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      isHeadless: true,
      skipConfigWatcher: true,
      workspace: {
        id: managed.workspace.id,
        name: 'Runtime Switch Workspace',
        rootPath: workspaceRoot,
        workspaceRootPath: workspaceRoot,
        sessionRootPath: join(workspaceRoot, 'sessions'),
      },
      session: {
        id: managed.id,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        workingDirectory: workspaceRoot,
        // The anchor the switch persisted, which is what a fresh process reads
        // back as `sdkSessionId` — the resume target, and the only thing the
        // arm has to locate the rebuilt file with.
        ...(anchor ? { sdkSessionId: anchor } : {}),
      },
      markRuntimeHandoffApplied: (delivery = 'text') => { reported.push(delivery as string) },
    } as never)
    const arm = agent as unknown as {
      shouldSuppressTextHandoff(handoff: unknown): boolean
      confirmRebuiltTranscriptResume(reportedSessionId: string): void
      pendingRuntimeHandoff: unknown
    }
    try {
      if (!arm.shouldSuppressTextHandoff(payload)) {
        return { delivery: 'text', reported, stillArmed: true }
      }
      // The suppressed turn stashes the payload and the child then reaches
      // `system`/`init` on our anchor — the ONE signal that says the file was
      // opened (a resume the SDK cannot satisfy reports the same session id, so
      // the id is useless as a detector; measured in the resume e2e).
      arm.pendingRuntimeHandoff = payload
      arm.confirmRebuiltTranscriptResume(anchor!)
      return { delivery: 'native-transcript', reported, stillArmed: reported.length === 0 }
    } finally {
      try { agent.destroy() } catch { /* nothing to tear down */ }
    }
  }

  /** Assert the invariant itself, so no row can state half of it. */
  function expectExactlyOneDelivery(outcome: { delivery: Delivery; reported: string[] }, expected: Delivery): void {
    expect(outcome.delivery).toBe(expected)
    // NEVER NEITHER.
    expect(outcome.delivery).not.toBe('none')
    // NEVER BOTH — the native mark and the text mark cannot both be reported for
    // one arming, and a native turn reports exactly one.
    expect(outcome.reported.filter(entry => entry === 'native-transcript').length)
      .toBe(expected === 'native-transcript' ? 1 : 0)
    expect(outcome.reported).not.toContain('text')
  }

  /**
   * Shape 1 — died after the teardown, before the write.
   *
   * Reproduced through a real failure of the real writer rather than a stubbed
   * throw: a FILE where the projects root has to be, so `mkdirSync` cannot
   * create the directory. What the next start sees is the strictly HARDER
   * version of the crash (a `native` plan armed with no file to back it), which
   * is the state that would double the history if the arm trusted the plan
   * alone.
   */
  it('falls back to the text handoff when the write never happened', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    managed.messages = carriedRows() as never
    const agent = await import('@nessy-agent/shared/agent')
    const projects = join(agent.workspaceClaudeConfigDir(managed.workspace.id)!, 'projects')
    rmSync(projects, { recursive: true, force: true })
    writeFileSync(projects, 'not a directory')

    try {
      await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)

      expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')).toBeUndefined()
      expect(managed.runtimeHandoffFrom).toBe('pi')
      expect(managed.runtimeHandoffPlan).toBe('native')

      expectExactlyOneDelivery(await firstTurnAfterCrash(managed), 'text')

      // R1 item 2 · the DURABLE row must not promise what the next turn will not
      // keep. The plan said `native`; the rebuild did not land; the notice says
      // `text`, which is what actually crosses.
      const notice = (managed.messages as Array<{ content: string }>).at(-1)
      expect(notice?.content).toBe('runtime_switched:pi:anthropic:{"carry":"text"}')
    } finally {
      rmSync(projects, { force: true })
    }
  })

  /**
   * P3.102 · THE SAME REAL FAILURE, with an image in the transcript — the case
   * where the pointer was lost entirely, and the one a happy-path row misses.
   *
   * The rebuild arms are the only callers that ever passed
   * `attachmentBlock`, and they run only on a `native` plan. So on the shape
   * driven above — a `native` plan whose rebuild did NOT land — the delivery
   * falls through to the text leg, which carried no pointer at all: the user is
   * already losing the native carry and silently loses the image's path on top
   * of it. Exactly the moment they are least able to notice one more loss.
   *
   * Driven through the REAL failure the row above uses (a file where the
   * projects root must be, so `mkdirSync` cannot create the directory) and the
   * REAL resolver (`SessionManager.resolveHandoffAttachmentBlocks`, the same
   * private method the shipped closure calls), with the hook-withheld control
   * on the same managed session. The one line restated here is the hook itself,
   * and the row after this one pins that line against the shipped source.
   */
  it('P3.102 · the image pointer crosses on the text leg when the rebuild never happened', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    const sessions = await import('@nessy-agent/shared/sessions')
    const sessionDir = sessions.getSessionDirPath(managed.workspace.id, managed.id)
    mkdirSync(sessionDir, { recursive: true })
    const imagePath = join(sessionDir, 'shot.png')
    writeFileSync(imagePath, 'not really a png, and the resolver does not care')
    managed.messages = [
      {
        id: 'c1',
        role: 'user',
        content: 'what is wrong here?',
        timestamp: 1_760_000_000_000,
        runtime: 'pi',
        attachments: [{ id: 'att-1', name: 'shot.png', type: 'image', mimeType: 'image/png', size: 48, storedPath: imagePath }],
      },
      { id: 'c2', role: 'assistant', content: 'it is opal-lantern-77', timestamp: 1_760_000_001_000, runtime: 'pi' },
    ] as never

    const agent = await import('@nessy-agent/shared/agent')
    const projects = join(agent.workspaceClaudeConfigDir(managed.workspace.id)!, 'projects')
    rmSync(projects, { recursive: true, force: true })
    writeFileSync(projects, 'not a directory')

    try {
      await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)

      // The precondition this row is about: the rebuild did not land, the plan
      // is NOT downgraded (only the durable notice is), so the armed TEXT
      // handoff is what the first turn will deliver.
      expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')).toBeUndefined()
      expect(managed.runtimeHandoffPlan).toBe('native')
      expect((managed.messages as Array<{ content: string }>).at(-1)?.content)
        .toBe('runtime_switched:pi:anthropic:{"carry":"text"}')

      const readPayload = (withHook: boolean) => buildRuntimeHandoffPayload({
        rows: managed.messages as never,
        from: managed.runtimeHandoffFrom as AgentProvider | undefined,
        applied: managed.runtimeHandoffApplied as boolean | undefined,
        target: 'anthropic',
        targetHasAnchor: false,
        plan: managed.runtimeHandoffPlan as HistoryCarryPlan | undefined,
        ...(withHook
          ? {
              attachmentBlock: (row: { id?: string }) => {
                const blocks = (manager as unknown as {
                  resolveHandoffAttachmentBlocks(m: unknown): Map<string, string>
                }).resolveHandoffAttachmentBlocks(managed as never)
                return row.id ? blocks.get(row.id) : undefined
              },
            }
          : {}),
      })

      const carried = readPayload(true)!
      expect(carried.messages[0]!.content).toContain('what is wrong here?')
      expect(carried.messages[0]!.content).toContain('[Attached image: shot.png]')
      expect(carried.messages[0]!.content).toContain(`[Stored at: ${realpathSync(imagePath)}]`)
      expect(carried.messages[0]!.content).toContain(HANDOFF_IMAGE_NOTE)

      // CONTROL — the same real session, the same real failure, the hook
      // withheld: the shipped pre-P3.102 payload, in which the image is not
      // named, not pathed, and not even mentioned.
      expect(JSON.stringify(readPayload(false))).not.toContain('shot.png')
    } finally {
      rmSync(projects, { force: true })
      rmSync(imagePath, { force: true })
    }
  })

  /**
   * P3.102 · the hook is wired in the SHIPPED closure, not only in this suite.
   *
   * The behavioural row above restates one line — the hook — because
   * `getRuntimeHandoffMessages` is a local inside `getOrCreateAgentUnchecked`
   * and no test can call it. So the wiring is pinned structurally instead, with
   * its own positive control: the slice must be the closure's, and the closure
   * must pass `attachmentBlock` through the manager's own resolver.
   */
  it('P3.102 · the shipped handoff closure passes the attachment hook', () => {
    const start = sessionManagerSourceForRebuild.indexOf('const getRuntimeHandoffMessages = () => {')
    expect(start).toBeGreaterThan(0)
    const end = sessionManagerSourceForRebuild.indexOf('const markRuntimeHandoffApplied =', start)
    expect(end).toBeGreaterThan(start)
    const body = sessionManagerSourceForRebuild.slice(start, end)
    // The positive control for the slice: it really is the closure that builds
    // the payload, so a `.toContain` below is about the wiring and not about a
    // lucky substring somewhere else in a 20 000-line file.
    expect(body).toContain('buildRuntimeHandoffPayload({')
    expect(body).toContain('plan: managed.runtimeHandoffPlan')
    expect(body).toContain('attachmentBlock: row => {')
    expect(body).toContain('this.resolveHandoffAttachmentBlocks(managed)')
  })

  /**
   * Shape 2 — died between `writeFileSync(tmp)` and `renameSync`.
   *
   * The claim under test is the atomic write's: the REAL path never holds a
   * partial file, so a crash in that window is indistinguishable from a crash
   * before it. Driven twice, because the two halves fail differently — the
   * survivor state (a full `.tmp` sibling, no real file) must read as ABSENT to
   * the next start, and the writer itself must leave nothing behind when the
   * rename is the step that fails.
   */
  it('never leaves a partial transcript at the real path', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    managed.messages = carriedRows() as never
    const agentModule = await import('@nessy-agent/shared/agent')

    await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)
    const anchor = readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')!
    const filePath = await transcriptPathFor(managed, anchor)

    // The survivor state, byte for byte: the payload is on disk under the
    // temporary name the writer uses, and the real path does not exist.
    const temporary = `${filePath}.${process.pid}.crashsim.tmp`
    writeFileSync(temporary, readFileSync(filePath, 'utf8'))
    rmSync(filePath, { force: true })
    expect(existsSync(temporary)).toBe(true)
    expect(agentModule.claudeTranscriptIsLoadable(filePath)).toBe(false)

    expectExactlyOneDelivery(await firstTurnAfterCrash(managed), 'text')
    rmSync(temporary, { force: true })

    /*
     * The writer's own half, and it needs a DISCRIMINATOR rather than the
     * obvious assertion. "Make the write fail and check the real path is
     * clean" was the first version and it cannot fail: with the destination
     * occupied by a directory, a plain `writeFileSync(filePath)` throws too,
     * leaves nothing, and passes every one of those checks — measured by
     * replacing the tmp+rename pair with a direct write, which reddened
     * nothing. Atomicity is not observable single-threaded, so what is asserted
     * instead is the one behaviour that tells the two implementations apart:
     * `rename(2)` needs write permission on the DIRECTORY, `open(2)` needs it
     * on the FILE. A read-only destination is therefore replaced by a
     * rename-based writer and refused (EACCES) by a direct one. The same direct
     * write that survived the old assertions fails this.
     */
    const readOnlyTarget = `${filePath}.readonly`
    writeFileSync(readOnlyTarget, 'stale\n', { mode: 0o444 })
    const records = agentModule.buildClaudeTranscriptRecords({
      history: [{ kind: 'message', role: 'user', content: 'carried', timestamp: 1_760_000_000_000 }],
      cwd: workspaceRoot,
      sdkSessionId: agentModule.mintClaudeSdkSessionId(),
      version: '2.1.223',
    })
    expect(agentModule.writeClaudeTranscript(readOnlyTarget, records).records).toBe(1)
    expect(readFileSync(readOnlyTarget, 'utf8')).not.toContain('stale')
    // Nothing is left behind either way — a `.tmp` sibling that outlived the
    // call would be a leak the retention sweep does not name.
    expect(readdirSync(join(readOnlyTarget, '..')).filter(name => name.endsWith('.tmp'))).toEqual([])
    rmSync(readOnlyTarget, { force: true })
    rmSync(filePath, { force: true })
  })

  /**
   * Shape 3 — died after the write, before the disarm. The state T2 leaves on
   * purpose: `runtimeHandoffFrom` stays armed ACROSS the write, so the arm is
   * still owed when the next process starts, and the rebuilt transcript is
   * sitting at the path the spawn resolves to.
   *
   * This is the shape where "never both" is a real risk: the transcript
   * delivers the history AND the armed text handoff would deliver it again as a
   * quotation inside the same turn.
   */
  it('completes the rebuild — once — when the transcript survived the crash', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    managed.messages = carriedRows() as never

    await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)
    const anchor = readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')!
    const filePath = await transcriptPathFor(managed, anchor)
    expect(existsSync(filePath)).toBe(true)
    // Armed across the write — the state that makes the doubling possible.
    expect(managed.runtimeHandoffFrom).toBe('pi')
    expect(managed.runtimeHandoffApplied).toBe(false)

    const outcome = await firstTurnAfterCrash(managed)
    expectExactlyOneDelivery(outcome, 'native-transcript')
    expect(outcome.reported).toEqual(['native-transcript'])

    // …and the delivery is spent. `markRuntimeHandoffApplied` having fired is
    // what sets `applied`, and the shipped projection answers `null` for it —
    // so the text handoff cannot follow on any later turn.
    expect(buildRuntimeHandoffPayload({
      rows: managed.messages as never,
      from: undefined,
      applied: true,
      target: 'anthropic',
      targetHasAnchor: true,
      plan: 'native',
    })).toBeNull()

    expect((managed.messages as Array<{ content: string }>).at(-1)?.content)
      .toBe('runtime_switched:pi:anthropic:{"carry":"native"}')
    rmSync(filePath, { force: true })
  })

  /**
   * Shape 4 — the anchor outlives its file. Not hypothetical: T8 sweeps
   * `claude-config/projects` on the same `cleanupPeriodDays` cutoff as
   * everything else, so a session reopened after the retention window has an
   * anchor pointing at a transcript that is gone. NEVER NEITHER is the half
   * this row owns — the history has to still cross, as text.
   */
  it('falls back to text when the anchor outlived the transcript', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'pi-shared', model: 'tgpt/qwen35-397b-a17b-fp8' })
    managed.messages = carriedRows() as never

    await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)
    const anchor = readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')!
    const filePath = await transcriptPathFor(managed, anchor)

    // POSITIVE CONTROL, first: with the file there this same state delivers
    // natively, so the fallback below is the missing file and not the fixture.
    expectExactlyOneDelivery(await firstTurnAfterCrash(managed), 'native-transcript')

    rmSync(filePath, { force: true })
    expectExactlyOneDelivery(await firstTurnAfterCrash(managed), 'text')
    // The anchor is still set — this is exactly the "armed handoff + set anchor
    // + no file" state R1 names, and it resolves to text rather than to nothing.
    expect(readRuntimeAnchorFn(managed.sdkSessionAnchors as never, 'anthropic')).toBe(anchor)
  })

  /**
   * R1 item 2's third outcome family. A returning Claude leg plans `anchor`
   * (D7), and the durable notice has to say so: "the conversation was handed
   * over" is at its least true here, because the target resumes its own thread
   * and only the gap crosses.
   */
  it('records the anchor outcome in the notice on a returning leg', async () => {
    const { manager, managed } = createSwitchHarness({
      from: 'pi-shared',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      anchor: { provider: 'anthropic', id: 'claude-session-from-leg-1' },
    })
    managed.messages = carriedRows() as never

    const result = await manager.switchSessionRuntime(managed.id, 'claude-shared', managed.workspace.id)

    expect(result.contextCarried).toBe('anchor-and-handoff')
    expect((managed.messages as Array<{ content: string }>).at(-1)?.content)
      .toBe('runtime_switched:pi:anthropic:{"carry":"anchor"}')
  })

  /**
   * The helper above models the first turn as an EXCLUSIVE OR — suppressed, or
   * the text block. That model is only worth anything if it is the shipped
   * composer's, so it is asserted against `base-agent.ts` itself rather than
   * believed. Each `.toContain` carries the line that makes it exclusive: the
   * text block is built on `!suppressTextHandoff` and marked in that same
   * branch, so no turn can compose both.
   */
  it('is the same exclusive-or `BaseAgent.chat` composes', () => {
    const baseAgentSource = readFileSync(
      fileURLToPath(new URL('../../../../../packages/shared/src/agent/base-agent.ts', import.meta.url)),
      'utf8',
    )
    expect(baseAgentSource)
      .toContain('const suppressTextHandoff = handoff !== null && this.shouldSuppressTextHandoff(handoff);')
    expect(baseAgentSource).toContain('const runtimeHandoffContext = handoff && !suppressTextHandoff')
    expect(baseAgentSource).toContain("this.config.markRuntimeHandoffApplied?.('text');")
    // The stash is what a suppressed turn hands the native path, and it is set
    // from the SAME predicate — a second, independently-computed condition here
    // is how "never both" would come apart.
    expect(baseAgentSource).toContain('this.pendingRuntimeHandoff = suppressTextHandoff ? handoff : null;')
  })
})

/**
 * T8 (d). `clearRuntimeScopedSessionState` drops the cron service so the timer
 * cannot outlive the runtime that armed it, and the record's survival comes from
 * the on-disk store. What used to put the service BACK was `getOrCreateAgent`,
 * which runs on the next TURN — so a user who switched runtimes and walked away
 * got nothing until they typed. T6 watched that deferral live on codex.
 */
describe('the scheduler is re-armed by the switch itself, not by the next turn', () => {
  const cronKey = (managed: ManagedForTest) => `${managed.workspace.id}:${managed.id}`
  const cronServices = (manager: ManagerInstance) =>
    (manager as unknown as {
      sessionCronServices: Map<string, { list(): readonly { id: string; prompt: string }[]; stop(): void }>
    }).sessionCronServices
  const cronService = (manager: ManagerInstance, managed: ManagedForTest) =>
    (manager as unknown as {
      getOrCreateSessionCronService(managed: unknown): {
        create(input: { schedule: string; recurring: boolean; prompt: string }): { id: string }
      } | undefined
    }).getOrCreateSessionCronService(managed)!

  it('a cross-runtime switch leaves a live service holding the restored record', async () => {
    const { manager, managed } = createSwitchHarness()
    const record = cronService(manager, managed)
      .create({ schedule: '0 9 * * *', recurring: true, prompt: 'survives the switch' })
    const before = cronServices(manager).get(cronKey(managed))
    expect(before).toBeDefined()

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-cross-runtime')

    // No agent has been built and no turn has run. The service is nonetheless
    // there — a NEW one, over the same store, restored and ticking.
    const after = cronServices(manager).get(cronKey(managed))
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
    expect(after!.list().map(entry => entry.id)).toEqual([record.id])
    expect(after!.list().map(entry => entry.prompt)).toEqual(['survives the switch'])
    after!.stop()
  })

  // The control: a SAME-runtime switch never tears the service down, so the
  // re-arm must be a no-op there rather than a blind replacement — a rebuilt
  // service would drop the pending queue of a scheduler that was still running.
  it('a same-runtime switch keeps the service it already had', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'claude-max' })
    const before = cronService(manager, managed)
    cronServices(manager).get(cronKey(managed))

    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-same-runtime')
    expect(cronServices(manager).get(cronKey(managed))).toBe(before as never)
    cronServices(manager).get(cronKey(managed))!.stop()
  })
})

/**
 * P6.105 — codex's own thread store stays empty BY RULING, and the switch says so.
 *
 * The owner ruled the containment closed (2026-09-02, on P2.371), so the whole
 * residue was honesty: a user who moves to codex and finds its native session
 * browser empty had nothing telling them that emptiness is a decision. Codex
 * publishes `thread/list`/`thread/read`/`thread/archive`/`thread/unarchive`/
 * `thread/delete` and both are unusable as we drive it — the `CODEX_HOME` is
 * `mkdtempSync`ed per session and `rmSync`ed with it, and `thread/read` answers
 * `turns: []` for threads we populate by injection.
 */
describe('P6.105 · the switch states codex\'s empty thread store as a consequence', () => {
  const captureInfo = (manager: ManagerInstance): string[] => {
    const lines: string[] = []
    const original = (manager as unknown as Record<string, unknown>).sendEvent as (...args: unknown[]) => unknown
    ;(manager as unknown as Record<string, unknown>).sendEvent = (event: { type?: string; message?: string }, ...rest: unknown[]) => {
      if (event?.type === 'info' && typeof event.message === 'string') lines.push(event.message)
      return original.call(manager, event, ...rest)
    }
    return lines
  }

  it('names the containment once when the session moves onto codex', async () => {
    const { manager, managed } = createSwitchHarness()
    const lines = captureInfo(manager)

    await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)

    const said = lines.filter(line => line.includes('Codex keeps its own list of past conversations'))
    expect(said).toHaveLength(1)
    // The sentence has to carry BOTH halves or it is a bare absence again: why
    // the native store is empty, and where the history actually is.
    expect(said[0]).toContain('deleted when the session ends')
    expect(said[0]).toContain('kept by Nessy itself')

    // Once per session: switching away and back must not restate a standing
    // property of how this app runs codex.
    await manager.switchSessionRuntime(managed.id, 'pi-source', managed.workspace.id)
    await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    expect(lines.filter(line => line.includes('Codex keeps its own list of past conversations'))).toHaveLength(1)
  })

  /**
   * The negative control, and the one that makes the row a verdict rather than
   * a blanket line: a switch onto a runtime whose own store is not contained
   * this way says nothing. Pi and claude both keep durable state of their own.
   */
  it('says nothing when the target is not codex', async () => {
    const { manager, managed } = createSwitchHarness()
    const lines = captureInfo(manager)

    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(lines.filter(line => line.includes('Codex keeps its own list of past conversations'))).toEqual([])
    expect((managed as unknown as { codexThreadStoreReported?: boolean }).codexThreadStoreReported).toBeUndefined()

    // POSITIVE CONTROL on the same rig and the same capture: moving this very
    // session onto codex DOES produce the line. Without it "the capture saw
    // nothing" and "the capture is a dead sink" are the same observation.
    await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    expect(lines.filter(line => line.includes('Codex keeps its own list of past conversations'))).toHaveLength(1)
  })
})

/**
 * P6.161 — which model an alias-pinned agent will actually run on, said at the
 * SWITCH rather than when that agent next happens to run.
 *
 * The arm that was already honest is the DROP: a declared model the target
 * cannot serve is substituted by `resolvedModelField` with an `onDiagnostic`
 * line the claude turn yields as a warning. The arm that is silent is the
 * ALIAS, and P6.160 is why — an alias with a seeded `ANTHROPIC_DEFAULT_*_MODEL`
 * behind it is ADMITTED and returns early with no diagnostic at all, so an
 * agent pinned to `opus` registers as `opus`, resolves inside the child to the
 * session model, and nothing says so at turn time either.
 */
describe('P6.161 · the switch names the model an alias-pinned agent will run on', () => {
  const captureWarnings = (manager: ManagerInstance): string[] => {
    const lines: string[] = []
    const original = (manager as unknown as Record<string, unknown>).sendEvent as (...args: unknown[]) => unknown
    ;(manager as unknown as Record<string, unknown>).sendEvent = (
      event: { type?: string; message?: string }, ...rest: unknown[]
    ) => {
      if (event?.type === 'info' && typeof event.message === 'string') lines.push(event.message)
      return original.call(manager, event, ...rest)
    }
    return lines
  }

  /** The outgoing pinned view, which is where the DECLARATIONS live. */
  const withAgents = (managed: ManagedForTest, agents: Array<{ name: string; model?: string }>): void => {
    ;(managed as unknown as { capabilityRuntime?: unknown }).capabilityRuntime = {
      view: {
        agents: agents.map(agent => ({
          key: `plugin://test/agent.${agent.name}`,
          name: agent.name,
          // Spread-conditional rather than `...agent`: an explicit `model:
          // undefined` is a DECLARED key, and `aliasPinnedAgentsInView` reads
          // the field's presence as well as its value.
          ...(agent.model ? { model: agent.model } : {}),
        })),
        // `describeCapabilityDelta` reads these three off the same view.
        hooks: [], monitors: [], lspServers: [],
      },
    }
  }

  const aliasLines = (lines: readonly string[]): string[] =>
    lines.filter(line => line.includes('Model aliases mean something else here'))

  it('names the agent, its alias and the model the alias resolves to', async () => {
    const { manager, managed } = createSwitchHarness()
    withAgents(managed, [{ name: 'reviewer', model: 'opus' }])
    const lines = captureWarnings(manager)

    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    const said = aliasLines(lines)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('reviewer')
    expect(said[0]).toContain('"opus"')
    // The model the session actually landed on — the value the alias is seeded
    // to — rather than the one it was on before the switch.
    expect(managed.model).toBe('claude-gw-model-a')
    expect(said[0]).toContain('claude-gw-model-a')
  })

  it('says nothing when no agent pins an alias', async () => {
    const { manager, managed } = createSwitchHarness()
    // One agent inheriting, one pinned to a model the target genuinely serves.
    // Neither is an alias, so neither is this row's subject: the served id needs
    // no substitution, and an UNSERVED id is the arm `resolvedModelField`
    // already warns about at turn time.
    withAgents(managed, [{ name: 'inheritor' }, { name: 'pinned', model: 'claude-gw-model-b' }])
    const lines = captureWarnings(manager)

    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)

    expect(aliasLines(lines)).toEqual([])
  })

  it('says nothing on a direct anthropic connection, where the SDK resolves its own aliases', async () => {
    const { manager, managed } = createSwitchHarness()
    withAgents(managed, [{ name: 'reviewer', model: 'opus' }])
    const lines = captureWarnings(manager)

    // `claude-max` is `providerType: 'anthropic'`: the SDK resolves `opus`
    // against its own catalogue, correctly, and claiming a divergence here would
    // be the false alarm this gate exists to avoid.
    await manager.switchSessionRuntime(managed.id, 'claude-max', managed.workspace.id)
    expect(aliasLines(lines)).toEqual([])

    // POSITIVE CONTROL on the same rig and the same capture: the identical view
    // moved onto a `claude-runtime` connection DOES produce the line, so the
    // empty list above is a verdict and not a dead sink.
    withAgents(managed, [{ name: 'reviewer', model: 'opus' }])
    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(aliasLines(lines)).toHaveLength(1)
  })
})

/**
 * F1.555 (origin WJ-ay proposed row 2, 2026-09-24) — F1.499 (3)'s runtime-switch
 * half, DRIVEN through this harness. hooks.md#messagedisplay-input: "Each message
 * has exactly one final batch". F1.499 (3) closes an open `MessageDisplay` cursor
 * inside `switchSessionRuntime` BEFORE `strictDrainSessionForMutation`, because
 * the drain disposes the agent runtime and `agentAutomationSystem` with it; until
 * this block that order was pinned on the SOURCE only
 * (`message-display-reset-final.test.ts`), whose rewind arm is the driven twin.
 *
 * The session carries an idle agent (`isProcessing: false`), so the REAL drain
 * takes its disposing branch and the hook system the batches went to is gone
 * after it — asserted, because that is the premise the close's position rests on.
 * The CONTROL replaces the pre-drain close with the bare cursor drop it replaced:
 * no final batch arrives at all, so removing the close fails the first arm.
 */
describe('F1.555 · a runtime switch closes the open MessageDisplay message with its one final batch', () => {
  type SdkAutomationInput = import('@nessy-agent/shared/automations').SdkAutomationInput
  type AgentEvent = import('@nessy-agent/shared/automations').AgentEvent
  type Internals = {
    processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
    flushDelta(sessionId: string, workspaceId: string): Promise<void>
  }

  function withMessageDisplayHook(managed: ManagedForTest): { inputs: SdkAutomationInput[]; system: unknown } {
    const inputs: SdkAutomationInput[] = []
    const system = {
      executeAgentEvent: async (event: AgentEvent, input: SdkAutomationInput) => {
        if (event === 'MessageDisplay') inputs.push(input)
        return { matchedCount: 1 }
      },
      hasAgentEventMatchers: (event: AgentEvent) => event === 'MessageDisplay',
    }
    managed.agentAutomationSystem = system
    return { inputs, system }
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  const finals = (inputs: SdkAutomationInput[]) =>
    inputs.filter(input => input.final === true).map(input => ({ index: input.index, delta: input.delta }))

  /** A message the hook has SEEN one batch of, left open (a Stop mid-message). */
  async function openSeenMessage(manager: ManagerInstance, managed: ManagedForTest): Promise<void> {
    const internals = manager as unknown as Internals
    await internals.processEvent(managed, { type: 'text_delta', text: 'Half a line\n', turnId: 'turn-1__m0' })
    await internals.flushDelta(managed.id, managed.workspace.id)
  }

  for (const [label, from, to] of [
    ['cross-runtime', 'pi-source', 'claude-gateway'],
    ['same-runtime', 'claude-max', 'claude-gateway'],
  ] as const) {
    it(`${label} switch: exactly one empty final batch at the next index, for the same message`, async () => {
      const { manager, managed } = createSwitchHarness({ from, isProcessing: false })
      const { inputs, system } = withMessageDisplayHook(managed)
      await openSeenMessage(manager, managed)
      // Fixture control: the hook saw the message's first batch, not its end.
      expect(inputs.map(input => ({ index: input.index, final: input.final }))).toEqual([{ index: 0, final: false }])

      const result = await manager.switchSessionRuntime(managed.id, to, managed.workspace.id)
      await settle()

      expect(result.kind).toBe(label === 'cross-runtime' ? 'connection-cross-runtime' : 'connection-same-runtime')
      expect(finals(inputs)).toEqual([{ index: 1, delta: '' }])
      expect(new Set(inputs.map(input => input.message_id)).size).toBe(1)
      expect(managed.messageDisplayCursor).toBeUndefined()
      // The premise: the drain took the hook system that saw the batches with it.
      expect(managed.agentAutomationSystem).not.toBe(system)
    })
  }

  it('BOUNDARY: a switch over a message the hook never saw fires nothing', async () => {
    const { manager, managed } = createSwitchHarness({ isProcessing: false })
    const { inputs } = withMessageDisplayHook(managed)
    // No newline and no flush: the whole-lines hold keeps it back, so the hook saw nothing.
    await (manager as unknown as Internals).processEvent(managed, { type: 'text_delta', text: 'Partial', turnId: 'turn-1__m0' })
    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    await settle()
    expect(inputs).toEqual([])
  })

  it('CONTROL: with the pre-drain close replaced by a bare cursor drop, NO final batch arrives', async () => {
    const { manager, managed } = createSwitchHarness({ isProcessing: false })
    const { inputs } = withMessageDisplayHook(managed)
    await openSeenMessage(manager, managed)
    ;(manager as unknown as Record<string, unknown>).closeVoidedMessageDisplay = (m: ManagedForTest) => {
      m.messageDisplayCursor = undefined
    }
    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    await settle()
    expect(inputs.map(input => ({ index: input.index, final: input.final }))).toEqual([{ index: 0, final: false }])
    expect(finals(inputs)).toEqual([])
  })
})
