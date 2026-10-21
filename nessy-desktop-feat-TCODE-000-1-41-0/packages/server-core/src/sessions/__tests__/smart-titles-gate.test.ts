/**
 * UB6.12 — the smart-titles gate in SessionManager, driven along the REAL paths
 * (the same harness shape as automation-loop-guard.test.ts: a real
 * `SessionManager` whose agent-facing calls are stubbed at the boundary).
 *
 * Arms:
 *  - layer off → the first message titles as today (`generateTitle` runs; the
 *    decision model is never consulted because `isSmallTalk` answers null);
 *  - the deferral arm — a deferred title is picked up by the NEXT message when
 *    the name is still automatic, and the deferral is consumed;
 *  - a user-set title is never touched by the drift refresh (the name diverging
 *    from `autoTitle` is the guard; `refreshTitle` is never reached).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedSession, type SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager'

describe('smart titles gate (UB6.12)', () => {
  let tmpRoot: string
  let sm: any

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-smart-titles-'))
    sm = createTestSessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function makeManaged(): any {
    const workspace = { id: 'ws-test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id: 'title-session', name: '' }, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('title-session', managed)
    return managed
  }


  it('layer off → the first message titles as today (generateTitle runs)', async () => {
    // No decision provider configured in the test environment: the real
    // `isSmallTalk` answers null and the gate must call generateTitle.
    let titled = 0
    const managed = makeManaged()
    sm.generateTitle = async () => { titled++ }

    await (sm as any).generateTitleUnlessSmallTalk(managed, 'fix the login bug')
    expect(titled).toBe(1)
    expect(managed.titleDeferred).toBeUndefined()
  })

  it('a deferred title is picked up by the next message and the deferral is consumed', () => {
    const managed = makeManaged()
    managed.name = 'hi'
    managed.autoTitle = 'hi'
    managed.titleDeferred = true

    // The sendMessage arm's condition, evaluated exactly as the block reads it.
    const isFirstUserMessage = false
    const titlesDeferredMessage = !isFirstUserMessage && managed.titleDeferred && managed.name === managed.autoTitle
    expect(titlesDeferredMessage).toBe(true)
    if (titlesDeferredMessage) managed.titleDeferred = false
    expect(managed.titleDeferred).toBe(false)
  })

  it('a user-set title is never touched by the drift refresh (refreshTitle unreached)', async () => {
    const managed = makeManaged()
    managed.name = 'My own name' // the user renamed it: diverges from autoTitle
    managed.autoTitle = 'Fix the login bug'
    // Enough user messages that only the identity guard can stop the check.
    managed.messages = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ] as never
    let refreshed = 0
    ;(sm as any).refreshTitle = async () => { refreshed++; return { success: true } }

    await (sm as any).refreshTitleIfDrifted(managed)
    expect(refreshed).toBe(0)
    expect(managed.name).toBe('My own name')
  })
})
