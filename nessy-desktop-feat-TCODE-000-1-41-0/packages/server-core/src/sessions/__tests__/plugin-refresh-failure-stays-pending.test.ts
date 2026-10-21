/**
 * F1.411 (origin: the WJ-ff verifier on F1.265; measured here) — a live session
 * whose plugin-runtime refresh FAILED stays pending, so the next turn end or
 * send re-attempts the teardown.
 *
 * `refreshPluginRuntimeNow` cleared `pendingPluginRuntimeRefreshReason` BEFORE
 * the strict dispose, and a strict dispose that fails throws BEFORE it clears
 * `managed.agent` (`disposeManagedAgentRuntime`: "Strict Workspace drains retain
 * their exact owned references on failure"). So a session F1.265's summary lists
 * in `failures` kept its un-refreshed runtime with nothing pending: neither the
 * turn-end flush (`onProcessingStopped`) nor the send-path flush
 * (`getOrCreateAgentUnchecked`) — the only two readers of the pending reason —
 * ever retried it, and the runtime kept the plugin set the mutation replaced.
 *
 * The rig drives the REAL `refreshPluginRuntime` → `invalidatePluginRuntimeForSession`
 * → `refreshPluginRuntimeNow` → strict `disposeManagedAgentRuntime`, and the REAL
 * `flushPendingPluginRuntimeRefresh` both turn-end and send paths call. The one
 * planted fact is an idle session's runtime whose `disposeForRestart` rejects a
 * given number of times and then succeeds — the shape of Pi's (`pi-agent.ts`
 * kills its subprocess again on every call). Codex's since F1.483 (it memoised
 * and re-awaited its first rejection), driven with a REAL `CodexAgent` in
 * `codex-refresh-teardown-retry.test.ts` rather than modelled here.
 *
 * CONTROLS — a refresh that succeeds leaves nothing pending and drops the
 * runtime; a busy session still defers exactly as before; a teardown that keeps
 * failing stays pending under the SAME reason, not one that grows a context
 * suffix per retry.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Managed = Record<string, unknown> & { agent: unknown; pendingPluginRuntimeRefreshReason?: string; isProcessing: boolean }
type Internals = {
  sessions: Map<string, Managed>
  refreshPluginRuntime(workspaceId?: string, projectKey?: undefined, reason?: string): Promise<{ failed?: number; applied: number; deferred: number }>
  flushPendingPluginRuntimeRefresh(managed: Managed, context: string): Promise<void>
}

function rig(options: { failures: number; busy?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'f1411-'))
  roots.push(dir)
  const sm = createTestSessionManager()
  const internals = sm as unknown as Internals
  const workspace = { id: 'ws-f1411', name: 'ws-f1411', slug: 'ws-f1411', rootPath: join(dir, 'ws'), createdAt: Date.now() }
  const managed = createManagedSession({ id: 'idle' }, workspace, { messagesLoaded: true, ephemeral: true }) as unknown as Managed
  let remainingFailures = options.failures
  const attempts: string[] = []
  const agent = {
    isProcessing: () => false,
    setCapabilityTurnRuntime: () => {},
    setAutomationSystem: () => {},
    drainAutomationEvents: async () => {},
    disposeForRestart: async () => {
      attempts.push(remainingFailures > 0 ? 'failed' : 'ok')
      if (remainingFailures > 0) {
        remainingFailures -= 1
        throw new AggregateError([new Error('child still exiting')], 'runtime-cleanup-failed')
      }
    },
    dispose: () => {},
  }
  managed.agent = agent
  if (options.busy) managed.isProcessing = true
  internals.sessions.set('ws-f1411:idle', managed)
  return { sm, internals, managed, agent, attempts }
}

describe('F1.411 — a failed plugin-runtime refresh stays pending, and the next flush retries it', () => {
  it('THE DEFECT — one failed idle teardown: the session is re-marked pending and the next flush tears it down', async () => {
    const r = rig({ failures: 1 })
    try {
      const summary = await r.internals.refreshPluginRuntime('ws-f1411', undefined, 'plugin_install')
      expect(summary.failed).toBe(1)
      expect(r.attempts).toEqual(['failed'])
      // Measured: the strict throw keeps the un-refreshed runtime on the session…
      expect(r.managed.agent).toBe(r.agent)
      // …and the refresh it owes is still owed.
      expect(r.managed.pendingPluginRuntimeRefreshReason).toBe('plugin_install')

      // The next turn end / send flushes it: the teardown is re-attempted and lands.
      await r.internals.flushPendingPluginRuntimeRefresh(r.managed, 'send-path refresh')
      expect(r.attempts).toEqual(['failed', 'ok'])
      expect(r.managed.agent).toBeNull()
      expect(r.managed.pendingPluginRuntimeRefreshReason).toBeUndefined()
    } finally {
      r.sm.cleanup()
    }
  })

  it('a teardown that keeps failing stays pending under the SAME reason, and each flush says so', async () => {
    const r = rig({ failures: 3 })
    try {
      await r.internals.refreshPluginRuntime('ws-f1411', undefined, 'plugin_install')
      for (const context of ['processing stopped: complete', 'send-path refresh']) {
        await expect(r.internals.flushPendingPluginRuntimeRefresh(r.managed, context)).rejects.toThrow('-session-disposal-failed')
        expect(r.managed.pendingPluginRuntimeRefreshReason).toBe('plugin_install')
      }
      expect(r.attempts).toEqual(['failed', 'failed', 'failed'])
      expect(r.managed.agent).toBe(r.agent)
    } finally {
      r.sm.cleanup()
    }
  })
})

describe('F1.411 — CONTROLS', () => {
  it('a refresh that succeeds leaves nothing pending and drops the runtime', async () => {
    const r = rig({ failures: 0 })
    try {
      const summary = await r.internals.refreshPluginRuntime('ws-f1411', undefined, 'plugin_install')
      expect(summary.failed).toBeUndefined()
      expect(summary.applied).toBe(1)
      expect(r.attempts).toEqual(['ok'])
      expect(r.managed.agent).toBeNull()
      expect(r.managed.pendingPluginRuntimeRefreshReason).toBeUndefined()
    } finally {
      r.sm.cleanup()
    }
  })

  it('a busy session defers exactly as before: pending marked, nothing torn down', async () => {
    const r = rig({ failures: 0, busy: true })
    try {
      const summary = await r.internals.refreshPluginRuntime('ws-f1411', undefined, 'plugin_install')
      expect(summary.deferred).toBe(1)
      expect(r.attempts).toEqual([])
      expect(r.managed.agent).toBe(r.agent)
      expect(r.managed.pendingPluginRuntimeRefreshReason).toBe('plugin_install')
    } finally {
      r.sm.cleanup()
    }
  })
})
