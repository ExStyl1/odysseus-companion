/**
 * F1.1165 (origin DN-275) — the phone's mode menu shows the desktop's "Default" badge, so it needs the mode a new
 * session in this workspace starts in; the phone reads `sessions:getPermissionModeState` and nothing else about modes.
 * The reading gains `workspaceDefaultPermissionMode` (additive), resolved by the same chain `createSession` and the
 * resume door use (`startPermissionModeForResume`: managed default → workspace default → global default, clamped by
 * the managed disabled set).
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

function stateFor(startMode: string | undefined) {
  const managed = {
    id: 'session-f1-1165',
    permissionMode: 'plan',
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, string>(),
    workspace: { id: 'workspace-f1-1165', rootPath: process.cwd() },
    workingDirectory: process.cwd(),
  }
  const manager = createTestSessionManager() as any
  manager.sessions.set(encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id }), managed)
  manager.startPermissionModeForResume = () => startMode
  return manager.getSessionPermissionModeState(managed.id, managed.workspace.id)
}

describe('F1.1165 — the permission-mode reading names the workspace default', () => {
  test('the default a new session here starts in rides beside the session\'s own mode', () => {
    const state = stateFor('auto')
    expect(state.permissionMode).toBe('plan')
    expect(state.workspaceDefaultPermissionMode).toBe('auto')
  })

  test('NEGATIVE — an unknown session still reads null', () => {
    const manager = createTestSessionManager() as any
    expect(manager.getSessionPermissionModeState('missing', 'workspace-f1-1165')).toBeNull()
  })
})
