import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  loadSession,
  writeSessionJsonl,
  type StoredSession,
} from '@nessy-agent/shared/sessions'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { StoredMessage } from '@nessy-agent/core/types'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

// Regression test for the silent-drop bug in persistSession:
//
//   On startup, sessions load with messagesLoaded=false and only get loaded
//   on first getSession(). The old persistSession early-returned in that
//   state to avoid wiping the JSONL with []. As a result, status/label/rename
//   changes on sessions the user hadn't opened since restart were never
//   written to disk and were lost on the next restart.
//
// The fix routes cold-session persists through ensureMessagesLoaded so the
// existing JSONL messages are loaded first, then the full record (with the
// new metadata) is enqueued. flushSession awaits the in-flight load+enqueue
// so durability holds for sync mutate-then-flush callers.

describe('cold-session metadata persistence', () => {
  let workspaceId: string
  let sm: SessionManager

  beforeEach(() => {
    workspaceId = `ws-cold-meta-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sm = createTestSessionManager()
  })

  afterEach(() => {
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  function buildWorkspace() {
    return {
      id: workspaceId,
      name: 'Test Workspace',
      rootPath: join(SESSIONS_DIR, '..', 'workspaces', workspaceId),
      createdAt: Date.now(),
    } as never
  }

  // Seed a session JSONL on disk to simulate a session present from a
  // previous app run, then register it in the SessionManager with the
  // post-restart `messagesLoaded: false` state — i.e. metadata only.
  function seedColdSession(
    sessionId: string,
    opts: {
      name?: string
      sessionStatus?: string
      labels?: string[]
      messages?: StoredMessage[]
    } = {},
  ) {
    const filePath = getSessionFilePath(workspaceId, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored: StoredSession = {
      id: sessionId,
      workspaceId,
      name: opts.name ?? 'cold session',
      sessionStatus: opts.sessionStatus ?? 'todo',
      labels: opts.labels ?? [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: opts.messages ?? [],
    } as StoredSession
    writeSessionJsonl(filePath, stored)

    const managed = createManagedSession(
      {
        id: sessionId,
        name: stored.name,
        sessionStatus: stored.sessionStatus,
        labels: stored.labels,
        createdAt: stored.createdAt,
      },
      buildWorkspace(),
      // messagesLoaded defaults to false — this is the cold-session state.
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
  }

  function readDiskHeader(sessionId: string): Record<string, unknown> {
    const path = getSessionFilePath(workspaceId, sessionId)
    // `split` never returns an empty array, so [0] is always present — but the
    // flag cannot know that, and an assertion here beats a `!`: an EMPTY header
    // line would otherwise reach `JSON.parse` and fail as a syntax error two
    // frames away from the file that is actually wrong.
    const firstLine = readFileSync(path, 'utf-8').split('\n')[0]
    if (firstLine === undefined || firstLine === '') {
      throw new Error(`session file has no header line: ${path}`)
    }
    return JSON.parse(firstLine)
  }

  function readDiskMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(workspaceId, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n').slice(1)
    return lines.map(l => JSON.parse(l)).map(m => m.id as string)
  }

  function makeUserMessage(id: string, content: string): StoredMessage {
    return { id, type: 'user', content, timestamp: Date.now() } as StoredMessage
  }

  it('setSessionStatus on a cold session is on disk after flushSession resolves', async () => {
    const sessionId = 'cold-status'
    seedColdSession(sessionId, { sessionStatus: 'todo' })

    await sm.setSessionStatus(sessionId, 'done')

    const header = readDiskHeader(sessionId)
    expect(header.sessionStatus).toBe('done')

    // Independently re-load from disk via the production loader to confirm
    // round-trip integrity.
    const reloaded = loadSession(workspaceId, sessionId)
    expect(reloaded?.sessionStatus).toBe('done')
  })

  it('setSessionLabels on a cold session is on disk after flushSession resolves', async () => {
    const sessionId = 'cold-labels'
    seedColdSession(sessionId, { labels: [] })

    await sm.setSessionLabels(sessionId, ['urgent', 'bug'])

    const header = readDiskHeader(sessionId)
    expect(header.labels).toEqual(['urgent', 'bug'])

    const reloaded = loadSession(workspaceId, sessionId)
    expect(reloaded?.labels).toEqual(['urgent', 'bug'])
  })

  it('renameSession on a cold session persists (with an explicit flushSession too)', async () => {
    const sessionId = 'cold-rename'
    seedColdSession(sessionId, { name: 'old name' })

    // The extra `flushSession` is now a NO-OP rather than the point of the case.
    // This comment used to say it mirrors "the production order (rename →
    // flushSession)"; no production caller ever flushed after a rename — the RPC
    // handler's `case 'rename'` returns `renameSession` and nothing else — and
    // C3.387 made `renameSession` flush for itself, which is what makes that
    // sentence true at last. Kept as written because a second flush must stay
    // harmless: `flushSession` is public and callers exist.
    await sm.renameSession(sessionId, 'new name')
    await sm.flushSession(sessionId)

    const header = readDiskHeader(sessionId)
    expect(header.name).toBe('new name')
  })

  it('C3.387 — renameSession is on disk when it RESOLVES, with no external flush', async () => {
    // The case RV needed and nobody had. `renameSession` was the one
    // user-visible metadata mutation in `SessionManager` that left its write in
    // the 500 ms debounce, so anything reloading the session inside that window
    // — including the file-watcher notification the method itself fires two
    // lines later — read a nameless `session.jsonl` and put `undefined` back
    // over the name the user had just typed.
    //
    // Deliberately NO `flushSession` here: with one, this case passes on the
    // old code and measures nothing. It is the same shape the `setSessionStatus`
    // and `setSessionLabels` cases above already have, which is the whole
    // asymmetry this row closes.
    const sessionId = 'cold-rename-no-flush'
    seedColdSession(sessionId, { name: 'old name' })

    await sm.renameSession(sessionId, 'durable name')

    expect(readDiskHeader(sessionId).name).toBe('durable name')
    // …and through the production loader, which is what a reload would use.
    expect(loadSession(workspaceId, sessionId)?.name).toBe('durable name')
  })

  it('cold-session persist preserves existing messages on disk', async () => {
    const sessionId = 'cold-preserve-msgs'
    const seededMessages = [
      makeUserMessage('m1', 'hello'),
      makeUserMessage('m2', 'world'),
      makeUserMessage('m3', 'three'),
    ]
    seedColdSession(sessionId, { messages: seededMessages })

    // Sanity: messages are on disk before mutation.
    expect(readDiskMessageIds(sessionId)).toEqual(['m1', 'm2', 'm3'])

    await sm.setSessionStatus(sessionId, 'done')

    // Header reflects the new status…
    expect(readDiskHeader(sessionId).sessionStatus).toBe('done')
    // …and the seeded messages survive (regression: original guard's intent).
    expect(readDiskMessageIds(sessionId)).toEqual(['m1', 'm2', 'm3'])
  })

  it('concurrent cold-session status changes serialize to last-writer-wins on disk', async () => {
    const sessionId = 'cold-concurrent'
    seedColdSession(sessionId, { sessionStatus: 'todo' })

    // Fire two mutations back-to-back without awaiting the first. Both flow
    // through the cold-persist path; ensureMessagesLoaded dedupes the load,
    // and the persistence queue debounces enqueues. Both calls must resolve
    // and disk must reflect the second value with no JSONL corruption.
    const p1 = sm.setSessionStatus(sessionId, 'in-progress')
    const p2 = sm.setSessionStatus(sessionId, 'done')
    await Promise.all([p1, p2])

    // Disk header has the last value.
    expect(readDiskHeader(sessionId).sessionStatus).toBe('done')

    // JSONL is well-formed: every line parses, none is empty.
    const lines = readFileSync(getSessionFilePath(workspaceId, sessionId), 'utf-8')
      .trim()
      .split('\n')
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(0)
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('flushSession on a cold session returns only after the disk write lands', async () => {
    const sessionId = 'cold-flush-ordering'
    seedColdSession(sessionId, { sessionStatus: 'todo' })

    // Mirror the production pattern where a caller mutates and immediately
    // flushes (e.g. setSessionStatus, or any UI flow that quits the app
    // right after a metadata change). The disk must reflect the new value
    // by the time flushSession resolves — no debounce window.
    const managed = (sm as unknown as { sessions: Map<string, { sessionStatus?: string }> })
      .sessions.get(`${workspaceId}:${sessionId}`)!
    managed.sessionStatus = 'cancelled'
    ;(sm as unknown as { persistSession: (m: unknown) => void }).persistSession(managed)
    await sm.flushSession(sessionId)

    expect(readDiskHeader(sessionId).sessionStatus).toBe('cancelled')
  })
})
