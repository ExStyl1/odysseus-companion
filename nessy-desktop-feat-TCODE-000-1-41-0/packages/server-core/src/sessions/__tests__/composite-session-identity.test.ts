import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'

import { tmpdir } from 'os'
import { join } from 'path'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'

// W5 stage c: SessionManager composite-identity cutover tests.
//
// Proves:
// 1. Session CRUD uses the global v2 session storage (SESSIONS_DIR/<workspaceId>/<sessionId>),
//    never `{workspaceRoot}/sessions/{id}`.
// 2. Two live workspaces can hold sessions with EQUAL session IDs; every runtime
//    registry keys them by composite SessionKey and API calls disambiguate by workspaceId.
// 3. Bare-sessionId lookups fail closed on ambiguity (never resolve to an arbitrary workspace).
// 4. Changing workingDirectory does not alter the managed session storage path.
// 5. Cross-workspace branching is rejected by ID.

// The repo-wide bun test preload (isolate-shared-config-dir.ts) points NESSY_CONFIG_DIR
// at a private per-run temp dir BEFORE any test file executes, and CONFIG_DIR freezes
// there. Other test files mutate process.env afterwards (which has no effect on the
// frozen constant), so this suite must anchor its fixture on the FROZEN CONFIG_DIR.
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
const configDir = CONFIG_DIR
const WS_A = 'ws-alpha'
const WS_B = 'ws-beta'
const wsARoot = join(configDir, 'workspaces', WS_A)
const wsBRoot = join(configDir, 'workspaces', WS_B)

for (const [id, name, root] of [[WS_A, 'Alpha', wsARoot], [WS_B, 'Beta', wsBRoot]] as const) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    id, name, createdAt: Date.now(), updatedAt: Date.now(),
  }), 'utf-8')
}
writeFileSync(join(configDir, 'config.json'), JSON.stringify({
  storageLayoutVersion: 2,
  workspaceRefs: [
    { id: WS_A, lastAccessedAt: Date.now() },
    { id: WS_B, lastAccessedAt: Date.now() },
  ],
  activeWorkspaceId: WS_A,
  activeSessionId: null,
  defaultLlmConnection: 'test-conn',
  llmConnections: [{
    slug: 'test-conn',
    name: 'Test Connection',
    providerType: 'pi',
    authType: 'api_key',
    createdAt: Date.now(),
  }],
}), 'utf-8')
const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 }

