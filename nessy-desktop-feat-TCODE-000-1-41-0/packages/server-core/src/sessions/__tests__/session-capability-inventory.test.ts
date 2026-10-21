/**
 * P6.411 — the withheld record reaches a reader.
 *
 * `toAgentRuntime` has produced `withheld` since `9ad1c13d9`, at the one point
 * Pi, claude and codex converge on, and it reached nobody: `AgentRuntimeView`
 * occurs in no file outside `SessionManager`. So a session could not say which
 * of its capabilities actually loaded and which silently did not — the exact
 * half-true disclosure the row is about.
 *
 * What is pinned here is the read path, not a surface. The LOADED half is
 * deliberately absent: the renderer already reads the capability catalog, and a
 * second copy of that list from here would be a second thing to keep in step.
 */
import { describe, expect, test } from 'bun:test'
import type { RuntimeWithheldCapability } from '@nessy-agent/shared/capabilities/views'
import { createTestSessionManager } from './test-session-manager.ts'

interface Internals {
  sessions: Map<string, { id: string; workspace: { id: string }; lastWithheldCapabilities?: readonly RuntimeWithheldCapability[] }>
  managedKey(managed: { id: string; workspace: { id: string } }): string
}

const withheld: RuntimeWithheldCapability = {
  key: 'plugin:acme/skill:deploy',
  kind: 'skill',
  logicalName: 'deploy',
  reason: 'review-required',
}

describe('a session can be asked what it withheld', () => {
  test('answers empty for a session nobody has resolved capabilities for', async () => {
    const manager = createTestSessionManager()
    try {
      const session = await manager.createSession('workspace-p6411-empty', {})
      // Empty rather than undefined, and honest: before a turn resolves
      // capabilities nothing has been withheld, because nothing was decided.
      expect(manager.getSessionCapabilityInventory(session.id, 'workspace-p6411-empty')).toEqual([])
    } finally { manager.cleanup() }
  })

  test('answers the retained record once a resolution has happened', async () => {
    const manager = createTestSessionManager()
    try {
      const session = await manager.createSession('workspace-p6411-record', {})
      const internals = manager as unknown as Internals
      const managed = internals.sessions.get(
        internals.managedKey({ id: session.id, workspace: { id: 'workspace-p6411-record' } }),
      )!
      managed.lastWithheldCapabilities = [withheld]

      const answer = manager.getSessionCapabilityInventory(session.id, 'workspace-p6411-record')
      expect(answer).toHaveLength(1)
      expect(answer[0]!.logicalName).toBe('deploy')
      // The reason is the whole point: "it did not load" without it is the
      // silence this row exists to remove.
      expect(answer[0]!.reason).toBe('review-required')
    } finally { manager.cleanup() }
  })

  test('answers empty for a session this process does not hold, rather than throwing', () => {
    const manager = createTestSessionManager()
    try {
      expect(manager.getSessionCapabilityInventory('no-such-session', 'no-such-workspace')).toEqual([])
    } finally { manager.cleanup() }
  })
})
