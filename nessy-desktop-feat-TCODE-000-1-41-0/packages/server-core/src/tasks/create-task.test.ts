/**
 * UA3.4 — adapted from craft-agents-oss `v0.13.4:packages/server-core/src/tasks/create-task.test.ts` (Apache-2.0):
 * upstream's three `resolveCreateTaskProjectId` arms, plus the NESSY guards of the create core and its slug claim.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveTaskSpec, type TaskSpec } from '@nessy-agent/shared/tasks'
import { assertTaskSlugFree, claimTaskSlug, resolveCreateTaskProjectId, resolveTaskFolderHandle } from './create-task'

describe('resolveCreateTaskProjectId', () => {
  it('inherits the invoking session project when no override is supplied', () => {
    expect(resolveCreateTaskProjectId(undefined, 'project-current')).toBe('project-current')
  })

  it('prefers an explicit project over the invoking session project', () => {
    expect(resolveCreateTaskProjectId('project-explicit', 'project-current')).toBe('project-explicit')
  })

  it('leaves tasks unbound when neither side has a project', () => {
    expect(resolveCreateTaskProjectId(undefined, undefined)).toBeUndefined()
  })
})

describe('UA3.4 — assertTaskSlugFree (create mode never overwrites)', () => {
  const spec = (id: string) => ({ id, title: id, goal: 'g', runner: 'conduct', nodes: [{ id: 'main', prompt: 'p' }] }) as unknown as TaskSpec

  it('a slug with a task.yaml, or carried by a live session, is taken; the owner may re-save its own', () => {
    const root = mkdtempSync(join(tmpdir(), 'ua3-4-slug-'))
    try {
      saveTaskSpec(root, spec('on-disk'))
      const sessions = { getSessions: () => [
        { id: 'orch', taskSlug: 'carried' },
        { id: 'old', taskSlug: 'archived-only', isArchived: true },
      ] } as never
      expect(() => assertTaskSlugFree(sessions, 'ws', root, 'on-disk')).toThrow('task-slug-taken:on-disk')
      expect(() => assertTaskSlugFree(sessions, 'ws', root, 'carried')).toThrow('task-slug-taken:carried')
      // The edit flow: the session that already carries the slug may save onto it.
      expect(() => assertTaskSlugFree(sessions, 'ws', root, 'carried', 'orch')).not.toThrow()
      // Boundary: an archived carrier and a fresh slug are free.
      expect(() => assertTaskSlugFree(sessions, 'ws', root, 'archived-only')).not.toThrow()
      expect(() => assertTaskSlugFree(sessions, 'ws', root, 'brand-new')).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('UA3.4 — claimTaskSlug (the guard and a reservation in one step)', () => {
  it('a claimed slug is taken until released; the release ends it, once; the owner edit flow is not refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'ua3-4-claim-'))
    try {
      const sessions = { getSessions: () => [{ id: 'orch', taskSlug: 'carried' }] } as never
      const release = claimTaskSlug(sessions, 'ws', root, 'dup')
      expect(() => claimTaskSlug(sessions, 'ws', root, 'dup')).toThrow('task-slug-taken:dup')
      expect(() => assertTaskSlugFree(sessions, 'ws', root, 'dup')).toThrow('task-slug-taken:dup')
      // Control: another root and another slug are not held by this claim.
      claimTaskSlug(sessions, 'ws', `${root}-other`, 'dup')()
      claimTaskSlug(sessions, 'ws', root, 'other')()
      release()
      // Boundary: released, the slug is free again; a second release does not drop the newer claim.
      const again = claimTaskSlug(sessions, 'ws', root, 'dup')
      release()
      expect(() => claimTaskSlug(sessions, 'ws', root, 'dup')).toThrow('task-slug-taken:dup')
      again()
      // The edit flow: the carrier may claim its own slug while its earlier claim is still held.
      const edit = claimTaskSlug(sessions, 'ws', root, 'carried', 'orch')
      claimTaskSlug(sessions, 'ws', root, 'carried', 'orch')()
      edit()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('UA3.4 — resolveTaskFolderHandle (handle-only ingress, trusted only)', () => {
  const handle = (trustState: string) => ({ id: 'h-1', workspaceId: 'ws', displayPath: '/p', trustState, expiresAt: 1 })

  it('no folder asked → none; a trusted spec.cwd and a trusted editor handle each resolve to a handle id', async () => {
    const service = {
      validateProjectDirectory: async () => handle('trusted'),
      resolveHandle: async () => handle('trusted'),
    } as never
    expect(await resolveTaskFolderHandle(service, 'ws', {})).toBeUndefined()
    expect(await resolveTaskFolderHandle(service, 'ws', { cwd: '/p' })).toBe('h-1')
    expect(await resolveTaskFolderHandle(service, 'ws', { projectHandleId: 'h-1' })).toBe('h-1')
  })

  it('NEGATIVE: an untrusted folder, an unknown handle, and no handle service are refused', async () => {
    const untrusted = { validateProjectDirectory: async () => handle('unknown'), resolveHandle: async () => null } as never
    await expect(resolveTaskFolderHandle(untrusted, 'ws', { cwd: '/p' })).rejects.toThrow('task-cwd-untrusted')
    await expect(resolveTaskFolderHandle(untrusted, 'ws', { projectHandleId: 'gone' })).rejects.toThrow('project-handle-invalid')
    await expect(resolveTaskFolderHandle(undefined, 'ws', { cwd: '/p' })).rejects.toThrow('project-handle-service-unavailable')
  })
})
