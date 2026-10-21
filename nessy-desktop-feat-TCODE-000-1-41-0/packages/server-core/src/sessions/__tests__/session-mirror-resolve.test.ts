/**
 * CDP pass 10 blocker (recurring-defect instance twelve): the renderer resolves
 * sessions through the LISTING/registry built at boot (`initialize` →
 * `loadSessionsFromDisk` → `sessionStore.list`), which skips any session
 * directory without a readable `session.jsonl` — so after local transcript
 * loss the session vanished from the list and ChatPage showed
 * `chat.sessionNoLongerExists` before anything reached the Task 4 open
 * fallback. These tests drive the PRODUCTION boot + resolve path: a session
 * whose directory exists, whose local jsonl is missing/corrupt, and whose key
 * has mirror content is restored BEFORE listing, appears in `getSessions`, and
 * opens with full history via `getSession`. With no mirror configured the
 * missing-jsonl behavior stays byte-for-byte today's (no phantom sessions).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import { saveSession } from '@nessy-agent/shared/sessions/storage'
import type { StoredSession } from '@nessy-agent/shared/sessions/types'
import {
  resetSessionMirrorHostForTests,
  sessionMirrorIdle,
} from '@nessy-agent/shared/sessions/mirror/host'
import { initializeCredentialManagerV2 } from '@nessy-agent/shared/credentials'
import type { SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

// `initialize()` (the production boot path under test) requires the process
// credential singleton. Bind it once; if another suite in this process already
// bound it, a manager exists either way and boot proceeds. The config under
// test declares no llmConnections, so auth resolution never actually reads it.
try {
  initializeCredentialManagerV2({ storageLayoutVersion: 2, verificationId: 'test-mirror-resolve' })
} catch {
  // Already bound — fine.
}

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const MIRROR_ROOT = join(CONFIG_DIR, 'mirror-resolve-root')
const WS = 'ws_mirror_resolve'
const WS_ROOT = join(CONFIG_DIR, 'workspaces', WS)

const managers: SessionManager[] = []
const previousConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null

// See session-mirror-restore.test.ts: `cleanup()` is async and persists live
// sessions, so an un-awaited one lets a mirror dispatch escape into the next
// test with this test's settings already resolved.
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup()
  await sessionMirrorIdle()
  resetSessionMirrorHostForTests()
  if (previousConfig === null) rmSync(CONFIG_FILE, { force: true })
  else writeFileSync(CONFIG_FILE, previousConfig, 'utf-8')
  rmSync(MIRROR_ROOT, { recursive: true, force: true })
  rmSync(join(SESSIONS_DIR, WS), { recursive: true, force: true })
  rmSync(WS_ROOT, { recursive: true, force: true })
})

function writeConfig(withMirror: boolean): void {
  writeFileSync(CONFIG_FILE, JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...(withMirror ? { sessionMirror: { adapter: 'directory', path: MIRROR_ROOT } } : {}),
  }), 'utf-8')
}

function storedSession(id: string): StoredSession {
  return {
    id,
    workspaceId: WS,
    createdAt: 1000,
    lastUsedAt: 2000,
    name: 'Resolve me',
    messages: [
      { id: 'm-1', type: 'user', content: 'question survives loss', timestamp: 3000 },
      { id: 'm-2', type: 'assistant', content: 'answer survives loss', timestamp: 3001 },
    ],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  }
}

/** Populate local + mirror, then break the local jsonl while the DIRECTORY stays. */
async function seedAndBreak(sessionId: string, breakMode: 'delete' | 'corrupt', withMirror = true): Promise<string> {
  writeConfig(withMirror)
  resetSessionMirrorHostForTests()
  await saveSession(storedSession(sessionId))
  await sessionMirrorIdle()

  const sessionDir = join(SESSIONS_DIR, WS, sessionId)
  const localFile = join(sessionDir, 'session.jsonl')
  expect(existsSync(localFile)).toBe(true)
  // The directory keeps living content (attachments/plans) like the live repro.
  mkdirSync(join(sessionDir, 'attachments'), { recursive: true })
  writeFileSync(join(sessionDir, 'attachments', 'note.txt'), 'kept', 'utf-8')
  if (breakMode === 'delete') rmSync(localFile)
  else writeFileSync(localFile, '{{{ not json\ngarbage\n', 'utf-8')
  return localFile
}

/** Boot a manager over WS through the production initialize() path. */
async function bootManager(): Promise<SessionManager> {
  mkdirSync(WS_ROOT, { recursive: true })
  const workspace = {
    id: WS,
    workspaceRootPath: WS_ROOT,
    sessionRootPath: join(SESSIONS_DIR, WS),
    config: { id: WS, name: 'Mirror Resolve Workspace', createdAt: 1, updatedAt: 1 },
    lastAccessedAt: 1,
  }
  const workspaceService = {
    listResolved: () => [workspace],
    resolve: (workspaceId: string) => {
      if (workspaceId !== WS) throw new Error('Workspace is not registered')
      return workspace
    },
  } as WorkspaceService
  const manager = createTestSessionManager({ workspaceService })
  managers.push(manager)
  await manager.initialize()
  return manager
}

describe('mirror fallback on the session resolve path', () => {
  it('a missing local jsonl with mirrored content is restored at boot: listed, and opens with full history', async () => {
    const localFile = await seedAndBreak('s-resolve-deleted', 'delete')

    const manager = await bootManager()

    // 1. LISTING: the session is back in the registry the renderer lists from.
    const listed = manager.getSessions(WS)
    expect(listed.some(session => session.id === 's-resolve-deleted')).toBe(true)

    // 2. OPEN via the production get path ChatPage's data flows from.
    const session = await manager.getSession('s-resolve-deleted', WS)
    expect(session).not.toBeNull()
    expect(session!.messages.map(message => message.content)).toEqual([
      'question survives loss',
      'answer survives loss',
    ])

    // The local jsonl was rebuilt atomically on disk.
    const lines = readFileSync(localFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!).name).toBe('Resolve me')
  })

  it('a corrupt local jsonl restores the same way on the same path', async () => {
    const localFile = await seedAndBreak('s-resolve-corrupt', 'corrupt')

    const manager = await bootManager()

    expect(manager.getSessions(WS).some(session => session.id === 's-resolve-corrupt')).toBe(true)
    const session = await manager.getSession('s-resolve-corrupt', WS)
    expect(session!.messages.map(message => message.content)).toEqual([
      'question survives loss',
      'answer survives loss',
    ])
    expect(existsSync(`${localFile}.corrupt`)).toBe(true)
  })

  it('with no mirror configured a missing jsonl keeps today\'s behavior: not listed, no phantom, no rebuilt file', async () => {
    const localFile = await seedAndBreak('s-resolve-nomirror', 'delete', false)

    const manager = await bootManager()

    expect(manager.getSessions(WS).some(session => session.id === 's-resolve-nomirror')).toBe(false)
    expect(await manager.getSession('s-resolve-nomirror', WS)).toBeNull()
    expect(existsSync(localFile)).toBe(false)
    expect(existsSync(MIRROR_ROOT)).toBe(false)
  })
})
