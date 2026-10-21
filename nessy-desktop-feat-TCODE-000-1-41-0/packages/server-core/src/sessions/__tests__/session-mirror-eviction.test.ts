/**
 * A long-running nessy-server must not grow memory linearly with historical
 * sessions: the production session-deletion lifecycle must evict the mirror
 * host's per-session diff state (uuid cache) for the deleted key. The MIRROR
 * copy itself stays — retention is the adapter's own; the host never deletes
 * from a mirror (agent-sdk/session-storage.md § Retention).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { saveSession } from '@nessy-agent/shared/sessions/storage'
import type { StoredSession } from '@nessy-agent/shared/sessions/types'
import {
  hasSessionMirrorState,
  resetSessionMirrorHostForTests,
  sessionMirrorIdle,
} from '@nessy-agent/shared/sessions/mirror/host'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const MIRROR_ROOT = join(CONFIG_DIR, 'mirror-eviction-root')
const WS = 'ws_mirror_evict'

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
})

describe('mirror host state eviction on session deletion', () => {
  it('deleteSession drops the host diff state for the key while the mirror copy is retained', async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      sessionMirror: { adapter: 'directory', path: MIRROR_ROOT },
    }), 'utf-8')
    resetSessionMirrorHostForTests()

    const stored: StoredSession = {
      id: 's-evict-on-delete',
      workspaceId: WS,
      createdAt: 1000,
      lastUsedAt: 2000,
      messages: [{ id: 'm-1', type: 'user', content: 'to be deleted', timestamp: 3000 }],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    await saveSession(stored)
    await sessionMirrorIdle()
    const sessionKey = { workspaceId: WS, sessionId: 's-evict-on-delete' }
    expect(hasSessionMirrorState(sessionKey)).toBe(true)

    const manager = createTestSessionManager()
    managers.push(manager)
    const managed = createManagedSession({ id: 's-evict-on-delete' }, {
      id: WS,
      name: 'Mirror Eviction Workspace',
      rootPath: '/tmp/nessy-mirror-eviction',
      createdAt: 1,
    } as never, { messagesLoaded: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      `${WS}:s-evict-on-delete`,
      managed,
    )

    await manager.deleteSession('s-evict-on-delete', WS)

    // The host's per-session diff state is gone (bounded memory)…
    expect(hasSessionMirrorState(sessionKey)).toBe(false)
    // …the local copy is deleted…
    expect(existsSync(join(SESSIONS_DIR, WS, 's-evict-on-delete'))).toBe(false)
    // …and the MIRROR copy is retained: the host never deletes from a mirror.
    expect(existsSync(join(MIRROR_ROOT, WS, 's-evict-on-delete', 'transcript.jsonl'))).toBe(true)
  })
})