function seedV2Session(workspaceId: string, sessionId: string, name: string): string {
  const dir = join(configDir, 'sessions', workspaceId, sessionId)
  mkdirSync(dir, { recursive: true })
  const header = {
    id: sessionId,
    workspaceId,
    name,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    messageCount: 0,
    tokenUsage: EMPTY_USAGE,
  }
  writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify(header)}\n`, 'utf-8')
  return dir
}

function readHeader(workspaceId: string, sessionId: string): Record<string, unknown> {
  const file = join(configDir, 'sessions', workspaceId, sessionId, 'session.jsonl')
  const firstLine = readFileSync(file, 'utf-8').split('\n')[0] ?? ''
  return JSON.parse(firstLine) as Record<string, unknown>
}

// Top-level await: NESSY_CONFIG_DIR is already set above, so the shared config
// paths freeze onto this test's temp dir when the module graph loads here.
const { createTestSessionManager } = await import('./test-session-manager.ts')
const resolvedWorkspaces = [
  {
    id: WS_A,
    workspaceRootPath: wsARoot,
    sessionRootPath: join(configDir, 'sessions', WS_A),
    config: { id: WS_A, name: 'Alpha', createdAt: 1, updatedAt: 1 },
    lastAccessedAt: 1,
  },
  {
    id: WS_B,
    workspaceRootPath: wsBRoot,
    sessionRootPath: join(configDir, 'sessions', WS_B),
    config: { id: WS_B, name: 'Beta', createdAt: 1, updatedAt: 1 },
    lastAccessedAt: 1,
  },
]
const workspaceService = {
  listResolved: () => resolvedWorkspaces,
  resolve: (workspaceId: string) => {
    const workspace = resolvedWorkspaces.find(candidate => candidate.id === workspaceId)
    if (!workspace) throw new Error('Workspace is not registered')
    return workspace
  },
} as WorkspaceService
const sm = createTestSessionManager({ workspaceService })

afterAll(() => {
  // The config dir is shared with every other in-process test file in this run —
  // remove only what this suite created.
  for (const dir of [join(configDir, 'sessions', WS_A), join(configDir, 'sessions', WS_B), wsARoot, wsBRoot]) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('global v2 session storage', () => {
  it('creates sessions under SESSIONS_DIR/<workspaceId>/<sessionId>', async () => {
    const session = await sm.createSession(WS_A, { name: 'Global Storage Probe' })
    const expectedDir = join(configDir, 'sessions', WS_A, session.id)
    expect(existsSync(join(expectedDir, 'session.jsonl'))).toBe(true)
    // Must NOT be written to the legacy workspace-root layout.
    expect(existsSync(join(wsARoot, 'sessions', session.id))).toBe(false)
    expect(sm.getSessionPath(session.id, WS_A)).toBe(expectedDir)
  })

  it('does not alter the session storage path when workingDirectory changes', async () => {
    const session = await sm.createSession(WS_A, { name: 'Cwd Probe' })
    const before = sm.getSessionPath(session.id, WS_A)
    const externalDir = mkdtempSync(join(tmpdir(), 'sm-external-cwd-'))
    try {
      await sm.updateWorkingDirectory(session.id, externalDir, WS_A)
      expect(sm.getSessionPath(session.id, WS_A)).toBe(before)
      expect(existsSync(join(before!, 'session.jsonl'))).toBe(true)
    } finally {
      rmSync(externalDir, { recursive: true, force: true })
    }
  })
})

describe('duplicate session IDs across two live workspaces', () => {
  beforeAll(() => {
    seedV2Session(WS_A, 'dup-1', 'Alpha Dup')
    seedV2Session(WS_B, 'dup-1', 'Beta Dup')
    sm.reloadSessions()
  })

  it('loads both duplicates and keys the runtime session map by composite SessionKey', () => {
    const inA = sm.getSessions(WS_A).filter(s => s.id === 'dup-1')
    const inB = sm.getSessions(WS_B).filter(s => s.id === 'dup-1')
    expect(inA).toHaveLength(1)
    expect(inB).toHaveLength(1)

    const mapKeys = [...(sm as unknown as { sessions: Map<string, unknown> }).sessions.keys()]
    expect(mapKeys).toContain(`${WS_A}:dup-1`)
    expect(mapKeys).toContain(`${WS_B}:dup-1`)
    expect(mapKeys).not.toContain('dup-1')
  })

  it('resolves getSession by composite identity', async () => {
    const a = await sm.getSession('dup-1', WS_A)
    const b = await sm.getSession('dup-1', WS_B)
    expect(a?.name).toBe('Alpha Dup')
    expect(b?.name).toBe('Beta Dup')
  })

  it('fails closed on ambiguous bare-sessionId lookups', async () => {
    await expect(sm.getSession('dup-1')).rejects.toThrow(/ambiguous/i)
  })

  it('scopes metadata mutations to one workspace (rename + flush both duplicates)', async () => {
    await sm.renameSession('dup-1', 'Alpha Renamed', WS_A)
    await sm.renameSession('dup-1', 'Beta Renamed', WS_B)
    await sm.flushSession('dup-1', WS_A)
    await sm.flushSession('dup-1', WS_B)

    expect(readHeader(WS_A, 'dup-1').name).toBe('Alpha Renamed')
    expect(readHeader(WS_B, 'dup-1').name).toBe('Beta Renamed')
  })

  it('scopes flag/unread mutations to one workspace', async () => {
    await sm.flagSession('dup-1', WS_A)
    await sm.flushSession('dup-1', WS_A)
    await sm.flushSession('dup-1', WS_B)
    expect(readHeader(WS_A, 'dup-1').isFlagged).toBe(true)
    expect(readHeader(WS_B, 'dup-1').isFlagged).not.toBe(true)
  })

  it('keeps active-viewing selection per workspace for equal session IDs', async () => {
    sm.setActiveViewingSession('dup-1', WS_A)
    sm.setActiveViewingSession('dup-1', WS_B)

    // Marking A's duplicate read must not touch B's unread state.
    const beforeB = (await sm.getSession('dup-1', WS_B))?.hasUnread
    await sm.markSessionRead('dup-1', WS_A)
    const afterB = (await sm.getSession('dup-1', WS_B))?.hasUnread
    expect(afterB).toBe(beforeB)
    sm.clearActiveViewingSession(WS_A)
    sm.clearActiveViewingSession(WS_B)
  })

  it('deletes exactly one duplicate by composite identity', async () => {
    seedV2Session(WS_A, 'dup-del', 'Alpha Del')
    seedV2Session(WS_B, 'dup-del', 'Beta Del')
    sm.reloadSessions()

    await sm.deleteSession('dup-del', WS_A)
    expect(existsSync(join(configDir, 'sessions', WS_A, 'dup-del'))).toBe(false)
    expect(existsSync(join(configDir, 'sessions', WS_B, 'dup-del', 'session.jsonl'))).toBe(true)
    expect(sm.getSessions(WS_B).some(s => s.id === 'dup-del')).toBe(true)
    expect(sm.getSessions(WS_A).some(s => s.id === 'dup-del')).toBe(false)
  })
})

describe('cross-workspace branch rejection by ID', () => {
  it('rejects branching into a different workspace than the source session', async () => {
    const source = await sm.createSession(WS_A, { name: 'Branch Source' })
    await expect(sm.createSession(WS_B, {
      branchFromSessionId: source.id,
      branchFromMessageId: 'msg-does-not-matter',
    })).rejects.toThrow(/workspace|not found/i)
  })
})
