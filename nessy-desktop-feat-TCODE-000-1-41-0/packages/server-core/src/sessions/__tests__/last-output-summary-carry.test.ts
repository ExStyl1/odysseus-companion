/**
 * P6.504, the last hop. The store computes `lastOutputSummary` into the session
 * HEADER (derived from the session's own output, never a model request — Q-den
 * 22 = A), and `ManagedSession` hand-copies every precomputed header field into
 * the DTO. Until this field was copied, the renderer's row line was always
 * `undefined` no matter what the store wrote, and nothing anywhere failed.
 *
 * So the invariant under test is the copy itself: what a managed session holds
 * is what `getSession` returns. The negative control is a session that has
 * produced nothing yet — the field stays absent rather than becoming an empty
 * string, because the renderer distinguishes the two.
 */
import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { createTestSessionManager } from './test-session-manager'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

const WORKSPACE_ID = 'workspace-last-output-summary'

function seedManaged(manager: any, id: string, extra: Record<string, unknown>): void {
  const workspaceId = WORKSPACE_ID
  manager.sessions.set(encodeSessionKey({ workspaceId, sessionId: id }), {
    id,
    workspace: { id: workspaceId, rootPath: tmpdir(), sessionRootPath: tmpdir() },
    messages: [],
    messagesLoaded: true,
    ...extra,
  })
}

describe('P6.504 lastOutputSummary reaches the session DTO', () => {
  test('a managed session carrying the header line hands it to getSession', async () => {
    const manager = createTestSessionManager() as any
    seedManaged(manager, 'session-with-summary', {
      preview: 'the first thing the user typed',
      lastOutputSummary: 'Renamed the two callers and left the third alone.',
    })
    const session = await manager.getSession('session-with-summary', 'workspace-last-output-summary')
    expect(session?.lastOutputSummary).toBe('Renamed the two callers and left the third alone.')
    // The preview is a DIFFERENT field with a different meaning (the first user
    // message) and must not be displaced by the summary.
    expect(session?.preview).toBe('the first thing the user typed')
    manager.sessions.delete(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId: 'session-with-summary' }))
    await manager.cleanup()
  })

  test('a session that has produced nothing carries no line at all', async () => {
    const manager = createTestSessionManager() as any
    seedManaged(manager, 'session-without-summary', { preview: 'just asked' })
    const session = await manager.getSession('session-without-summary', 'workspace-last-output-summary')
    expect(session?.lastOutputSummary).toBeUndefined()
    manager.sessions.delete(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId: 'session-without-summary' }))
    await manager.cleanup()
  })
})
