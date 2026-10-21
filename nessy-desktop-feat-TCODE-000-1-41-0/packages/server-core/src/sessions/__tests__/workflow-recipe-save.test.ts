/**
 * P6.318 — the production caller `saveWorkflowRecipe` never had, and the refusal
 * the row asks for by name.
 *
 * The save is offered only where a recipe can actually run: `disableWorkflows`
 * turns the whole surface off (`workflows.md` §Turn workflows off), and a
 * runtime that cannot dispatch a recipe is told so rather than being handed a
 * file it will never execute. The predicate is `runtimeDispatchesWorkflows`, the
 * same one the capability resolver and `BaseAgent.canDispatchWorkflowCommands`
 * read, so the three cannot answer differently.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { createTestSessionManager } from './test-session-manager.ts'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const SOURCE = `
  export const meta = { name: 'kept', description: 'Kept from a run' };
  return 'kept';
`

const TEST_CONNECTIONS = [
  { slug: 'pi-conn', name: 'Pi', providerType: 'pi', authType: 'api_key', defaultModel: 'pi-model-a', createdAt: Date.now() },
  { slug: 'claude-conn', name: 'Claude', providerType: 'claude-runtime', authType: 'bearer_token', defaultModel: 'claude-model-a', createdAt: Date.now() },
  { slug: 'codex-conn', name: 'Codex', providerType: 'codex-runtime', authType: 'bearer_token', defaultModel: 'codex-model-a', createdAt: Date.now() },
] as unknown as NonNullable<StoredConfig['llmConnections']>

let restoreConfig: () => void = () => {}

beforeAll(async () => {
  const storage = await import('@nessy-agent/shared/config/storage')
  const configPath = storage.getConfigPath()
  const previous = existsSync(configPath) ? storage.loadStoredConfig() : null
  const base: StoredConfig = previous ?? ({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as unknown as StoredConfig)
  storage.saveConfig({ ...base, defaultLlmConnection: 'pi-conn', llmConnections: TEST_CONNECTIONS } as StoredConfig)
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => { restoreConfig() })

describe('a run can be kept, and only where it can run', () => {
  test('Pi: the recipe is written to the personal location the loader reads', async () => {
    const manager = createTestSessionManager() as any
    const workspaceId = 'workspace-p6318-pi'
    try {
      const session = await manager.createSession(workspaceId, { llmConnection: 'pi-conn' })
      const { path } = await manager.saveSessionWorkflowRecipe(session.id, SOURCE, 'personal', workspaceId)
      expect(path.endsWith(`workflows/kept.js`)).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(SOURCE)
    } finally {
      await manager.cleanup()
    }
  }, 60_000)

  for (const runtime of [{ label: 'claude', slug: 'claude-conn' }, { label: 'codex', slug: 'codex-conn' }]) {
    test(`${runtime.label}: the save is refused by name, not silently accepted`, async () => {
      const manager = createTestSessionManager() as any
      const workspaceId = `workspace-p6318-${runtime.label}`
      try {
        const session = await manager.createSession(workspaceId, { llmConnection: runtime.slug })
        await expect(manager.saveSessionWorkflowRecipe(session.id, SOURCE, 'personal', workspaceId))
          .rejects.toThrow(/cannot dispatch a workflow recipe/)
      } finally {
        await manager.cleanup()
      }
    }, 60_000)
  }

  test('an unknown session is refused rather than writing anything', async () => {
    const manager = createTestSessionManager() as any
    try {
      await expect(manager.saveSessionWorkflowRecipe('no-such-session', SOURCE, 'personal', 'workspace-p6318-missing'))
        .rejects.toThrow(/not found/)
    } finally {
      await manager.cleanup()
    }
  })
})
