/**
 * UA12.48 — an archived orchestrator keeps its `taskSlug` while archived (`orchestrator-folder.ts`
 * DECIDED: it records what the session orchestrated), but nothing reserves the slug once no LIVE
 * carrier remains: `tasks:delete` refuses only live carriers (`task-slug-in-use`), the delete cascade
 * removes the folder the same way, and `takenTaskSlugs` counts live carriers only — so a later task
 * can take the slug. Unarchiving the old carrier then must not leave two sessions sharing one slug:
 * the stale slug is dropped in `unarchiveSession` (the one body every unarchive path reaches) and the
 * clear travels as `taskSlug: null` (the wire's clear value — `dto.ts` `SessionMetadataChanges`).
 */

import { describe, expect, it } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession, type SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'
import { taskFolderDeletedWith } from '../../tasks/orchestrator-folder.ts'

const WS = 'ws-ua12-48'

interface Harness {
  sm: SessionManager
  events: Array<{ type: string; changes?: unknown }>
  managed: (id: string) => Record<string, unknown>
}

function harness(seeds: Record<string, Record<string, unknown>>): Harness {
  const sm = createTestSessionManager()
  const events: Array<{ type: string; changes?: unknown }> = []
  const any = sm as unknown as Record<string, unknown> & { sessions: Map<string, Record<string, unknown>> }
  any.sendEvent = (event: { type: string; changes?: unknown }) => { events.push(event) }
  any.persistSession = () => {}
  any.flushSession = async () => {}
  any.emitUnreadSummaryChanged = () => {}
  for (const [id, fields] of Object.entries(seeds)) {
    const managed = createManagedSession(
      { id, ...fields } as never,
      { id: WS, name: WS, rootPath: '/tmp/nessy-ua12-48', createdAt: 1 } as never,
      { messagesLoaded: true },
    ) as unknown as Record<string, unknown>
    any.sessions.set(encodeSessionKey({ workspaceId: WS, sessionId: id }), managed)
  }
  return { sm, events, managed: (id: string) => any.sessions.get(encodeSessionKey({ workspaceId: WS, sessionId: id }))! }
}

describe('UA12.48 — unarchiving an orchestrator whose slug a live session has taken meanwhile', () => {
  it('CONTROL: drops the stale slug — exactly one live session carries it, and the clear rides taskSlug null', async () => {
    const { sm, events, managed } = harness({
      old: { taskSlug: 'x', isArchived: true },
      fresh: { taskSlug: 'x' },
    })
    await sm.unarchiveSession('old', WS)
    expect(managed('old').isArchived).toBe(false)
    expect(managed('old').taskSlug).toBeUndefined()
    expect(managed('fresh').taskSlug).toBe('x')
    const metadata = events.filter(event => event.type === 'session_metadata_changed')
    expect(JSON.parse(JSON.stringify(metadata))).toEqual([
      { type: 'session_metadata_changed', sessionId: 'old', changes: { taskSlug: null } },
    ])
  })

  it('a slug no live session carries survives the unarchive (the normal re-open path strips nothing)', async () => {
    const { sm, events, managed } = harness({ old: { taskSlug: 'x', isArchived: true } })
    await sm.unarchiveSession('old', WS)
    expect(managed('old').isArchived).toBe(false)
    expect(managed('old').taskSlug).toBe('x')
    expect(events.filter(event => event.type === 'session_metadata_changed')).toEqual([])
  })

  it('an ARCHIVED co-carrier does not strip — live carriers are the count, as takenTaskSlugs reads them', async () => {
    const { sm, events, managed } = harness({
      old: { taskSlug: 'x', isArchived: true },
      other: { taskSlug: 'x', isArchived: true },
    })
    await sm.unarchiveSession('old', WS)
    expect(managed('old').taskSlug).toBe('x')
    expect(managed('other').taskSlug).toBe('x')
    expect(events.filter(event => event.type === 'session_metadata_changed')).toEqual([])
  })

  it('unarchiving the SECOND archived carrier after the first went live strips the second — one live carrier at every step', async () => {
    const { sm, managed } = harness({
      a: { taskSlug: 'x', isArchived: true },
      b: { taskSlug: 'x', isArchived: true },
    })
    await sm.unarchiveSession('a', WS)
    expect(managed('a').taskSlug).toBe('x')
    await sm.unarchiveSession('b', WS)
    expect(managed('a').taskSlug).toBe('x')
    expect(managed('b').taskSlug).toBeUndefined()
  })

  // UA12.174 (CRITICAL, 2026-10-08) — Conductor child nodes carry their task's slug by design (`TaskRunner` sets
  // `taskSlug` beside `taskNodeId`) and archiving never cascades, so only a competing live ORCHESTRATOR counts, and a
  // child node is never stripped.
  it('UA12.174 A: an archived run child unarchived while its orchestrator is live keeps its slug, and nothing is sent', async () => {
    const { sm, events, managed } = harness({
      orch: { taskSlug: 'x' },
      child: { taskSlug: 'x', taskNodeId: 'n1', taskRunId: 'r1', parentSessionId: 'orch', isArchived: true },
    })
    await sm.unarchiveSession('child', WS)
    expect(managed('child').isArchived).toBe(false)
    expect(managed('child').taskSlug).toBe('x')
    expect(managed('orch').taskSlug).toBe('x')
    expect(events.filter(event => event.type === 'session_metadata_changed')).toEqual([])
  })

  it('UA12.174 B: an orchestrator archived and unarchived while a child of its own run is live keeps its slug', async () => {
    const { sm, events, managed } = harness({
      orch: { taskSlug: 'x' },
      child: { taskSlug: 'x', taskNodeId: 'n1', taskRunId: 'r1', parentSessionId: 'orch' },
    })
    await sm.archiveSession('orch', WS)
    await sm.unarchiveSession('orch', WS)
    expect(managed('orch').isArchived).toBe(false)
    expect(managed('orch').taskSlug).toBe('x')
    expect(managed('child').taskSlug).toBe('x')
    expect(events.filter(event => event.type === 'session_metadata_changed')).toEqual([])
  })

  it('UA12.174 C: after A, deleting the orchestrator keeps tasks/x/ — the live child still carries the slug', async () => {
    const { sm } = harness({
      orch: { taskSlug: 'x' },
      child: { taskSlug: 'x', taskNodeId: 'n1', taskRunId: 'r1', parentSessionId: 'orch', isArchived: true },
    })
    await sm.unarchiveSession('child', WS)
    expect(taskFolderDeletedWith(sm.getSessions(WS), 'orch')).toBeNull()
  })

  it('UA12.174 residue: a new task whose only live carriers are child nodes does not strip an unarchived orchestrator', async () => {
    const { sm, events, managed } = harness({
      old: { taskSlug: 'x', isArchived: true },
      fresh: { taskSlug: 'x', isArchived: true },
      freshChild: { taskSlug: 'x', taskNodeId: 'n1', taskRunId: 'r1', parentSessionId: 'fresh' },
    })
    await sm.unarchiveSession('old', WS)
    expect(managed('old').taskSlug).toBe('x')
    expect(events.filter(event => event.type === 'session_metadata_changed')).toEqual([])
  })
})
