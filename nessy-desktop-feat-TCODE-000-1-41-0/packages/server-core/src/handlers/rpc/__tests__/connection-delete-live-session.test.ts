/**
 * T9 — deleting an LLM connection must not silently move whatever still uses it.
 *
 * Before this, `llmConnections.DELETE` notified nobody: the slug simply stopped
 * resolving, the orphan clear in `loadSessionsFromDisk` dropped it on the next
 * restore, and the session came back on the workspace default — a different
 * runtime, with no confirmation and no notice. Automations are the second door
 * and the quieter one: they resolve their connection at fire time and fall
 * through to the default when it is gone, so a task configured for Codex keeps
 * firing on Pi.
 *
 * In-process, on the isolated `NESSY_CONFIG_DIR` the root `[test].preload`
 * installs, so a write here never reaches a real config.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { createPromptHistoryEntry } from '@nessy-agent/shared/automations'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerLlmConnectionsHandlers } from '../llm-connections'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
// D1.147 (rule 24) — STATIC, and the two cases below no longer import it
// themselves. The first of them timed out at 5 001.75 ms at load 13.22 and
// passed on the re-run at 11.65 (register, W19-a 2026-09-12): a 34k-line module
// graph was being charged to the 5 s per-test timer, and the sibling case never
// failed only because the module was cached by then. Module evaluation is timed
// by nothing, so the cost belongs to the file's load.
//
// The ORDERING this was held back for, measured 2026-09-17 rather than assumed:
// a static import is evaluated before this file's own top-level writes and
// before `beforeAll` seeds the connections, where the dynamic one ran after
// both. It is safe here because the graph is already loaded — `../llm-connections`
// statically reaches `@nessy-agent/server-core/handlers` and
// `@nessy-agent/shared/config/storage` — and because neither case reads config
// at all: both populate the double's own `sessions`/`automationSystems` map and
// assert on what the reader returns. Before/after, same box, file alone:
// 13 pass / 0 fail / 22 expect() across 1 file both times. The separating
// instrument is `--reporter=junit`, not the wall time (which is this family's
// I/O lottery): the describe below cost `time="0.107"` with its slowest body at
// 107.7 ms and now reads `time="0"` with no body in the file above 18.5 ms.
import { createManagedSession } from '../../../sessions/SessionManager.ts'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager.ts'

const stateRoot = mkdtempSync(join(tmpdir(), 'connection-delete-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-connection-delete'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Connection Delete Workspace',
    slug: 'connection-delete-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

const TEST_CONNECTIONS = [
  { slug: 'pi-source', name: 'Pi Source', providerType: 'pi', authType: 'api_key', createdAt: Date.now() },
  { slug: 'codex-gateway', name: 'Codex (Nessy Gateway)', providerType: 'codex-runtime', authType: 'bearer_token', createdAt: Date.now() },
  { slug: 'spare', name: 'Spare', providerType: 'pi', authType: 'api_key', createdAt: Date.now() },
] as unknown as NonNullable<StoredConfig['llmConnections']>

let restoreConfig: () => void = () => {}
let seedConnections: () => void = () => {}

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
  seedConnections = () => {
    storage.saveConfig({ ...base, defaultLlmConnection: 'pi-source', llmConnections: TEST_CONNECTIONS })
  }
  seedConnections()
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  restoreConfig()
  rmSync(stateRoot, { recursive: true, force: true })
})

interface FakeManager {
  sessionsUsingConnection: (slug: string) => { workspaceId: string; sessionId: string; name?: string }[]
  listAutomationsUsingConnection: (slug: string) => string[]
}

function handlers(manager: Partial<FakeManager>): Map<string, HandlerFn> {
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const deps = {
    sessionManager: {
      sessionsUsingConnection: () => [],
      listAutomationsUsingConnection: () => [],
      refreshConnectionRuntime: async () => {},
      reinitializeAuth: async () => {},
      ...manager,
    },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerLlmConnectionsHandlers(server, deps)
  return registered
}

const ctx = { clientId: 'client-a', workspaceId: WORKSPACE_ID, webContentsId: null }

const deleteConnection = (manager: Partial<FakeManager>, slug: string) =>
  handlers(manager).get(RPC_CHANNELS.llmConnections.DELETE)!(ctx, slug)

describe('deleting a connection something still uses', () => {
  it('refuses when a live session is bound to it', async () => {
    await expect(deleteConnection({
      sessionsUsingConnection: () => [{ workspaceId: WORKSPACE_ID, sessionId: 's1' }],
    }, 'codex-gateway')).rejects.toThrow(/1 session\(s\).*still use/)
  })

  it('refuses when an automation is configured for it', async () => {
    await expect(deleteConnection({
      listAutomationsUsingConnection: () => ['nightly'],
    }, 'codex-gateway')).rejects.toThrow(/1 automation\(s\)/)
  })

  it('NAMES the chats and tasks that hold it, and falls back to the id for an unnamed one', async () => {
    // C3.368 · the counts alone told a user that something holds the connection
    // and left them to find it by opening every chat. The names are the part no
    // translation can supply, so they are the part that has to cross the wire.
    const error = await deleteConnection({
      sessionsUsingConnection: () => [
        { workspaceId: WORKSPACE_ID, sessionId: 's1', name: 'Refactor auth' },
        // No name yet: the id is worse than a title and far better than nothing,
        // which is the case this row exists to remove.
        { workspaceId: WORKSPACE_ID, sessionId: 's2' },
      ],
      listAutomationsUsingConnection: () => ['Nightly digest'],
    }, 'codex-gateway').then(() => null, (thrown: unknown) => thrown as Error)

    const message = error?.message ?? ''
    expect(message).toContain('"Refactor auth"')
    expect(message).toContain('"s2"')
    expect(message).toContain('"Nightly digest"')
    // The counting clause survives — it is what the renderer's translated
    // sentence is about, and the names are appended to it rather than replacing
    // it.
    expect(message).toContain('2 session(s) and 1 automation(s)')
  })

  it('bounds the list, so a connection held by many chats is still one line', async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      workspaceId: WORKSPACE_ID, sessionId: `s${index}`, name: `Chat ${index}`,
    }))
    const error = await deleteConnection({ sessionsUsingConnection: () => many }, 'codex-gateway')
      .then(() => null, (thrown: unknown) => thrown as Error)

    const message = error?.message ?? ''
    expect(message).toContain('"Chat 4"')
    expect(message).not.toContain('"Chat 5"')
    expect(message).toContain('and 3 more')
  })

  /**
   * D1.150 — the names as DATA, because a sentence cannot be translated with
   * user-authored text baked into it.
   *
   * Two arms, and the second is the one that makes the payload worth having: the
   * TAIL is a number rather than the English words "and N more", so a renderer
   * says it in the user's own language. The bound is the sender's, so the wire
   * carries at most the same five per kind the sentence shows.
   */
  it('carries the holder names as DATA beside the sentence, bounded the same way', async () => {
    const error = await deleteConnection({
      sessionsUsingConnection: () => [
        { workspaceId: WORKSPACE_ID, sessionId: 's1', name: 'Refactor auth' },
        { workspaceId: WORKSPACE_ID, sessionId: 's2' },
      ],
      listAutomationsUsingConnection: () => ['Nightly digest'],
    }, 'codex-gateway').then(() => null, (thrown: unknown) => thrown as { data?: unknown })

    expect(error?.data).toEqual({
      // The id fallback is DATA too: a renderer must not have to parse it back
      // out of the sentence.
      sessions: ['Refactor auth', 's2'],
      automations: ['Nightly digest'],
      moreSessions: 0,
      moreAutomations: 0,
    })
  })

  it('bounds the DATA at the sender and reports the tail as a NUMBER', async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      workspaceId: WORKSPACE_ID, sessionId: `s${index}`, name: `Chat ${index}`,
    }))
    const error = await deleteConnection({ sessionsUsingConnection: () => many }, 'codex-gateway')
      .then(() => null, (thrown: unknown) => thrown as { data?: { sessions?: string[]; moreSessions?: number } })

    expect(error?.data?.sessions).toEqual(['Chat 0', 'Chat 1', 'Chat 2', 'Chat 3', 'Chat 4'])
    expect(error?.data?.moreSessions).toBe(3)
    // The English tail stays in the message for the log and the headless client;
    // the renderer reads the number instead.
    expect(String((error as unknown as Error).message)).toContain('and 3 more')
  })

  it('carries the CONNECTION_IN_USE code, not just a message', async () => {
    // The renderer branches on the CODE to translate the refusal; flattened
    // into the handler's `{ success:false, error }` result it could only be
    // printed. The pre-existing catch in that handler would do exactly that.
    const error = await deleteConnection({
      sessionsUsingConnection: () => [{ workspaceId: WORKSPACE_ID, sessionId: 's1' }],
    }, 'codex-gateway').then(() => null, (thrown: unknown) => thrown as { code?: string })
    expect(error?.code).toBe('CONNECTION_IN_USE')
  })

  // Negative subject. Without it the three rows above pass just as well on a
  // handler that refuses every delete.
  it('still deletes a connection nothing uses', async () => {
    const storage = await import('@nessy-agent/shared/config/storage')
    try {
      // Asserted on the CONFIG rather than the result: the credential manager
      // this handler also calls is unavailable in-process (no verified v2
      // layout) and its failure is reported through the same result object.
      // The record being gone is what "the delete proceeded" means.
      await deleteConnection({}, 'spare').catch(() => undefined)
      expect(storage.getLlmConnection('spare') ?? null).toBeNull()
    } finally {
      seedConnections()
    }
  })

  // A missing connection must still answer through the result shape: only the
  // refusal the renderer translates is a thrown code.
  it('reports an unknown slug through the result rather than a code', async () => {
    const result = await deleteConnection({}, 'never-existed')
    expect(result).toMatchObject({ success: false, error: 'Connection not found' })
  })
})

