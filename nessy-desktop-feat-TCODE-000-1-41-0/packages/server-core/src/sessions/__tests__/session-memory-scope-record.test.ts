/**
 * P6.703 — the record side of the per-chat memory scope.
 *
 * P6.390 shipped the whole model — two axes, resolution against the global
 * switch, both runtime projections, the residue sentence — and nothing persisted
 * a `SessionMemoryScopeOverride`, so `resolveSessionMemoryScope` was always
 * called with `undefined` and every chat followed the global switch. A chat a
 * user had excluded was indistinguishable from one they had not.
 *
 * What is under test here is therefore the RECORD: the override is stored on the
 * session, survives on disk, resolves the same way on every runtime because the
 * resolution reads no provider at all, and an untouched chat is byte-identical
 * to today.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { createTestSessionManager } from './test-session-manager.ts'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

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
  // Memory ON globally is the interesting baseline: it is the setting an
  // override has to be able to overrule per chat.
  storage.saveConfig({
    ...base,
    memoryEnabled: true,
    defaultLlmConnection: 'pi-conn',
    llmConnections: TEST_CONNECTIONS,
  } as StoredConfig)
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => { restoreConfig() })

const RUNTIMES = [
  { label: 'pi', slug: 'pi-conn' },
  { label: 'claude', slug: 'claude-conn' },
  { label: 'codex', slug: 'codex-conn' },
]

describe('a chat can be kept out of memory, and the record remembers it', () => {
  for (const runtime of RUNTIMES) {
    test(`${runtime.label}: the override is recorded and resolved, and the record is what carries it`, async () => {
      const manager = createTestSessionManager() as any
      const workspaceId = `workspace-p6703-${runtime.label}`
      try {
        const session = await manager.createSession(workspaceId, { llmConnection: runtime.slug })

        // Untouched: no override at all, and the global switch decides. This is
        // the state every existing chat is in, and it must not move.
        expect(manager.getSessionMemoryScope(session.id, workspaceId))
          .toEqual({ scope: { read: true, write: true }, override: {} })

        // Both axes off — the chat is out of memory in both directions.
        expect(await manager.setSessionMemoryScope(session.id, { read: false, write: false }, workspaceId))
          .toEqual({ scope: { read: false, write: false }, override: { read: false, write: false } })

        // ON DISK, which is the whole row: a restart re-reads the record, so a
        // field that is not written is a chat that quietly rejoins memory. The
        // write is queued and debounced, so the flush is part of the assertion
        // rather than a convenience — reading without it measures the previous
        // state and would pass with the field never persisted at all.
        await manager.flushSession(session.id, workspaceId)
        const stored = manager.sessionStore.load({ workspaceId, sessionId: session.id })
        expect(stored?.memoryScopeOverride).toEqual({ read: false, write: false })

        // One axis only: the other still follows the global switch, which is
        // what "without touching the global setting" means.
        expect(await manager.setSessionMemoryScope(session.id, { write: false }, workspaceId))
          .toEqual({ scope: { read: true, write: false }, override: { write: false } })

        // Clearing both axes REMOVES the field rather than storing two
        // undefineds, so the record returns to a chat that never touched it.
        expect(await manager.setSessionMemoryScope(session.id, {}, workspaceId))
          .toEqual({ scope: { read: true, write: true }, override: {} })
        await manager.flushSession(session.id, workspaceId)
        expect(manager.sessionStore.load({ workspaceId, sessionId: session.id })?.memoryScopeOverride)
          .toBeUndefined()
      } finally {
        await manager.cleanup()
      }
      // The budget is explicit and set against the MEASURED floor, never zero:
      // one arm is a real `createSession` plus four persisting writes and two
      // store reads, and it measured 6.8-9.2 s on a box at load ~12 against
      // bun's 5 s default.
    }, 60_000)
  }

  test('an unknown session is refused by name rather than answered with a default', async () => {
    const manager = createTestSessionManager() as any
    try {
      expect(() => manager.getSessionMemoryScope('no-such-session', 'workspace-p6703-missing')).toThrow()
      await expect(manager.setSessionMemoryScope('no-such-session', { read: false }, 'workspace-p6703-missing'))
        .rejects.toThrow()
    } finally {
      await manager.cleanup()
    }
  })
})
