/** UA3.8 — the delete-cascade predicate (OQ-13). The cascade itself is `sessions/__tests__/orchestrator-delete-cascade.test.ts`. */
import { describe, expect, it } from 'bun:test'
import { isTaskOrchestrator, taskFolderDeletedWith } from './orchestrator-folder'

describe('taskFolderDeletedWith', () => {
  it('positive: a lone orchestrator takes its folder', () => {
    expect(taskFolderDeletedWith([{ id: 'orch', taskSlug: 'fix' }, { id: 'other' }], 'orch')).toBe('fix')
  })

  it('positive: an ARCHIVED carrier of the same slug does not keep the folder (tasks:delete\'s rule)', () => {
    expect(taskFolderDeletedWith([{ id: 'orch', taskSlug: 'fix' }, { id: 'old', taskSlug: 'fix', isArchived: true }], 'orch')).toBe('fix')
  })

  it('negative: a non-orchestrator touches nothing (no slug, or a Conductor child node)', () => {
    expect(taskFolderDeletedWith([{ id: 'plain' }], 'plain')).toBeNull()
    expect(taskFolderDeletedWith([{ id: 'node', taskSlug: 'fix', taskNodeId: 'main' }], 'node')).toBeNull()
    expect(isTaskOrchestrator({ taskSlug: '' })).toBe(false)
  })

  it('negative: two live sessions sharing a slug keep the folder', () => {
    expect(taskFolderDeletedWith([{ id: 'orch', taskSlug: 'fix' }, { id: 'twin', taskSlug: 'fix' }], 'orch')).toBeNull()
  })

  it('negative: a live Conductor child node of the task keeps the folder (it carries the slug); an archived one does not', () => {
    expect(taskFolderDeletedWith([{ id: 'orch', taskSlug: 'fix' }, { id: 'node', taskSlug: 'fix', taskNodeId: 'main' }], 'orch')).toBeNull()
    expect(taskFolderDeletedWith([{ id: 'orch', taskSlug: 'fix' }, { id: 'node', taskSlug: 'fix', taskNodeId: 'main', isArchived: true }], 'orch')).toBe('fix')
  })

  it('boundary: an unknown session id deletes nothing', () => {
    expect(taskFolderDeletedWith([{ id: 'orch', taskSlug: 'fix' }], 'ghost')).toBeNull()
  })
})
