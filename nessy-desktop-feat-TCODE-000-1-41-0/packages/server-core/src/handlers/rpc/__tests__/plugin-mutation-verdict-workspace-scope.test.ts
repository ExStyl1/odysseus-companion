/**
 * F1.484 (origin WJ-ss-b P-WJ-ss-b-3, LOW) — F1.396's install verdict counted sessions in EVERY workspace.
 *
 * An install, update, repair or uninstall is a GLOBAL mutation, so `afterPluginMutation` refreshes every live
 * session on the machine (`refreshPluginRuntime(undefined, …)`), and the verdict it hands back to the renderer
 * read that whole summary: one failed session in workspace B turned workspace A's install notice into
 * "refreshing one or more open sessions failed" — about sessions A's user cannot see (no session ids leaked,
 * F1.407 already kept those to the caller's workspace, but the COUNT did). The agent channel had been scoped since
 * F1.407 by passing the caller's workspace to `refreshPluginRuntime`; the RPC channel never passed it.
 *
 * The rig is the real `SessionManager.refreshPluginRuntime` over two workspaces: a healthy idle session in A and a
 * codex session in B whose strict teardown fails (the F1.265 shape), driven through the real
 * `afterPluginMutation` as the RPC handlers now call it — with `answerForWorkspaceId` set to the caller's.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterPluginMutation } from '../plugin-runtime-refresh.ts'
import { createManagedSession } from '../../../sessions/SessionManager.ts'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager.ts'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function twoWorkspaceRig() {
  const dir = mkdtempSync(join(tmpdir(), 'f1484-'))
  roots.push(dir)
  const sm = createTestSessionManager()
  const sessions = (sm as unknown as { sessions: Map<string, unknown> }).sessions
  const disposals: string[] = []
  const agent = (id: string, fails: boolean) => ({
    isProcessing: () => false,
    setCapabilityTurnRuntime: () => {},
    setAutomationSystem: () => {},
    drainAutomationEvents: async () => {},
    disposeForRestart: async () => {
      disposals.push(id)
      if (fails) throw new AggregateError([new Error('CODEX_HOME rm EBUSY')], 'codex-runtime-cleanup-failed')
    },
    dispose: () => {},
  })
  for (const [workspaceId, id, fails] of [['ws-a', 'codex-a', false], ['ws-b', 'codex-b', true]] as const) {
    const workspace = { id: workspaceId, name: workspaceId, slug: workspaceId, rootPath: join(dir, workspaceId), createdAt: Date.now() }
    const managed = createManagedSession({ id }, workspace, { messagesLoaded: true, ephemeral: true })
    ;(managed as { agent: unknown }).agent = agent(id, fails)
    sessions.set(`${workspaceId}:${id}`, managed)
  }
  const internals = sm as unknown as { resolveManagedProvider(managed: { id: string }): string }
  const realProvider = internals.resolveManagedProvider.bind(sm)
  internals.resolveManagedProvider = managed => managed.id.startsWith('codex-') ? 'codex-runtime' : realProvider(managed as never)
  const warnings: string[] = []
  const server = { handle() {}, push() {}, async invokeClient() { return undefined }, hasClientCapability() { return false }, findClientsWithCapability() { return [] } }
  const deps = { sessionManager: sm, platform: { logger: { warn: (line: string) => warnings.push(line) } } }
  return { sm, server, deps, disposals, warnings }
}

describe('F1.484 — a global mutation\'s verdict answers for the caller\'s workspace', () => {
  it('THE DEFECT — a failed session only in B leaves A\'s install notice "applied"', async () => {
    const { sm, server, deps, disposals, warnings } = twoWorkspaceRig()
    try {
      const verdict = await afterPluginMutation(server as never, deps as never, { answerForWorkspaceId: 'ws-a' }, 'marketplace install')
      // Both sessions really took the global refresh (positive control on the rig) …
      expect(disposals.sort()).toEqual(['codex-a', 'codex-b'])
      // … and A's user is told what happened in A.
      expect(verdict).toBe('applied')
      // B's failure is not reported to A — neither as a verdict nor as a named session in A's warning.
      expect(warnings.join('\n')).not.toContain('codex-b')
    } finally {
      sm.cleanup()
    }
  })

  it('CONTROL — the same refresh answered for B is "failed"', async () => {
    const { sm, server, deps } = twoWorkspaceRig()
    try {
      expect(await afterPluginMutation(server as never, deps as never, { answerForWorkspaceId: 'ws-b' }, 'marketplace install')).toBe('failed')
    } finally {
      sm.cleanup()
    }
  })

  it('BOUNDARY — a caller with no workspace keeps the machine-wide answer it had', async () => {
    const { sm, server, deps } = twoWorkspaceRig()
    try {
      expect(await afterPluginMutation(server as never, deps as never, {}, 'marketplace install')).toBe('failed')
    } finally {
      sm.cleanup()
    }
  })
})