describe('the two things the refusal counts', () => {
  it('finds every loaded session bound to the slug, and no others', () => {
    const manager = createTestSessionManager() as unknown as {
      sessions: Map<string, unknown>
      sessionsUsingConnection: (slug: string) => { sessionId: string }[]
    }
    const workspace = { id: WORKSPACE_ID, name: 'w', slug: 'w', rootPath: workspaceRoot, createdAt: Date.now() }
    manager.sessions = new Map()
    for (const [id, slug] of [['s1', 'codex-gateway'], ['s2', 'pi-source'], ['s3', 'codex-gateway']] as const) {
      manager.sessions.set(`${WORKSPACE_ID}:${id}`, createManagedSession(
        { id, name: id, llmConnection: slug },
        workspace as never,
        { messagesLoaded: true, ephemeral: true },
      ))
    }
    expect(manager.sessionsUsingConnection('codex-gateway').map(key => key.sessionId)).toEqual(['s1', 's3'])
    expect(manager.sessionsUsingConnection('spare')).toEqual([])
  })

  it('finds prompt automations across every workspace, and ignores other action types', () => {
    const manager = createTestSessionManager() as unknown as {
      automationSystems: Map<string, unknown>
      listAutomationsUsingConnection: (slug: string) => string[]
    }
    const system = (automations: unknown) => ({ getConfig: () => ({ automations }) })
    manager.automationSystems = new Map<string, unknown>([
      ['ws-a', system({
        SchedulerTick: [
          { name: 'nightly', actions: [{ type: 'prompt', prompt: 'go', llmConnection: 'codex-gateway' }] },
          { name: 'other-connection', actions: [{ type: 'prompt', prompt: 'go', llmConnection: 'pi-source' }] },
          // A webhook carries a url, never a connection: a matcher that reads
          // `action.llmConnection` without the type guard would still match a
          // webhook whose payload happened to carry the key.
          { name: 'webhook', actions: [{ type: 'webhook', url: 'https://x', llmConnection: 'codex-gateway' }] },
        ],
      })],
      // The second workspace is the point: `llmConnections.DELETE` takes a slug
      // and no workspace, and connections are global config, so a check scoped
      // to one workspace would let a delete through that breaks another's.
      ['ws-b', system({ SessionStart: [{ id: 'abc123', actions: [{ type: 'prompt', prompt: 'go', llmConnection: 'codex-gateway' }] }] })],
    ])
    expect(manager.listAutomationsUsingConnection('codex-gateway')).toEqual(['nightly', 'abc123'])
    expect(manager.listAutomationsUsingConnection('spare')).toEqual([])
  })
})

describe('an automation whose connection is gone', () => {
  it('records the fallback in its history entry instead of only logging it', () => {
    const entry = createPromptHistoryEntry({
      matcherId: 'm1',
      ok: true,
      sessionId: 's1',
      prompt: 'go',
      connectionFallback: { requested: 'codex-gateway', used: 'pi-source' },
    })
    // `ok` stays true: the run happened. What changed is that it now says where.
    expect(entry).toMatchObject({ ok: true, connectionFallback: { requested: 'codex-gateway', used: 'pi-source' } })
  })

  it('omits the field entirely on a run that went where it was configured', () => {
    expect(createPromptHistoryEntry({ matcherId: 'm1', ok: true, sessionId: 's1', prompt: 'go' }))
      .not.toHaveProperty('connectionFallback')
  })
})
