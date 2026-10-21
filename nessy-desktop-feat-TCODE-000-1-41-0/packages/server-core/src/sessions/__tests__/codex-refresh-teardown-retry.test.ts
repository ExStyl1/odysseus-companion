/**
 * F1.483 (origin: WJ-ss-b's P-WJ-ss-b-1, F1.411's residue) — a codex session
 * whose plugin-runtime refresh teardown failed once is NOT broken for good: the
 * next turn end or send retries the teardown, and once it lands the session's
 * runtime is dropped so the send builds a fresh one.
 *
 * F1.411 made the refresh stay pending after a failed strict teardown, and its
 * rig plants a stub runtime whose `disposeForRestart` re-runs per call (Pi's
 * shape). The REAL `CodexAgent.disposeForRestart` memoised its first teardown
 * and latched `destroyed`, so on codex every retry re-awaited the first
 * rejection. This rig plants NOTHING in place of the backend: it is a real
 * `CodexAgent`, and the one staged fact is its managed CODEX_HOME sitting under
 * an r-x parent, so the teardown's real `rmSync` is refused by real directory
 * permissions — step 5 of `cleanupRuntimeResources`, the honest prior (see
 * `codex-teardown-failure-attribution.test.ts`, whose precondition probe is
 * repeated here). It drives the REAL `refreshPluginRuntime` → strict
 * `disposeManagedAgentRuntime` and the REAL `flushPendingPluginRuntimeRefresh`
 * both the turn-end and send paths call.
 *
 * "The next send runs" is read the way F1.411 reads it: after the flush the
 * session holds no runtime and nothing is pending, which is what lets
 * `getOrCreateAgentUnchecked` build a new one — the send itself would need a
 * codex binary.
 *
 * CONTROL — a teardown that succeeds the first time refreshes and drops the
 * runtime at once, exactly as before.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAgent } from '../../../../shared/src/agent/codex-agent.ts'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/** Can an r-x PARENT stop an unlink on this host? Not as root / CAP_DAC_OVERRIDE. */
const rxParentBlocksUnlink = (() => {
  const parent = mkdtempSync(join(tmpdir(), 'f1483-sm-precondition-'))
  const victim = join(parent, 'probe')
  try {
    writeFileSync(victim, 'x\n')
    chmodSync(parent, 0o500)
    try {
      rmSync(victim, { force: true })
      return false
    } catch {
      return true
    }
  } catch {
    return false
  } finally {
    chmodSync(parent, 0o700)
    rmSync(parent, { recursive: true, force: true })
  }
})()
if (!rxParentBlocksUnlink) {
  console.warn('[codex-refresh-teardown-retry.test.ts] the failing-teardown cases are SKIPPED: an r-x parent does not prevent an unlink on this host (root, or CAP_DAC_OVERRIDE).')
}

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

type Managed = Record<string, unknown> & { agent: unknown; pendingPluginRuntimeRefreshReason?: string }
type Internals = {
  sessions: Map<string, Managed>
  refreshPluginRuntime(workspaceId?: string, projectKey?: undefined, reason?: string): Promise<{ failed?: number; applied: number; deferred: number }>
  flushPendingPluginRuntimeRefresh(managed: Managed, context: string): Promise<void>
}

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'f1483-sm-'))
  roots.push(dir)
  const codexHome = join(dir, 'codex-home')
  mkdirSync(codexHome)
  writeFileSync(join(codexHome, 'rollout.jsonl'), '{}\n')
  const sm = createTestSessionManager()
  const internals = sm as unknown as Internals
  const workspace = { id: 'ws-f1483', name: 'ws-f1483', slug: 'ws-f1483', rootPath: join(dir, 'ws'), createdAt: Date.now() }
  const managed = createManagedSession({ id: 'idle' }, workspace, { messagesLoaded: true, ephemeral: true }) as unknown as Managed
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: { id: 'ws-f1483', name: 'ws-f1483', rootPath: join(dir, 'ws'), workspaceRootPath: join(dir, 'ws'), sessionRootPath: join(dir, 'sessions') },
    session: { id: 'idle', workspaceRootPath: join(dir, 'ws'), createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: join(dir, 'ws') },
    model: 'codex/test-model',
    isHeadless: true,
  } as never)
  const agentInternals = agent as unknown as { codexHome: string | null; debug: (message: string) => void }
  agentInternals.debug = () => {}
  // The one staged fact: the runtime's managed CODEX_HOME, a real directory.
  agentInternals.codexHome = codexHome
  managed.agent = agent
  internals.sessions.set('ws-f1483:idle', managed)
  return { sm, internals, managed, agent, codexHome, blockRemoval: () => chmodSync(dir, 0o500), allowRemoval: () => chmodSync(dir, 0o700) }
}

describe('F1.483 — a codex plugin-refresh teardown that failed is retried by the next flush', () => {
  it.skipIf(!rxParentBlocksUnlink)('fails, stays pending while the CODEX_HOME cannot go, then lands and drops the runtime', async () => {
    const r = rig()
    try {
      r.blockRemoval()
      const summary = await r.internals.refreshPluginRuntime('ws-f1483', undefined, 'plugin_install')
      expect(summary.failed).toBe(1)
      expect(r.managed.agent).toBe(r.agent)
      expect(r.managed.pendingPluginRuntimeRefreshReason).toBe('plugin_install')

      // Still unremovable: the turn-end flush retries, fails again, and the refresh stays owed.
      await expect(r.internals.flushPendingPluginRuntimeRefresh(r.managed, 'processing stopped: complete')).rejects.toThrow('-session-disposal-failed')
      expect(r.managed.pendingPluginRuntimeRefreshReason).toBe('plugin_install')
      expect(r.managed.agent).toBe(r.agent)
      expect(existsSync(r.codexHome)).toBe(true)

      // Removable again: the send-path flush retries the SAME teardown, and it lands.
      r.allowRemoval()
      await r.internals.flushPendingPluginRuntimeRefresh(r.managed, 'send-path refresh')
      expect(r.managed.agent).toBeNull()
      expect(r.managed.pendingPluginRuntimeRefreshReason).toBeUndefined()
      expect(existsSync(r.codexHome)).toBe(false)
    } finally {
      r.allowRemoval()
      r.sm.cleanup()
    }
  })
})

describe('F1.483 — CONTROL', () => {
  it('a codex teardown that succeeds refreshes and drops the runtime at once', async () => {
    const r = rig()
    try {
      const summary = await r.internals.refreshPluginRuntime('ws-f1483', undefined, 'plugin_install')
      expect(summary.failed).toBeUndefined()
      expect(summary.applied).toBe(1)
      expect(r.managed.agent).toBeNull()
      expect(r.managed.pendingPluginRuntimeRefreshReason).toBeUndefined()
      expect(existsSync(r.codexHome)).toBe(false)
    } finally {
      r.sm.cleanup()
    }
  })
})
