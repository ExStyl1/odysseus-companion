/**
 * T3 — the host half of the Claude projection.
 *
 * T1 proved a claude-runtime session OWNS a cron service and that the hook
 * registry can read its records. What T3 adds is the PORT over that service and
 * its second binding: `pi-agent.ts` takes it through `BackendConfig.cronPort`,
 * and the Claude adapter — which builds its tool context in-process — resolves
 * `ctx.cronPort` from the per-session callback registry instead. One builder
 * feeds both, because two copies of that literal is how one of them acquires a
 * fix the other does not.
 *
 * Two kinds of row here, deliberately:
 *
 * - Behavioural rows drive `buildSessionCronPort` over a REAL
 *   `SessionCronService` for a real claude-gateway session, so what is measured
 *   is the store, not a fake.
 * - Two wiring rows read `SessionManager.ts` as TEXT, following the pattern
 *   `runtime-capability-drift.test.ts` established for sites that are only
 *   reachable that way: both bindings live inside `getOrCreateAgentUnchecked`,
 *   which a unit test cannot drive without constructing an agent. Each carries a
 *   positive control so an emptied or moved file cannot read as a pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionCronPort } from '@nessy-agent/session-tools-core'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const stateRoot = mkdtempSync(join(tmpdir(), 'sm-claude-cron-port-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-claude-cron-port'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Claude Cron Port Workspace',
    slug: 'claude-cron-port-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

const TEST_CONNECTIONS = [
  {
    slug: 'claude-gateway',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'bearer_token',
    defaultModel: 'claude-gw-model-a',
    createdAt: Date.now(),
  },
] as unknown as NonNullable<StoredConfig['llmConnections']>

type SessionManagerModule = typeof import('../SessionManager.ts')
type ManagedForTest = Record<string, unknown> & { id: string; workspace: { id: string } }

interface Internals {
  sessions: Map<string, unknown>
  getOrCreateSessionCronService(managed: unknown): {
    list(): readonly { id: string; prompt: string; dynamic?: boolean }[]
    stop(): void
  } | undefined
  buildSessionCronPort(managed: unknown, service: unknown): SessionCronPort
  persistSession(managed: unknown, immediate?: boolean): void
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
  storage.saveConfig({ ...base, defaultLlmConnection: 'claude-gateway', llmConnections: TEST_CONNECTIONS })
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

function claudeSession() {
  const manager = createTestSessionManagerFn()
  const internals = manager as unknown as Internals
  const workspace = {
    id: WORKSPACE_ID,
    name: 'Claude Cron Port Workspace',
    slug: 'claude-cron-port-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const id = `session-claude-cron-${++sessionCounter}`
  const managed = createManagedSessionFn(
    { id, name: id, llmConnection: 'claude-gateway' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  ) as unknown as ManagedForTest
  internals.sessions.set(`${workspace.id}:${id}`, managed)
  internals.persistSession = () => undefined

  const service = internals.getOrCreateSessionCronService(managed)
  if (!service) throw new Error('a claude-gateway session must get a cron service (T1)')
  return { internals, managed, service, port: internals.buildSessionCronPort(managed, service) }
}

describe('buildSessionCronPort over a claude-runtime session', () => {
  it('creates, lists and removes against the session\'s own store', async () => {
    const { port, service } = claudeSession()

    const created = await port.create({ schedule: '0 9 * * *', recurring: true, prompt: 'daily standup' })
    expect(created.prompt).toBe('daily standup')
    // `:168` — the store owns the 8-character id, not the tool.
    expect(created.id).toHaveLength(8)
    // The port is a description of the request; the RECORD is the store's, so
    // reading the service directly is what proves the two are the same object.
    expect(service.list().map(record => record.prompt)).toEqual(['daily standup'])

    expect((await port.list()).map(record => record.prompt)).toEqual(['daily standup'])
    expect(await port.remove(created.id)).toBe(true)
    expect(service.list()).toEqual([])
    // Removing what is not there answers false rather than throwing — the
    // negative control for the row above.
    expect(await port.remove(created.id)).toBe(false)
  })

  it('refuses a fixed CronCreate with no schedule, and accepts a self-paced one', async () => {
    const { port, service } = claudeSession()
    await expect(port.create({ recurring: false, prompt: 'no schedule' })).rejects.toThrow(
      'CronCreate needs a schedule unless dynamic is true.',
    )
    expect(service.list()).toEqual([])

    const loop = await port.create({ dynamic: true, recurring: true, prompt: 'keep going' })
    expect(service.list().map(record => record.id)).toEqual([loop.id])
    expect(service.list()[0]?.dynamic).toBe(true)
  })

  // R39 — the wakeup slot addresses THE session's dynamic record; `ScheduleWakeup`
  // carries no id. This is the half T1 recorded as unreachable until T3: a
  // self-paced record restored onto a claude session used to fire once, find no
  // `ScheduleWakeup`, and die at the 20-minute fallback.
  it('re-arms and stops the self-paced wakeup, and reports honestly when there is none', async () => {
    const { port } = claudeSession()
    await expect(port.rearmWakeup!({ delayMs: 60_000 })).rejects.toThrow(
      'No self-paced /loop is active in this session.',
    )
    expect(await port.stopWakeup!()).toBe(false)

    await port.create({ dynamic: true, recurring: true, prompt: 'keep going' })
    const armed = await port.rearmWakeup!({ delayMs: 60_000 })
    expect(armed.firesAt).toBeGreaterThan(Date.now())
    expect(await port.stopWakeup!()).toBe(true)
  })
})

const sessionManagerSource = (): string =>
  readFileSync(fileURLToPath(new URL('../SessionManager.ts', import.meta.url)), 'utf8')

describe('both bindings for the port exist, and neither spells Pi', () => {
  // The Claude path's binding. Without this registry entry the four projected
  // tools would be advertised on every Claude card and answer "unavailable" —
  // the exact failure mode the pi-only comment used to predict.
  it('registers cronPort into the per-session callback registry', () => {
    const source = sessionManagerSource()
    // D1.269 gave the builder its session (it nudges the renderer from every
    // mutation), so the needle moved with the code. It matches the MEANING —
    // both bindings go through the one builder — rather than the old spelling.
    const occurrences = source.split('cronPort: sessionCronService ? this.buildSessionCronPort(managed, sessionCronService) : undefined').length - 1
    // Twice: once on the backend config (Pi's route) and once on the callbacks
    // merge (Claude's). One would mean a path silently lost its scheduler.
    expect(occurrences).toBe(2)
    // Positive control: the merge that carries the second one is really there.
    expect(source).toContain('mergeSessionScopedToolCallbacks(')
  })

  // T3's other half of the T1 review note. The old gate was `provider === 'pi'`,
  // which was never the condition that makes `session_crons` exist.
  it('gates hookTaskRegistryPort on the scheduled-delivery set, not on Pi', () => {
    const source = sessionManagerSource()
    expect(source).toContain('hookTaskRegistryPort: SCHEDULED_DELIVERY_RUNTIMES.includes(provider)')
    expect(source).not.toContain("hookTaskRegistryPort: provider === 'pi'")
    // Positive control: the file still gates OTHER ports on Pi, so the absence
    // above is this one binding changing and not the whole expression style
    // disappearing from the file.
    //
    // P6.870, 2026-09-10 — this control read `notificationPort: provider ===
    // 'pi'` until `1ee02327b` ("a codex session can raise a desktop
    // notification") replaced that binding with
    // `this.buildSessionNotificationPort(managed)`. The control then failed on a
    // subject that had not moved, which is the same shape the register already
    // carries for `claude-worktree-port-binding.test.ts`. A control has to name
    // a binding that is still gated on Pi for the reason it is being asserted
    // FOR — `processSupervisorPort` is one, and there are others: the point is
    // the expression style, not this particular port.
    expect(source).toContain("processSupervisorPort: provider === 'pi'")
  })
})
