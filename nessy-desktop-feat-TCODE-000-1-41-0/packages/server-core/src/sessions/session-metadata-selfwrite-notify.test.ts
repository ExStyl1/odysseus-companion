/**
 * W6 regression — self-write session-metadata notify reaches automation handling.
 *
 * Sessions moved to the global SESSIONS_DIR/<workspaceId> partition (W5), so
 * the old workspace-relative `notifyFileChange('sessions/<id>/session.jsonl')`
 * Linux-workaround calls in SessionManager became silent no-ops (the watcher's
 * `sessions/` branch no longer exists). The five self-write sites (flag/unflag/
 * status/title/labels) now call `notifySessionPartitionFileChange()`, which
 * routes to `onSessionMetadataChange` → `automationSystem.updateSessionMetadata`.
 *
 * This test drives the REAL `flagSession()` path end-to-end: persist → flush →
 * self-write notify → watcher header read from the global partition → automation
 * metadata update. It fails on the pre-fix code (notify was a no-op).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getWorkspaceSessionRootPath } from '@nessy-agent/shared/workspaces'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

const WORKSPACE_ID = 'ws_selfwrite_notify'
const SESSION_ID = 'selfwrite-flag-session'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('session-metadata self-write notify (W6)', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-selfwrite-'))
    sm = createTestSessionManager()
  })

  afterEach(() => {
    sm.cleanup()
    rmSync(tmpRoot, { recursive: true, force: true })
    try {
      rmSync(getWorkspaceSessionRootPath(WORKSPACE_ID), { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  it('flagSession self-write reaches automationSystem.updateSessionMetadata', async () => {
    const workspaceRoot = join(tmpRoot, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    sm.setupConfigWatcher(workspaceRoot, WORKSPACE_ID)

    // Spy on the real AutomationSystem the watcher callbacks resolve by ID.
    const automationSystem = (sm as unknown as {
      automationSystems: Map<string, { updateSessionMetadata: (sessionId: string, metadata: Record<string, unknown>) => Promise<void> }>
    }).automationSystems.get(WORKSPACE_ID)
    expect(automationSystem).toBeDefined()
    const updates: Array<{ sessionId: string; metadata: Record<string, unknown> }> = []
    const original = automationSystem!.updateSessionMetadata.bind(automationSystem)
    automationSystem!.updateSessionMetadata = async (sessionId, metadata) => {
      updates.push({ sessionId, metadata })
      return original(sessionId, metadata)
    }

    // Register a managed session in the ID-keyed sessions map.
    const workspace = {
      id: WORKSPACE_ID,
      name: 'Self-Write Notify Workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id: SESSION_ID, name: SESSION_ID },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${WORKSPACE_ID}:${SESSION_ID}`, managed)

    // Drive the real self-write path: persists session.jsonl into the global
    // partition, then notifies the watcher (the Linux fs.watch workaround).
    await sm.flagSession(SESSION_ID, WORKSPACE_ID)

    // Debounced (SESSION_META_DEBOUNCE_MS) → allow the notify to flush.
    await wait(500)

    const flagUpdate = updates.find(u => u.sessionId === SESSION_ID)
    expect(flagUpdate).toBeDefined()
    expect(flagUpdate!.metadata.isFlagged).toBe(true)
  })
})
