/**
 * F1.914 (origin WJ-crit-ccc P-3) — a pending `permission_dsl` approval survives a restart AND the runtime snapshot.
 *
 * ## What was measured first (in-process, 2026-09-28)
 *
 * The Pi agent's readable-rule `ask` card carries `type: 'permission_dsl'` (`pi-agent.ts`, F1.902). No declaration of
 * the permission type named that value, so the host cast it through. Driving the REAL restart path
 * (`reprojectPendingApproval` over a persisted `PiPendingApprovalV1`) and then the REAL
 * `getPiHarnessRuntimeSnapshot` into the REAL preload parser:
 *
 * - the re-fired card KEPT the type (`permission_dsl`), and so did the host's pending entry;
 * - the snapshot published it in `security.pendingPermissions`, and `parsePiHarnessRuntimeSnapshotV1` THREW
 *   `pi-harness-runtime-invalid` — the preload's `getPiHarnessRuntime` rejects the WHOLE snapshot, so the runtime panel
 *   was lost for as long as such a card was pending (live too: the restart only makes it last);
 * - CONTROL: the same record typed `bash` parsed.
 *
 * The iOS mirror decoded the value as `unknown` and still opened a generic approval (no screen switches on the type).
 *
 * The fix declares the value in all six TypeScript copies and the Swift mirror (the precedent is `worktree_cleanup`,
 * P6.723); `scripts/ios-wire-enum-parity.ts` keeps them together. The parser stays strict: a value no declaration names
 * is still refused (the BOUNDARY below).
 */
import { describe, expect, test } from 'bun:test'
import { parsePiHarnessRuntimeSnapshotV1 } from '@nessy-agent/shared/protocol/pi-harness-runtime'
import { SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager.ts'

/** A Pi session that ran a turn, with a persisted pending approval of `type` — the state a restart reopens. */
function restartedSession(type: string) {
  const manager = createTestSessionManager() as any
  const sent: Array<{ type: string; request?: { requestId: string; type?: string; noAlwaysAllow?: boolean } }> = []
  const managed = {
    id: 'session-1',
    ephemeral: true,
    isProcessing: false,
    permissionMode: 'default',
    workspace: { id: 'workspace-1', rootPath: '/tmp/workspace-1' },
    agent: {
      getHarnessDiagnostics: () => ({
        surfaceVersion: 2 as const, generation: 'gen-1', manifestHash: 'hash-1', provenance: [], contextProfile: 'bare' as const, responseEpoch: 1,
      }),
    },
    pendingApproval: {
      schemaVersion: 1 as const,
      requestId: 'req-dsl',
      toolName: 'Bash',
      description: 'Bash requires approval by readable permission policy rule `Bash(echo *)` (workspace scope).',
      type,
      command: 'echo F1914',
      noAlwaysAllow: true,
      requestedAt: Date.now(),
    },
  }
  manager.getManaged = () => managed
  manager.resolveManagedProvider = () => 'pi'
  manager.managedKey = () => 'workspace-1|session-1'
  manager.piProcessSupervisor = { snapshot: async () => [] }
  manager.sessionStore = { getSessionPath: () => '/tmp/workspace-1/sessions/session-1' }
  manager.projectHandleService = { resolveHandle: async () => null }
  manager.projectFileCheckpoints = () => Object.freeze([])
  manager.pendingPermissionRequests = new Map()
  manager.piLspPort = () => undefined
  manager.sendEvent = (event: (typeof sent)[number]) => { sent.push(event) }
  for (const map of [
    'piTaskServices', 'piGoalServices', 'piAskUserServices', 'piPlanModeServices',
    'piChildSessionServices', 'piWorktreeLeaseServices',
  ]) manager[map] = new Map()
  return {
    manager,
    sent,
    reopen: () => manager.reprojectPendingApproval(managed),
    parsedSnapshot: async () => parsePiHarnessRuntimeSnapshotV1(JSON.parse(JSON.stringify(
      await SessionManager.prototype.getPiHarnessRuntimeSnapshot.call(manager, { workspaceId: 'workspace-1', sessionId: 'session-1' }),
    ))),
  }
}

describe('F1.914 — a pending permission_dsl approval after a restart', () => {
  test('THE DEFECT — the re-fired card keeps its type and the runtime snapshot still parses, naming it', async () => {
    const s = restartedSession('permission_dsl')
    s.reopen()
    expect(s.sent.map(event => [event.type, event.request?.type, event.request?.noAlwaysAllow])).toEqual([['permission_request', 'permission_dsl', true]])
    // Threw `pi-harness-runtime-invalid` before the fix: the whole snapshot, not one field.
    const parsed = await s.parsedSnapshot()
    expect(parsed.security.pendingPermissions).toEqual([{ requestId: 'req-dsl', type: 'permission_dsl', source: 'session-permission' }])
    expect(parsed.security.risk).toBe('pending-approval')
  })

  test('BOUNDARY — the parser stays strict: a type no declaration names is still refused', async () => {
    const s = restartedSession('permission_unheard_of')
    s.reopen()
    await expect(s.parsedSnapshot()).rejects.toThrow('pi-harness-runtime-invalid')
  })

  test('CONTROL — a bash approval parsed before and still does', async () => {
    const s = restartedSession('bash')
    s.reopen()
    const parsed = await s.parsedSnapshot()
    expect(parsed.security.pendingPermissions).toEqual([{ requestId: 'req-dsl', type: 'bash', source: 'session-permission' }])
  })
})
