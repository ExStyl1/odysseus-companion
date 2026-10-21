/**
 * P6.101 (ledger F3/codex) — the session list's Branch affordance, on a session
 * whose agent is not running.
 *
 * `supportsBranching` had two answers and no record behind either: live, the
 * agent instance's `_supportsBranching`; COLD, the literal `true` — "default:
 * branching enabled for all backends". The session list never asks an instance,
 * so a cold session offered Branch on every backend in the vocabulary. On codex
 * that produced a child whose record showed the parent's conversation and whose
 * model was handed an empty thread; on `nestor-cloud-agent` it contradicted the
 * instance's own long-standing `false`.
 *
 * This suite drives `getSessions()` — the projection the renderer's Branch
 * affordance reads — on COLD sessions, one per runtime.
 *
 * ## P6.277 — the codex negative became a positive, and the case moved with it
 *
 * The parenthetical this header used to carry — "`codex-agent.ts` reads
 * `branchFrom` nowhere" — was true when P6.101 measured it and P6.102
 * (`2ea351566`) refuted it: codex now opens the parent thread with
 * `thread/fork` + `lastTurnId`. The flag stayed `false` anyway, so every line
 * of that build was unreachable. The negative control moves to
 * `nestor-cloud-agent`, which is a REMOTE runtime whose fork would have to
 * happen on the far side of the A2A wire — an absence no host build can close,
 * so it cannot go stale the way codex's did — and the codex cell is pinned
 * against the SOURCE that decides it rather than against a remembered reading.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import {
  SESSION_BRANCHING_SUPPORT,
  runtimeBranchesSessions,
} from '@nessy-agent/shared/agent/runtime-agent-support'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const stateRoot = mkdtempSync(join(tmpdir(), 'sm-cold-branching-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-cold-branching'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Cold Branching Workspace',
    slug: 'cold-branching-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

const TEST_CONNECTIONS = [
  {
    slug: 'branch-pi',
    name: 'Pi',
    providerType: 'pi',
    authType: 'api_key',
    models: [{ id: 'pi-model', name: 'Pi Model', contextWindow: 200_000 }],
    defaultModel: 'pi-model',
    createdAt: Date.now(),
  },
  {
    slug: 'branch-codex',
    name: 'Codex (Nessy Gateway)',
    providerType: 'codex-runtime',
    authType: 'bearer_token',
    models: [{ id: 'gpt-5.3-codex', name: 'gpt-5.3-codex', contextWindow: 272_000 }],
    defaultModel: 'gpt-5.3-codex',
    createdAt: Date.now(),
  },
] as unknown as NonNullable<StoredConfig['llmConnections']>

type SessionManagerModule = typeof import('../SessionManager.ts')

let createManagedSessionFn: SessionManagerModule['createManagedSession']
let createTestSessionManagerFn: typeof import('./test-session-manager.ts')['createTestSessionManager']
let restoreConfig: () => void = () => {}

/**
 * P3.180's measured floor, not a guess: the whole hook is
 * `import('../SessionManager.ts')`, measured at 44 668 ms at load 7.8 and
 * 57 200 ms at load 82 against bun's 5 000 ms default. A budget set near the
 * resting state manufactures its own failures.
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
  storage.saveConfig({ ...base, defaultLlmConnection: 'branch-pi', llmConnections: TEST_CONNECTIONS })
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

/** A session registered exactly as a restart leaves it: metadata, no agent. */
function seedColdSession(manager: ReturnType<typeof createTestSessionManagerFn>, connectionSlug: string) {
  const id = `cold-branch-${++sessionCounter}`
  const managed = createManagedSessionFn(
    { id, name: id, createdAt: Date.now(), llmConnection: connectionSlug } as never,
    {
      id: WORKSPACE_ID,
      name: 'Cold Branching Workspace',
      slug: 'cold-branching-workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    } as never,
  )
  ;(manager as unknown as { sessions: Map<string, unknown> })
    .sessions.set(`${WORKSPACE_ID}:${id}`, managed)
  return id
}

describe('P6.101 — a cold session reports the branching verdict of its RUNTIME', () => {
  it('offers Branch on a cold codex session, as it does on a cold Pi one', () => {
    const manager = createTestSessionManagerFn()
    const codexId = seedColdSession(manager, 'branch-codex')
    const piId = seedColdSession(manager, 'branch-pi')

    const sessions = manager.getSessions(WORKSPACE_ID)
    const codex = sessions.find(s => s.id === codexId)
    const pi = sessions.find(s => s.id === piId)

    // Both sessions are cold: no agent was ever created for either, so the old
    // fallback answered `true` for both and the two were indistinguishable.
    // The projection still answers from the RECORD rather than from an
    // instance, which is what P6.101 fixed and this still pins.
    expect((codex as unknown as { agent?: unknown })?.agent).toBeUndefined()
    // P6.277 — `false` until this row, on a premise P6.102 had already refuted.
    expect(codex?.supportsBranching).toBe(true)
    expect(pi?.supportsBranching).toBe(true)
  })

  /**
   * P6.277 — the codex cell is tied to the SOURCE that decides it.
   *
   * The cell said `false` for a whole plan phase after `2ea351566` made its
   * stated reason untrue, and nothing failed: a comment cannot be a guard. So
   * the record's codex answer is asserted against the code the record describes
   * — a fork call site that reads the branch metadata — and a future deletion of
   * that call site reddens here rather than silently leaving the flag on.
   */
  it('the codex record matches the fork call site it describes', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', 'shared', 'src', 'agent', 'codex-agent.ts'),
      'utf8',
    )
    // The read of the host's branch metadata, and the primitive it feeds.
    const reads = source.includes('this.config.session?.branchFrom')
      && source.includes("client.request('thread/fork'")
      && source.includes('lastTurnId')
    expect(SESSION_BRANCHING_SUPPORT['codex-runtime']).toBe(reads)
    // Positive control: the file really was read, so a bad path cannot make
    // both sides `false` and pass.
    expect(source.length).toBeGreaterThan(10_000)
  })

  it('the projection answers exactly what the record says, for every provider', () => {
    // The tie that keeps the two readers from drifting: whatever the record
    // says for a provider is what a cold session on that provider reports.
    for (const [provider, expected] of Object.entries(SESSION_BRANCHING_SUPPORT)) {
      expect(runtimeBranchesSessions(provider as never)).toBe(expected)
    }
    // `nestor-cloud-agent` has answered `false` on its INSTANCE since it was
    // written; before this row a cold one still offered Branch.
    expect(SESSION_BRANCHING_SUPPORT['nestor-cloud-agent']).toBe(false)
  })
})
