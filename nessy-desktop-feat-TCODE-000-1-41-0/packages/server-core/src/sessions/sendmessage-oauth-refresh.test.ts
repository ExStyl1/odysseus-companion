import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import {
  createTestCapabilityResolver,
  createTestSessionManager,
} from './__tests__/test-session-manager.ts'

describe('sendMessage verified capability runtime', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-oauth-refresh-'))
    sm = createTestSessionManager()
  })

  afterEach(() => {
    sm.cleanup()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'oauth-refresh test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${managed.workspace.id}:${id}`, managed)
    return managed
  }

  it('resolves one pinned capability turn and skips the legacy source refresh path', async () => {
    const calls: string[] = []
    const resolver = createTestCapabilityResolver()
    const resolve = resolver.resolve.bind(resolver)
    resolver.resolve = async context => {
      calls.push('capabilities.resolve')
      return resolve(context)
    }
    sm = createTestSessionManager({ resolver })
    const sessionId = 'cold-oauth'
    const managed = buildSession(sessionId)
    managed.enabledSourceSlugs = ['test-oauth-mcp']

    const trm = managed.tokenRefreshManager!
    trm.getSourcesNeedingRefresh = async () => {
      calls.push('legacy.refresh')
      return []
    }

    await sm.sendMessage(sessionId, 'hello').catch(() => { /* expected */ })

    expect(calls).toEqual(['capabilities.resolve'])
    expect(resolver.leaseCount()).toBe(0)
  })
})
