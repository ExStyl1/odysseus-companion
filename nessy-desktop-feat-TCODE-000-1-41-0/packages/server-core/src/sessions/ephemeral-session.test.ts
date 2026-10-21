import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { Session } from '@nessy-agent/shared/protocol'
import {
  getSessionFilePath,
  loadSession,
  saveSession,
  sessionPersistenceQueue,
  type StoredSession,
} from '@nessy-agent/shared/sessions'
import { createManagedSession, SessionManager } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

describe('ephemeral SessionManager persistence', () => {
  let workspaceId: string
  let sm: SessionManager

  beforeEach(() => {
    workspaceId = `ws-ephemeral-sm-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sm = createTestSessionManager()
  })

  afterEach(() => {
    mock.restore()
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  function workspace() {
    return {
      id: workspaceId,
      name: 'Test Workspace',
      rootPath: join(SESSIONS_DIR, '..', 'workspaces', workspaceId),
      createdAt: Date.now(),
    }
  }

  function installManagedSession(sessionId: string, ephemeral: boolean) {
    const managed = createManagedSession(
      { id: sessionId, name: 'scratch', ephemeral },
      workspace() as never,
      { messagesLoaded: true, ephemeral },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
    return managed
  }

  async function seedStoredSession(sessionId: string) {
    await saveSession({
      id: sessionId,
      workspaceId,
      name: 'stored',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    } as StoredSession)
  }

  it('does not enqueue or flush a persisted record for an ephemeral managed session', async () => {
    const managed = installManagedSession('session-ephemeral', true)
    const enqueueSpy = spyOn(sessionPersistenceQueue, 'enqueue')

    ;(sm as unknown as { persistSession(managed: unknown): void }).persistSession(managed)
    await sm.flushSession('session-ephemeral')

    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(existsSync(getSessionFilePath(workspaceId, 'session-ephemeral'))).toBe(false)
  })

  it('keeps direct metadata writes as no-ops for ephemeral sessions', async () => {
    const managed = installManagedSession('session-ephemeral-meta', true)
    const enqueueSpy = spyOn(sessionPersistenceQueue, 'enqueue')

    await (sm as unknown as {
      writeSessionMetadata(managed: unknown, updates: { hasUnread: boolean }): Promise<void>
    }).writeSessionMetadata(managed, { hasUnread: true })

    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(loadSession(workspaceId, 'session-ephemeral-meta')).toBeNull()
  })

  it('preserves direct metadata persistence for normal sessions', async () => {
    const sessionId = 'session-persisted-meta'
    await seedStoredSession(sessionId)
    const managed = installManagedSession(sessionId, false)

    await (sm as unknown as {
      writeSessionMetadata(managed: unknown, updates: { hasUnread: boolean }): Promise<void>
    }).writeSessionMetadata(managed, { hasUnread: true })

    expect(loadSession(workspaceId, sessionId)?.hasUnread).toBe(true)
  })

  it('threads automation ephemeral opt-in into session creation and skips persistence', async () => {
    const enqueueSpy = spyOn(sessionPersistenceQueue, 'enqueue')
    const createdOptions: Array<{ ephemeral?: boolean }> = []

    ;(sm as unknown as {
      createSession(workspaceId: string, options?: { ephemeral?: boolean; name?: string }): Promise<Session>
    }).createSession = async (_workspaceId, options) => {
      createdOptions.push({ ephemeral: options?.ephemeral })
      const id = options?.ephemeral ? 'automation-ephemeral' : 'automation-persisted'
      installManagedSession(id, options?.ephemeral === true)
      return {
        id,
        workspaceId,
        workspaceName: 'Test Workspace',
        name: options?.name,
        lastMessageAt: Date.now(),
        messages: [],
        isProcessing: false,
      } as Session
    }
    ;(sm as unknown as {
      sendMessage(sessionId: string, message: string): Promise<void>
    }).sendMessage = async () => {}

    await sm.executePromptAutomation({
      workspaceId,
      workspaceRootPath: workspace().rootPath,
      prompt: 'run scratch automation',
      ephemeral: true,
    } as Parameters<SessionManager['executePromptAutomation']>[0])

    expect(createdOptions).toEqual([{ ephemeral: true }])
    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(loadSession(workspaceId, 'automation-ephemeral')).toBeNull()
  })

  it('keeps automation sessions persistent by default', async () => {
    const enqueueSpy = spyOn(sessionPersistenceQueue, 'enqueue')
    const createdOptions: Array<{ ephemeral?: boolean }> = []

    ;(sm as unknown as {
      createSession(workspaceId: string, options?: { ephemeral?: boolean; name?: string }): Promise<Session>
    }).createSession = async (_workspaceId, options) => {
      createdOptions.push({ ephemeral: options?.ephemeral })
      const id = 'automation-persisted-default'
      installManagedSession(id, false)
      return {
        id,
        workspaceId,
        workspaceName: 'Test Workspace',
        name: options?.name,
        lastMessageAt: Date.now(),
        messages: [],
        isProcessing: false,
      } as Session
    }
    ;(sm as unknown as {
      sendMessage(sessionId: string, message: string): Promise<void>
    }).sendMessage = async () => {}

    await sm.executePromptAutomation({
      workspaceId,
      workspaceRootPath: workspace().rootPath,
      prompt: 'run persisted automation',
    } as Parameters<SessionManager['executePromptAutomation']>[0])

    expect(createdOptions).toEqual([{ ephemeral: undefined }])
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
  })
})

/**
 * P2.524 — the teardown call, the half W2-i built the capability for and could
 * not wire from its own zone.
 *
 * `removeFileCheckpointStore` is already unit-tested for the BYTES
 * (`shared/src/sessions/__tests__/file-checkpoints-ephemeral.test.ts`). What
 * those tests cannot see is whether anything calls it, which is exactly the
 * state the row described: the capability landed, the wiring did not, and an
 * ephemeral session still left its snapshots on disk.
 *
 * Both arms are here on purpose. The positive one would pass against a call
 * that removed EVERY session's store, so the negative one is what makes the
 * `ephemeral` guard load-bearing.
 */
describe('ephemeral file-checkpoint teardown', () => {
  let workspaceId: string
  let sm: SessionManager

  beforeEach(() => {
    workspaceId = `ws-ephemeral-ckpt-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sm = createTestSessionManager()
  })

  afterEach(() => {
    mock.restore()
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  function installManaged(sessionId: string, ephemeral: boolean) {
    const managed = createManagedSession(
      { id: sessionId, name: 'scratch', ephemeral },
      {
        id: workspaceId,
        name: 'Test Workspace',
        rootPath: join(SESSIONS_DIR, '..', 'workspaces', workspaceId),
        createdAt: Date.now(),
      } as never,
      { messagesLoaded: true, ephemeral },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
    return managed
  }

  /** The directory the checkpoint creator makes unconditionally (P2.500). */
  function seedCheckpointStore(sessionId: string): string {
    const dir = join(SESSIONS_DIR, workspaceId, sessionId, 'file_checkpoints')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, entries: [] }))
    return dir
  }

  it('removes an ephemeral session\'s checkpoint store on manager cleanup', async () => {
    installManaged('ephemeral-ckpt', true)
    const dir = seedCheckpointStore('ephemeral-ckpt')
    expect(existsSync(dir)).toBe(true)

    await sm.cleanup()

    expect(existsSync(dir)).toBe(false)
  })

  it('leaves a normal session\'s checkpoint store alone on manager cleanup', async () => {
    installManaged('persisted-ckpt', false)
    const dir = seedCheckpointStore('persisted-ckpt')

    await sm.cleanup()

    expect(existsSync(dir)).toBe(true)
  })
})
