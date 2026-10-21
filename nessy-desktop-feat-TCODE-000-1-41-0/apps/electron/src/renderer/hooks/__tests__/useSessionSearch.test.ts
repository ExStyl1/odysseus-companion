import { describe, it, expect } from 'bun:test'
import { computeCollapsedPagination } from '../useSessionSearch'
import type { SessionMeta } from '@/atoms/sessions'

function makeSession(id: string, opts: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    workspaceId: 'ws-1',
    sessionStatus: 'in-progress',
    lastMessageAt: Date.parse('2026-03-05T10:00:00.000Z'),
    ...opts,
  }
}

describe('computeCollapsedPagination', () => {
  it('does not hide items when current view has only one group and that group is collapsed', () => {
    const sessions = [
      makeSession('s1'),
      makeSession('s2'),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['2026-03-05T00:00:00.000Z']),
      'date'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['s1', 's2'])
    expect(result.collapsedGroupsMeta).toEqual([])
    expect(result.hasMore).toBe(false)
  })

  it('still collapses normally when multiple groups exist', () => {
    const sessions = [
      makeSession('today', { lastMessageAt: Date.parse('2026-03-06T10:00:00.000Z') }),
      makeSession('yesterday', { lastMessageAt: Date.parse('2026-03-05T10:00:00.000Z') }),
      makeSession('older', { lastMessageAt: Date.parse('2026-03-04T10:00:00.000Z') }),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['2026-03-05T00:00:00.000Z']),
      'date'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['today', 'older'])
    expect(result.collapsedGroupsMeta).toEqual([{ key: '2026-03-05T00:00:00.000Z', count: 1 }])
    expect(result.hasMore).toBe(false)
  })

  it('ignores collapsed keys that are not present in current view', () => {
    const sessions = [
      makeSession('a', { sessionStatus: 'in-progress' }),
      makeSession('b', { sessionStatus: 'done' }),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['status-todo']),
      'status'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['a', 'b'])
    expect(result.collapsedGroupsMeta).toEqual([])
  })
})

describe('UA12.121 — a session bound to a deleted project collapses with "No project"', () => {
  // The grouping (`groupSessionRowsByProject`) resolves a projectId no workspace project has into
  // NO_PROJECT_GROUP_KEY, so the row SHOWS under "No project" — while the collapse key keyed it
  // blindly as `project-<gone>`. Collapsing "No project" then left those rows paginated under a
  // collapsed header. UA12.121: the collapse key routes through `projectGroupKeyOf`.
  const stale = makeSession('stale', { projectId: 'gone' })
  const bound = makeSession('bound', { projectId: 'p1' })
  const unbound = makeSession('unbound')
  const KNOWN = new Set(['p1'])

  it('DEFECT — collapsing "No project" paginates the stale-bound row away with the unbound one (red at HEAD: the stale row stayed)', () => {
    const result = computeCollapsedPagination([bound, stale, unbound], 50, new Set(['project-__none__']), 'project', KNOWN)
    expect(result.paginatedItems.map(s => s.id)).toEqual(['bound'])
    expect(result.collapsedGroupsMeta).toEqual([{ key: 'project-__none__', count: 2 }])
    expect(result.hasMore).toBe(false)
  })

  it('ROUTING — the stale row\'s key IS the No-project key, so the blind `project-<gone>` key matches nothing', () => {
    const result = computeCollapsedPagination([bound, stale, unbound], 50, new Set(['project-gone']), 'project', KNOWN)
    expect(result.paginatedItems.map(s => s.id)).toEqual(['bound', 'stale', 'unbound'])
    expect(result.collapsedGroupsMeta).toEqual([])
  })

  it('CONTROL — a known project still collapses under its own key alone', () => {
    const result = computeCollapsedPagination([bound, stale, unbound], 50, new Set(['project-p1']), 'project', KNOWN)
    expect(result.paginatedItems.map(s => s.id)).toEqual(['stale', 'unbound'])
    expect(result.collapsedGroupsMeta).toEqual([{ key: 'project-p1', count: 1 }])
  })

  it('FALLBACK — without a known-id set the blind key stands (callers that pass none keep today\'s keys)', () => {
    const result = computeCollapsedPagination([bound, stale, unbound], 50, new Set(['project-gone']), 'project')
    expect(result.paginatedItems.map(s => s.id)).toEqual(['bound', 'unbound'])
    expect(result.collapsedGroupsMeta).toEqual([{ key: 'project-gone', count: 1 }])
  })
})
