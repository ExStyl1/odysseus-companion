/**
 * UA12.41 — deleteStatus / resetToDefaults address sessions by the immutable WORKSPACE ID (storage v2).
 * With the root path, listSessions threw "Invalid workspace storage ID" after the config was saved (no live
 * caller today; fixed with labels/crud.ts deleteLabel, which the app does call).
 *
 * The workspace root is the real v2 layout (getWorkspaceRootPath under the isolated test config dir),
 * because listSessions validates each session's status against THAT root's status config
 * (validateSessionStatus).
 *
 * UA12.44 — the migrations read the STORED header (listRawSessionStatuses), not listSessions: through
 * listSessions a status the config no longer has already reads as `todo`, so no header was ever rewritten
 * and the migrated count was always 0. The control is the raw session.jsonl header — after deleteStatus it
 * carries `todo` and the count is 1.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { createStatus, deleteStatus, resetToDefaults } from '../crud.ts'
import { loadStatusConfig, saveStatusConfig, getDefaultStatusConfig } from '../storage.ts'
import { createSession, getSessionFilePath, listSessions } from '../../sessions/storage.ts'
import { readSessionHeader } from '../../sessions/jsonl.ts'
import { getWorkspaceRootPath, getWorkspaceSessionRootPath } from '../../workspaces/paths.ts'

let workspaceRoot: string
let workspaceId: string

beforeEach(() => {
  workspaceId = `ua12-41-${randomUUID()}`
  workspaceRoot = getWorkspaceRootPath(workspaceId)
  mkdirSync(workspaceRoot, { recursive: true })
  saveStatusConfig(workspaceRoot, getDefaultStatusConfig())
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  rmSync(getWorkspaceSessionRootPath(workspaceId), { recursive: true, force: true })
})

const statusOf = (sessionId: string) => listSessions(workspaceId).find(s => s.id === sessionId)?.sessionStatus
const storedStatusOf = (sessionId: string) =>
  readSessionHeader(getSessionFilePath(workspaceId, sessionId))?.sessionStatus

describe('status deletes address sessions by the workspace id', () => {
  it('deleteStatus rewrites the stored header of only the session on the deleted status, and migrated is 1', async () => {
    const blocked = createStatus(workspaceRoot, { label: 'Blocked', color: 'accent', category: 'open' })
    const onDeleted = await createSession(workspaceId, { sessionStatus: blocked.id })
    const elsewhere = await createSession(workspaceId, { sessionStatus: 'done' })
    expect(statusOf(onDeleted.id)).toBe(blocked.id)
    expect(storedStatusOf(onDeleted.id)).toBe(blocked.id)

    await expect(deleteStatus(workspaceRoot, blocked.id, workspaceId)).resolves.toEqual({ migrated: 1 })

    expect(loadStatusConfig(workspaceRoot).statuses.some(s => s.id === blocked.id)).toBe(false)
    expect(statusOf(onDeleted.id)).toBe('todo')
    expect(storedStatusOf(onDeleted.id)).toBe('todo')
    expect(statusOf(elsewhere.id)).toBe('done')
    expect(storedStatusOf(elsewhere.id)).toBe('done')
  })

  it('a fixed status is refused before anything is written, and resetToDefaults rewrites the stored header', async () => {
    const blocked = createStatus(workspaceRoot, { label: 'Blocked', color: 'accent', category: 'open' })
    const custom = await createSession(workspaceId, { sessionStatus: blocked.id })

    await expect(deleteStatus(workspaceRoot, 'done', workspaceId)).rejects.toThrow("Cannot delete fixed status 'done'")
    expect(statusOf(custom.id)).toBe(blocked.id)
    expect(storedStatusOf(custom.id)).toBe(blocked.id)

    await resetToDefaults(workspaceRoot, workspaceId)
    expect(loadStatusConfig(workspaceRoot).statuses.some(s => s.id === blocked.id)).toBe(false)
    expect(statusOf(custom.id)).toBe('todo')
    expect(storedStatusOf(custom.id)).toBe('todo')
  })
})
