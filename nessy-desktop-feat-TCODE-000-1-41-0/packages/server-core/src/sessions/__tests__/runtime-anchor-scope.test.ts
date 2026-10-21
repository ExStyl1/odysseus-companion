import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  createSessionStore,
  migrateLegacyAnchor,
  readRuntimeAnchor,
  saveSession,
  writeRuntimeAnchor,
  type StoredSession,
} from '@nessy-agent/shared/sessions'

describe('a session that has run on two runtimes', () => {
  it('never hands one runtime the other\'s anchor', () => {
    // Session started on Pi, before the map existed.
    let anchors = migrateLegacyAnchor(undefined, 'pi-session-1', 'pi')
    expect(readRuntimeAnchor(anchors, 'pi')).toBe('pi-session-1')
    // The user switches to Claude; Claude has not reported an id yet.
    expect(readRuntimeAnchor(anchors, 'anthropic')).toBeUndefined()
    // Claude reports its own.
    anchors = writeRuntimeAnchor(anchors, 'anthropic', 'claude-session-1')
    expect(readRuntimeAnchor(anchors, 'anthropic')).toBe('claude-session-1')
    // Switching back reaches the Pi conversation, not Claude's.
    expect(readRuntimeAnchor(anchors, 'pi')).toBe('pi-session-1')
  })

  it('does not let the legacy slot re-poison a provider after a switch', () => {
    // Legacy slot still holds the Pi id (the session config keeps writing it),
    // but the map already records Claude for `anthropic`.
    const anchors = writeRuntimeAnchor(migrateLegacyAnchor(undefined, 'pi-session-1', 'pi'), 'anthropic', 'claude-session-1')
    expect(readRuntimeAnchor(migrateLegacyAnchor(anchors, 'pi-session-1', 'anthropic'), 'anthropic'))
      .toBe('claude-session-1')
  })
})

describe('the anchor map survives the hop SessionManager hydrates from', () => {
  // `loadSessionsFromDisk` builds every ManagedSession from `SessionStore.list()`
  // — the LISTING metadata, not the stored session — and `headerToMetadata` in
  // store-v2 hand-copies its fields one by one. A field missing from that copy
  // is not a display gap: the map would be dropped on every restart and the
  // next `persistSession` would write the loss back to disk.
  it('is carried by the listing metadata, not only by the stored session', async () => {
    const store = createSessionStore({
      storageLayoutVersion: 2 as const,
      verificationId: `test-${randomUUID()}`,
    })
    const workspaceId = `ws-${randomUUID()}`
    store.ensureWorkspaceDir(workspaceId)
    const created = await store.create(workspaceId)

    const anchors = writeRuntimeAnchor(
      writeRuntimeAnchor(undefined, 'pi', 'pi-session-1'),
      'anthropic',
      'claude-session-1',
    )
    const stored: StoredSession = {
      ...created,
      workspaceId,
      sdkSessionAnchors: anchors,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    await saveSession(stored)

    const listed = store.list(workspaceId).find(meta => meta.id === created.id)
    expect(listed?.sdkSessionAnchors).toEqual({ pi: 'pi-session-1', anthropic: 'claude-session-1' })
    expect(readRuntimeAnchor(listed?.sdkSessionAnchors, 'anthropic')).toBe('claude-session-1')
  })
})
