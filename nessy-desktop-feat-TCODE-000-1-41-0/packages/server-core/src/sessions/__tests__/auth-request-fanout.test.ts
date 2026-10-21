/**
 * UB3.10 — one sign-in serves every session paused on the same source's OAuth:
 * `completeAuthRequestsForSource` answers every session in the workspace
 * pending on that source, plus the bound cards whose session lost the in-memory
 * request (a restart). Upstream: `sessions/auth-request-fanout.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthRequest } from '@nessy-agent/shared/agent'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key.ts'
import { createManagedSession, SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/** The persisted message shape a managed session's transcript holds. */
type CardMessage = ReturnType<typeof createManagedSession>['messages'][number]

describe('SessionManager.completeAuthRequestsForSource', () => {
  let tmpRoot: string
  let sm: SessionManager
  let resumed: Array<{ sessionId: string; message: string }>
  let events: Array<Record<string, unknown>>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-auth-fanout-'))
    sm = createTestSessionManager()
    resumed = []
    events = []
    const stub = sm as unknown as Record<string, unknown>
    stub.persistSession = () => {}
    stub.sendEvent = (event: Record<string, unknown>) => { events.push(event) }
    // The resumed turn never finishes here: completing must not wait on it
    stub.sendMessage = (sessionId: string, message: string) => {
      resumed.push({ sessionId, message })
      return new Promise<void>(() => {})
    }
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function session(id: string, workspaceId: string, pending?: Partial<AuthRequest> & { type: AuthRequest['type'] }) {
    const workspace = { id: workspaceId, name: workspaceId, rootPath: join(tmpRoot, workspaceId), createdAt: Date.now() }
    const managed = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true })
    if (pending) {
      const request = { requestId: `auth-${id}`, sessionId: id, sourceName: pending.sourceSlug, ...pending } as AuthRequest
      managed.pendingAuthRequest = request
      managed.pendingAuthRequestId = request.requestId
      managed.messages.push(authCard(request.requestId, request.sourceSlug!))
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(encodeSessionKey({ workspaceId, sessionId: id }), managed)
    return managed
  }

  function authCard(requestId: string, sourceSlug: string): CardMessage {
    return {
      id: `msg-${requestId}`,
      role: 'auth-request',
      content: '',
      timestamp: Date.now(),
      authRequestId: requestId,
      authRequestType: 'oauth-google',
      authSourceSlug: sourceSlug,
      authStatus: 'pending',
    } as unknown as CardMessage
  }

  it('answers every session in the workspace paused on the source, and nothing else', () => {
    const first = session('s1', 'ws-1', { type: 'oauth-google', sourceSlug: 'gmail' })
    const second = session('s2', 'ws-1', { type: 'oauth-google', sourceSlug: 'gmail' })
    const otherSource = session('s3', 'ws-1', { type: 'oauth-google', sourceSlug: 'calendar' })
    const otherWorkspace = session('s4', 'ws-2', { type: 'oauth-google', sourceSlug: 'gmail' })
    const credentialForm = session('s5', 'ws-1', { type: 'credential', sourceSlug: 'gmail' })
    session('s6', 'ws-1')

    const ids = sm.completeAuthRequestsForSource('ws-1', 'gmail', { email: 'me@example.com' })

    expect(ids).toEqual(['s1', 's2'])
    for (const managed of [first, second]) {
      expect(managed.pendingAuthRequest).toBeUndefined()
      expect(managed.messages[0]!.authStatus).toBe('completed')
      expect(managed.messages[0]!.authEmail).toBe('me@example.com')
      expect(managed.enabledSourceSlugs).toContain('gmail')
    }
    for (const managed of [otherSource, otherWorkspace, credentialForm]) {
      expect(managed.pendingAuthRequest).toBeDefined()
      expect(managed.messages[0]!.authStatus).toBe('pending')
    }
    expect(resumed.map(r => r.sessionId)).toEqual(['s1', 's2'])
    expect(resumed.every(r => r.message.includes('gmail'))).toBe(true)
    expect(events.filter(e => e.type === 'auth_completed').map(e => [e.sessionId, e.requestId])).toEqual([
      ['s1', 'auth-s1'],
      ['s2', 'auth-s2'],
    ])
  })

  it('answers a clicked card whose session forgot the request (restart), but not a finished one', () => {
    const restarted = session('s1', 'ws-1')
    restarted.messages.push(authCard('auth-old', 'gmail'))
    const finished = session('s2', 'ws-1')
    finished.messages.push({ ...authCard('auth-done', 'gmail'), authStatus: 'cancelled' })

    const ids = sm.completeAuthRequestsForSource('ws-1', 'gmail', {}, [
      { sessionId: 's1', authRequestId: 'auth-old' },
      { sessionId: 's2', authRequestId: 'auth-done' },
    ])

    expect(ids).toEqual(['s1'])
    expect(restarted.messages[0]!.authStatus).toBe('completed')
    expect(finished.messages[0]!.authStatus).toBe('cancelled')
    expect(resumed.map(r => r.sessionId)).toEqual(['s1'])
  })

  it('a bound card does not override a different request the session is waiting on', () => {
    const managed = session('s1', 'ws-1', { type: 'oauth', sourceSlug: 'linear' })
    managed.messages.push(authCard('auth-stale', 'gmail'))

    const ids = sm.completeAuthRequestsForSource('ws-1', 'gmail', {}, [{ sessionId: 's1', authRequestId: 'auth-stale' }])

    expect(ids).toEqual([])
    expect(managed.pendingAuthRequest?.requestId).toBe('auth-s1')
  })

  it('clears the refresh cooldown for the source in every session of the workspace', () => {
    const waiting = session('s1', 'ws-1', { type: 'oauth-google', sourceSlug: 'gmail' })
    const idle = session('s2', 'ws-1')
    const elsewhere = session('s3', 'ws-2')
    const cleared: string[] = []
    for (const managed of [waiting, idle, elsewhere]) {
      managed.tokenRefreshManager.clearCooldown = (slug: string) => { cleared.push(`${managed.id}:${slug}`) }
    }

    sm.completeAuthRequestsForSource('ws-1', 'gmail', {})

    expect(new Set(cleared)).toEqual(new Set(['s1:gmail', 's2:gmail']))
  })
})
