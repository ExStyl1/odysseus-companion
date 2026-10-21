/**
 * T1 — the session cron service and scheduled delivery are no longer Pi-only.
 *
 * Two gates used to spell "Pi" directly: the construction gate in
 * `getOrCreateAgent` (`provider === 'pi' ? this.getOrCreatePiCronService(…)`)
 * and the producer gate in `deliverPiMonitorEvent`. Both now read one exported
 * set, `SCHEDULED_DELIVERY_RUNTIMES`, so a claude-runtime or codex-runtime
 * session owns a scheduler and its fires reach the same between-turns delivery
 * gate a Pi session's do.
 *
 * What is deliberately NOT widened is the SINK (`deliverMonitorEvent`): three of
 * its five producers are live beyond Pi (R86's background-task completion on
 * every runtime but claude, whose CLI hands the end to the model itself —
 * F1.492), so the gate stays on the two scheduling producers.
 * `runtime-switch-session.test.ts` keeps that control.
 *
 * Interim, until T3/T5 project the five tools: a self-paced record restored onto
 * a non-Pi runtime fires its first iteration, finds no `ScheduleWakeup`, and
 * ends at the 20-minute fallback. Recorded in the plan row; not a defect here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider } from '@nessy-agent/shared/agent'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// CONFIG_DIR freezes at the first import of `config/paths.ts`, which the repo's
// `[test].preload` has already triggered by the time this module body runs — so
// the connections are written INTO the frozen dir in `beforeAll` and whatever
// was there is restored in `afterAll`. Same discipline as
// `runtime-switch-session.test.ts`.
const stateRoot = mkdtempSync(join(tmpdir(), 'sm-scheduled-delivery-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-scheduled-delivery'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Scheduled Delivery Workspace',
    slug: 'scheduled-delivery-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

/**
 * One connection per `providerTypeToAgentProvider` outcome that a session can
 * actually be on. `claude-runtime` and `anthropic` both resolve to `'anthropic'`
 * — the gateway card is the one a user reaches, so it is the fixture — and
 * `nestor-cloud-agent` is the provider OUTSIDE the set, i.e. the negative
 * control without which every row below would pass on a blanket `true`.
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
type ManagerInstance = InstanceType<SessionManagerModule['SessionManager']>
type ManagedForTest = Record<string, unknown> & { id: string; workspace: { id: string } }

let createManagedSessionFn: SessionManagerModule['createManagedSession']
let createTestSessionManagerFn: typeof import('./test-session-manager.ts')['createTestSessionManager']
let scheduledDeliveryRuntimes: readonly AgentProvider[]

let restoreConfig: () => void = () => {}

beforeAll(async () => {
  const mod = await import('../SessionManager.ts')
  createManagedSessionFn = mod.createManagedSession
  scheduledDeliveryRuntimes = mod.SCHEDULED_DELIVERY_RUNTIMES
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

let sessionCounter = 0

interface Internals {
  sessions: Map<string, unknown>
  sessionCronServices: Map<string, { list(): readonly { prompt: string }[]; stop(): void }>
  resolveManagedProvider(managed: unknown): AgentProvider
  getOrCreateSessionCronService(managed: unknown): {
    create(input: { schedule: string; recurring: boolean; prompt: string }): { id: string }
    list(): readonly { id: string; prompt: string }[]
  } | undefined
  deliverScheduledMonitorEvent(delivery: unknown): void
  buildHookTaskRegistryPort(managed: unknown): { sessionCrons(): readonly { prompt: string }[] }
  clearRuntimeScopedSessionState(managed: unknown, fromProvider: AgentProvider): void
  sendMessage(...args: unknown[]): Promise<void>
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  flushSession(sessionId: string, workspaceId?: string): Promise<void>
}

function harness(options: { from: string; withUserMessage?: boolean } = { from: 'pi-source' }) {
  const manager = createTestSessionManagerFn()
  const internals = manager as unknown as Internals
  const workspace = {
    id: WORKSPACE_ID,
    name: 'Scheduled Delivery Workspace',
    slug: 'scheduled-delivery-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const id = `session-scheduled-${++sessionCounter}`
  const managed = createManagedSessionFn(
    { id, name: id, llmConnection: options.from },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  ) as unknown as ManagedForTest
  if (options.withUserMessage) {
    ;(managed.messages as unknown[]).push({
      id: 'user-0', role: 'user', content: 'hello', timestamp: 0,
    })
  }
  internals.sessions.set(`${workspace.id}:${id}`, managed)

  // Only the turn machinery below `sendMessage` is stubbed; every routing
  // decision under test is the production one.
  const sent: string[] = []
  internals.sendMessage = async (...args: unknown[]) => { sent.push(String(args[1])) }
  internals.sendEvent = () => undefined
  internals.persistSession = () => undefined
  internals.flushSession = async () => undefined

  return { manager: manager as ManagerInstance, internals, managed, sent }
}

const delivery = (managed: ManagedForTest) => ({
  sessionKey: { workspaceId: managed.workspace.id, sessionId: managed.id },
  taskId: `cron-${managed.id}`,
  text: 'scheduled prompt fired',
})

describe('SCHEDULED_DELIVERY_RUNTIMES', () => {
  // The literals are read off `resolveManagedProvider`'s own return type, not
  // guessed: `providerTypeToAgentProvider` folds `claude-runtime` into
  // `'anthropic'`, so the set has three members and not four.
  it('is exactly the three coding runtimes', () => {
    expect([...scheduledDeliveryRuntimes].sort()).toEqual(['anthropic', 'codex-runtime', 'pi'])
  })

  // The set is only correct if it matches what `resolveManagedProvider` actually
  // returns for the cards these sessions run on — the sort of coupling that
  // rots silently when a provider literal is renamed.
  it('matches what resolveManagedProvider returns for each card', () => {
    for (const [slug, expected] of [
      ['pi-source', 'pi'],
      ['claude-gateway', 'anthropic'],
      ['codex-gateway', 'codex-runtime'],
    ] as const) {
      const { internals, managed } = harness({ from: slug })
      expect(internals.resolveManagedProvider(managed)).toBe(expected)
      expect(scheduledDeliveryRuntimes).toContain(expected)
    }
    const { internals, managed } = harness({ from: 'nestor-cloud' })
    expect(internals.resolveManagedProvider(managed)).toBe('nestor-cloud-agent')
    expect(scheduledDeliveryRuntimes).not.toContain('nestor-cloud-agent')
  })
})

describe('the cron service is built for every scheduled-delivery runtime', () => {
  it('a claude-runtime session gets a service, and CronList reads its records', () => {
    const { internals, managed } = harness({ from: 'claude-gateway' })
    const service = internals.getOrCreateSessionCronService(managed)
    expect(service).toBeDefined()
    service!.create({ schedule: '0 9 * * *', recurring: true, prompt: 'daily standup' })
    // `CronList` reads `cronPort.list()`, which is this exact call.
    expect(service!.list().map(record => record.prompt)).toEqual(['daily standup'])
    // …and the service is registered under the composite key every other
    // SessionManager surface looks it up by — the hook registry's
    // `session_crons` reader is the one that is not a test seam.
    expect(internals.sessionCronServices.has(`${managed.workspace.id}:${managed.id}`)).toBe(true)
    expect(internals.buildHookTaskRegistryPort(managed).sessionCrons().map(entry => entry.prompt))
      .toEqual(['daily standup'])
  })

  it('a codex-runtime session gets one too', () => {
    const { internals, managed } = harness({ from: 'codex-gateway' })
    expect(internals.getOrCreateSessionCronService(managed)).toBeDefined()
  })

  // The positive control that keeps the row above from passing on a blanket
  // "always build one".
  it('is one service per session, not one per call', () => {
    const { internals, managed } = harness({ from: 'claude-gateway' })
    const first = internals.getOrCreateSessionCronService(managed)
    expect(internals.getOrCreateSessionCronService(managed)).toBe(first!)
  })
})

describe('scheduled delivery', () => {
  it('queues a fire into pendingTaskNotifications while the session is busy', () => {
    const { internals, managed } = harness({ from: 'claude-gateway', withUserMessage: true })
    managed.isProcessing = true
    internals.deliverScheduledMonitorEvent(delivery(managed))
    expect(managed.pendingTaskNotifications).toEqual(['scheduled prompt fired'])
  })

  it('starts a turn on an idle claude-runtime session', async () => {
    const { internals, managed, sent } = harness({ from: 'claude-gateway', withUserMessage: true })
    internals.deliverScheduledMonitorEvent(delivery(managed))
    // `deliverMonitorEvent` is async behind the void call; let it settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('scheduled prompt fired')
    expect(managed.pendingTaskNotifications).toBeUndefined()
  })

  it('starts a turn on an idle codex-runtime session', async () => {
    const { internals, managed, sent } = harness({ from: 'codex-gateway', withUserMessage: true })
    internals.deliverScheduledMonitorEvent(delivery(managed))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toHaveLength(1)
  })

  // The negative control. Without it every row above passes on a producer gate
  // that was simply deleted rather than widened.
  it('still drops a fire on a provider outside the set', () => {
    const { internals, managed, sent } = harness({ from: 'nestor-cloud', withUserMessage: true })
    internals.deliverScheduledMonitorEvent(delivery(managed))
    expect(managed.pendingTaskNotifications).toBeUndefined()
    expect(sent).toHaveLength(0)
  })
})

describe('cron records survive a runtime switch', () => {
  /**
   * D5. The switch teardown keeps stop + delete — the timer must not outlive the
   * runtime that armed it — and survival comes from the STORE: the new runtime's
   * agent build re-creates the service through the same
   * `getOrCreateSessionCronService`, whose `restore()` re-arms every unexpired
   * record it finds on disk.
   */
  it('re-creating the service after the teardown restores the record from disk', () => {
    const { internals, managed } = harness({ from: 'pi-source' })
    const before = internals.getOrCreateSessionCronService(managed)!
    const record = before.create({ schedule: '0 9 * * *', recurring: true, prompt: 'survives the switch' })

    internals.clearRuntimeScopedSessionState(managed, 'pi')
    expect(internals.sessionCronServices.has(`${managed.workspace.id}:${managed.id}`)).toBe(false)

    // The session is now on the Claude card, exactly as `switchSessionRuntime`
    // leaves it before the next agent build.
    managed.llmConnection = 'claude-gateway'
    const after = internals.getOrCreateSessionCronService(managed)!
    expect(after).not.toBe(before)
    expect(after.list().map(entry => entry.id)).toEqual([record.id])
    expect(after.list().map(entry => entry.prompt)).toEqual(['survives the switch'])
  })
})
