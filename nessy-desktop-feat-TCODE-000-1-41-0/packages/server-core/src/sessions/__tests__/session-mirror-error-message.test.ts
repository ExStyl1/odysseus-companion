/**
 * The host half of the mirror failure envelope: when a batch is dropped, the
 * `{ type: 'system', subtype: 'mirror_error' }` event surfaces as a session
 * system message visible in the transcript (plus a log line) while the session
 * continues — never a subprocess RPC. Production chain under test:
 * `persistSession` → `sessionPersistenceQueue` flush → local write (intact) →
 * mirror dispatch fails → SessionManager's constructor-registered sink appends
 * the transcript message.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import {
  resetSessionMirrorHostForTests,
  sessionMirrorIdle,
} from '@nessy-agent/shared/sessions/mirror/host'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const MIRROR_ROOT = join(CONFIG_DIR, 'mirror-error-root')
const WS = 'ws_mirror_err'

const managers: SessionManager[] = []

// See session-mirror-restore.test.ts: `cleanup()` is async and persists live
// sessions, so an un-awaited one lets a mirror dispatch escape into the next
// test with this test's settings already resolved.
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup()
  await sessionMirrorIdle()
  resetSessionMirrorHostForTests()
  rmSync(CONFIG_FILE, { force: true })
  rmSync(MIRROR_ROOT, { force: true })
  rmSync(join(SESSIONS_DIR, WS), { recursive: true, force: true })
})

describe('mirror_error transcript surfacing', () => {
  it('a dropped mirror batch appends one mirror_error system message and never blocks the local write', async () => {
    // Unwritable mirror: the configured root is a file.
    writeFileSync(MIRROR_ROOT, 'not a directory', 'utf-8')
    writeFileSync(CONFIG_FILE, JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      sessionMirror: { adapter: 'directory', path: MIRROR_ROOT },
    }), 'utf-8')
    resetSessionMirrorHostForTests()

    const manager = createTestSessionManager()
    managers.push(manager)
    const managed = createManagedSession({ id: 'mirror-err-session' }, {
      id: WS,
      name: 'Mirror Error Workspace',
      rootPath: '/tmp/nessy-mirror-error',
      createdAt: 1,
    } as never, { messagesLoaded: true })
    managed.messages.push({
      id: 'm-1',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      `${WS}:mirror-err-session`,
      managed,
    )
    const internals = manager as unknown as {
      persistSession(managed: unknown): void
      flushSession(sessionId: string, workspaceId?: string): Promise<void>
    }

    internals.persistSession(managed)
    await internals.flushSession('mirror-err-session', WS)
    await sessionMirrorIdle()

    // Local disk first and authoritative.
    const localFile = join(SESSIONS_DIR, WS, 'mirror-err-session', 'session.jsonl')
    expect(existsSync(localFile)).toBe(true)
    expect(readFileSync(localFile, 'utf-8')).toContain('hello')

    const mirrorErrors = managed.messages.filter(message => message.errorCode === 'mirror_error')
    expect(mirrorErrors).toHaveLength(1)
    expect(mirrorErrors[0]!.role).toBe('info')
    expect(mirrorErrors[0]!.infoLevel).toBe('warning')
    expect(mirrorErrors[0]!.content).toContain('mirror')

    // The same failing reason does not stack a message per flush.
    internals.persistSession(managed)
    await internals.flushSession('mirror-err-session', WS)
    await sessionMirrorIdle()
    expect(managed.messages.filter(message => message.errorCode === 'mirror_error')).toHaveLength(1)
  })
})
