import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core/types'
import type { Workspace } from '@craft-agent/shared/config'
import { createManagedSession, SessionManager } from './SessionManager.ts'

type TestManagedSession = ReturnType<typeof createManagedSession>

const workspace: Workspace = {
  id: 'workspace-nessy',
  name: 'nessy-cli',
  slug: 'nessy-cli',
  rootPath: '/tmp/nessy-cli',
  createdAt: Date.parse('2026-06-17T12:00:00.000Z'),
}

function addSession(
  manager: SessionManager,
  managed: TestManagedSession,
): void {
  (
    manager as unknown as { sessions: Map<string, TestManagedSession> }
  ).sessions.set(managed.id, managed)
}

describe('SessionManager Nessy canonical mirror filtering', () => {
  it('hides empty placeholder mirrors even when they have timestamps', () => {
    const manager = new SessionManager()
    const sessionId = '8390af4d-5db6-4e4c-b7e8-040d002690c7'
    const timestamp = Date.parse('2026-06-17T10:15:30.000Z')

    addSession(
      manager,
      createManagedSession(
        {
          id: sessionId,
          sdkSessionId: sessionId,
          name: '(session)',
          messageCount: 0,
          createdAt: timestamp,
          lastUsedAt: timestamp,
          lastMessageAt: timestamp,
          llmConnection: 'nessy-cli',
        },
        workspace,
      ),
    )

    expect(manager.getSessions(workspace.id)).toEqual([])
  })

  it('keeps external sessions with a real title or content', () => {
    const manager = new SessionManager()
    const titledSessionId = '12eb7d24-4c31-4ff5-8a9b-f243f9fd1b28'
    const contentSessionId = 'bbc6bd08-a4f7-4b50-b605-51dbe51ea2de'
    const timestamp = Date.parse('2026-06-17T10:15:30.000Z')

    addSession(
      manager,
      createManagedSession(
        {
          id: titledSessionId,
          sdkSessionId: titledSessionId,
          name: 'Investigate Windows path expansion',
          messageCount: 0,
          lastMessageAt: timestamp,
          llmConnection: 'nessy-cli',
        },
        workspace,
      ),
    )
    addSession(
      manager,
      createManagedSession(
        {
          id: contentSessionId,
          sdkSessionId: contentSessionId,
          name: '(session)',
          lastMessageAt: timestamp - 1,
          llmConnection: 'nessy-cli',
        },
        workspace,
        {
          messages: [
            {
              id: 'msg_1',
              role: 'user',
              content: 'real conversation content',
              timestamp,
            } as Message,
          ],
        },
      ),
    )

    expect(
      manager
        .getSessions(workspace.id)
        .map((session) => session.id)
        .sort(),
    ).toEqual([contentSessionId, titledSessionId].sort())
  })

  it('treats malformed empty placeholder records as filterable', () => {
    const manager = new SessionManager()
    const sessionId = 'malformed-placeholder'
    const internals = manager as unknown as {
      isUnresolvedNessyCanonicalMirror: (
        managed: Record<string, unknown>,
      ) => boolean
    }
    const malformed = {
      id: sessionId,
      sdkSessionId: sessionId,
      name: '(session)',
      messageCount: 0,
      createdAt: Date.parse('2026-06-17T10:15:30.000Z'),
      lastMessageAt: Date.parse('2026-06-17T10:15:30.000Z'),
      llmConnection: 'nessy-cli',
    }

    expect(() =>
      internals.isUnresolvedNessyCanonicalMirror(malformed),
    ).not.toThrow()
    expect(internals.isUnresolvedNessyCanonicalMirror(malformed)).toBe(true)
  })
})
