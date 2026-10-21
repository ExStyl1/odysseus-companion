/**
 * F1.493 (1) (origin WJ-yy P-WJ-yy-2, LOW) — a turn killed by a security revoke says WHY, in words.
 *
 * An uninstall, a disable or a source removal during a running turn revokes the turn's capability lease
 * (fail-closed, by design), and the host force-aborts every session holding it. Before this row the user read raw
 * `capability-snapshot-revoked` and a "Failed to connect" server, and nothing in a packaged build's log named the
 * revoke's reason or the sessions it hit: `storage-runtime.ts` dropped the resolver's `reason` before
 * `SessionManager`'s subscription, which is why F1.260 had to be reconstructed from timestamps.
 *
 * The rig is the real `SessionManager` with its `subscribeInvalidation` seam captured, a registered session holding a
 * lease and a fake agent recording `forceAbort`, and the event shape `storage-runtime.ts` now forwards (with
 * `reason`). The reason text is what `emitPluginMutationInvalidation` now writes for a user's uninstall:
 * `plugin uninstall (<pluginKey>)`.
 */
import { describe, expect, test } from 'bun:test'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

type Listener = (event: { scope: { kind: string }; effect: string; revokedLeaseIds: string[]; reason?: string }) => void

function rig() {
  let listener: Listener | undefined
  const manager = createTestSessionManager({
    subscribeInvalidation: (next: Listener) => { listener = next; return () => { listener = undefined } },
  } as never) as any
  const workspace = { id: 'ws-f1493', name: 'ws-f1493', slug: 'ws-f1493', rootPath: '/tmp/ws-f1493', createdAt: Date.now() }
  const aborts: Record<string, string[]> = {}
  const registered: Array<{ agent: unknown }> = []
  const session = (id: string, leaseId: string) => {
    const managed = createManagedSession({ id }, workspace, { messagesLoaded: true, ephemeral: true })
    ;(managed as { capabilityLeaseId?: string }).capabilityLeaseId = leaseId
    ;(managed as { agent: unknown }).agent = { forceAbort: (reason: string) => { (aborts[id] ??= []).push(reason) }, isProcessing: () => true }
    manager.sessions.set(`ws-f1493:${id}`, managed)
    registered.push(managed as { agent: unknown })
    return managed
  }
  // The fake agent carries only what the revoke path calls; `cleanup()` would drive a real agent's SessionEnd
  // lifecycle through it, so the fakes are detached first.
  const dispose = async () => {
    for (const managed of registered) managed.agent = null
    await manager.cleanup()
  }
  return { emit: (event: Parameters<Listener>[0]) => listener!(event), session, aborts, dispose }
}

describe('F1.493 (1) — a turn stopped by a capability revoke is told which change stopped it', () => {
  test('THE DEFECT — the revoked session is aborted AND its transcript names the removed plugin', async () => {
    const { dispose, emit, session, aborts } = rig()
    try {
      const hit = session('hit', 'lease-hit')
      const spared = session('spared', 'lease-spared')
      emit({ scope: { kind: 'global' }, effect: 'revoke-active-snapshot', revokedLeaseIds: ['lease-hit'], reason: 'plugin uninstall (local.toolkit-1)' })
      // The abort is unchanged (positive control on the rig) …
      expect(aborts.hit).toHaveLength(1)
      // … and the transcript now says why, naming the plugin the user removed.
      const notes = (hit.messages as Array<{ role: string; content: string }>).filter(message => message.role === 'info')
      expect(notes).toHaveLength(1)
      expect(notes[0]!.content).toContain('local.toolkit-1')
      expect(notes[0]!.content).toContain('plugin uninstall')
      // CONTROL — a session not holding the revoked lease is neither aborted nor told anything.
      expect(aborts.spared).toBeUndefined()
      expect((spared.messages as unknown[]).length).toBe(0)
    } finally {
      await dispose()
    }
  })

  test('BOUNDARY — a revoke with no reason still says the turn was stopped by a withdrawn capability', async () => {
    const { dispose, emit, session } = rig()
    try {
      const hit = session('hit', 'lease-hit')
      emit({ scope: { kind: 'global' }, effect: 'revoke-active-snapshot', revokedLeaseIds: ['lease-hit'] })
      const notes = (hit.messages as Array<{ role: string; content: string }>).filter(message => message.role === 'info')
      expect(notes).toHaveLength(1)
      expect(notes[0]!.content.length).toBeGreaterThan(0)
      // A refresh is not a revoke: nothing is written.
      const other = session('refresh-only', 'lease-refresh')
      emit({ scope: { kind: 'global' }, effect: 'refresh-before-next-turn', revokedLeaseIds: [], reason: 'plugin enable (x)' })
      expect((other.messages as unknown[]).length).toBe(0)
    } finally {
      await dispose()
    }
  })
})
