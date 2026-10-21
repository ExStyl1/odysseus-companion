/**
 * R6 load-fallback before resume: if the local transcript is missing or
 * unreadable AND a mirror is configured, the production session-open path
 * (`ensureMessagesLoaded` → `loadMessagesFromDisk` → `sessionStore.load`)
 * rebuilds the local JSONL from `store.load(key)` and opens with full history.
 * The mirror stays non-authoritative — the rebuild is an ordinary local file a
 * later local write overwrites. With no mirror configured, behavior is
 * byte-for-byte today's (no restore, empty history).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { saveSession } from '@nessy-agent/shared/sessions/storage'
import type { StoredSession } from '@nessy-agent/shared/sessions/types'
import {
  resetSessionMirrorHostForTests,
  sessionMirrorIdle,
} from '@nessy-agent/shared/sessions/mirror/host'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const MIRROR_ROOT = join(CONFIG_DIR, 'mirror-restore-root')
const WS = 'ws_mirror_restore'

const managers: SessionManager[] = []

// `cleanup()` returns a promise and persists every live session on its way out,
// and that write tips the mirror host. Dropping the promise let a dispatch from
// THIS test's cleanup start under THIS test's mirror config and land during the
// NEXT one — `dispatch` resolves settings once at the top and never re-checks —
// which is how the no-mirror case kept finding a MIRROR_ROOT that the previous
// test's session had just recreated. Await the cleanups, then await the mirror
// queue, and only then take the config and the root away.
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup()
  await sessionMirrorIdle()
  resetSessionMirrorHostForTests()
  rmSync(CONFIG_FILE, { force: true })
  rmSync(MIRROR_ROOT, { recursive: true, force: true })
  rmSync(join(SESSIONS_DIR, WS), { recursive: true, force: true })
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
    name: 'Mirrored chat',
    messages: [
      { id: 'm-1', type: 'user', content: 'first question', timestamp: 3000 },
      { id: 'm-2', type: 'assistant', content: 'first answer', timestamp: 3001 },
    ],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  }
}

async function mirrorAndBreakLocal(sessionId: string, breakMode: 'delete' | 'corrupt'): Promise<string> {
  writeConfig(true)
  resetSessionMirrorHostForTests()
  await saveSession(storedSession(sessionId))
  await sessionMirrorIdle()

  const localFile = join(SESSIONS_DIR, WS, sessionId, 'session.jsonl')
  expect(existsSync(localFile)).toBe(true)
  if (breakMode === 'delete') {
    rmSync(localFile)
  } else {
    writeFileSync(localFile, '{{{ not json at all\ngarbage line\n', 'utf-8')
  }
  return localFile
}

async function openThroughProductionPath(sessionId: string) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const managed = createManagedSession({ id: sessionId }, {
    id: WS,
    name: 'Mirror Restore Workspace',
    rootPath: '/tmp/nessy-mirror-restore',
    createdAt: 1,
  } as never, { messagesLoaded: false })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${WS}:${sessionId}`,
    managed,
  )
  const internals = manager as unknown as {
    ensureMessagesLoaded(managed: unknown): Promise<void>
  }
  await internals.ensureMessagesLoaded(managed)
  return managed
}

describe('mirror load-fallback before resume', () => {
  it('a deleted local JSONL restores full history from the mirror through the production open path', async () => {
    const localFile = await mirrorAndBreakLocal('s-restore-deleted', 'delete')

    const managed = await openThroughProductionPath('s-restore-deleted')

    expect(managed.messages.map(message => message.content)).toEqual([
      'first question',
      'first answer',
    ])
    // The rebuild is an ordinary local JSONL again — a later local write wins.
    const lines = readFileSync(localFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!).name).toBe('Mirrored chat')
  })

  it('a corrupt local JSONL restores the same way', async () => {
    await mirrorAndBreakLocal('s-restore-corrupt', 'corrupt')

    const managed = await openThroughProductionPath('s-restore-corrupt')

    expect(managed.messages.map(message => message.content)).toEqual([
      'first question',
      'first answer',
    ])
  })

  it('with no mirror configured a deleted local JSONL keeps today\'s behavior', async () => {
    // Populate + delete WITHOUT any mirror in config.
    writeConfig(false)
    resetSessionMirrorHostForTests()
    await saveSession(storedSession('s-no-mirror'))
    await sessionMirrorIdle()
    const localFile = join(SESSIONS_DIR, WS, 's-no-mirror', 'session.jsonl')
    rmSync(localFile)

    const managed = await openThroughProductionPath('s-no-mirror')

    expect(managed.messages).toEqual([])
    expect(existsSync(localFile)).toBe(false)
    expect(existsSync(MIRROR_ROOT)).toBe(false)
  })
})
