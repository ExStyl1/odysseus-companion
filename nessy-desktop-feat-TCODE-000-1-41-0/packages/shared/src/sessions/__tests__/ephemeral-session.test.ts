import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSession,
  getSessionFilePath,
  loadSession,
  sessionPersistenceQueue,
} from '../storage.ts'
import { SESSIONS_DIR } from '../../workspaces/paths.ts'

describe('ephemeral session storage', () => {
  let workspaceId: string

  beforeEach(() => {
    workspaceId = `ephemeral-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`
  })

  afterEach(() => {
    mock.restore()
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  it('skips the create-time session record write when ephemeral is true', async () => {
    const enqueueSpy = spyOn(sessionPersistenceQueue, 'enqueue')

    const session = await createSession(workspaceId, {
      name: 'scratch',
      ephemeral: true,
    })

    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(existsSync(getSessionFilePath(workspaceId, session.id))).toBe(false)
    expect(loadSession(workspaceId, session.id)).toBeNull()
  })

  it('preserves normal create-time persistence when ephemeral is omitted', async () => {
    const enqueueSpy = spyOn(sessionPersistenceQueue, 'enqueue')

    const session = await createSession(workspaceId, { name: 'persisted' })

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(existsSync(getSessionFilePath(workspaceId, session.id))).toBe(true)
    expect(loadSession(workspaceId, session.id)?.name).toBe('persisted')
  })
})
