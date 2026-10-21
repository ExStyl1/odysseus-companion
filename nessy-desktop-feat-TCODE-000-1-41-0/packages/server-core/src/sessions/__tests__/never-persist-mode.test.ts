/**
 * P6.502 — never-persist writes nothing, and says what that costs.
 *
 * Q-den 19 = option A: a never-persist mode as a first-class setting, *"stating
 * its cost when it is entered"*. B (the retention cap is the whole answer) was
 * refused because the minimum retention is not zero — `setRetentionDays` rejects
 * 0 — and C (let the cap reach zero) because that is a FALSE never-persist: the
 * transcript is written and then deleted.
 *
 * The machine already existed (`ephemeral` gates every persist call). What did
 * not exist is anybody being TOLD, and a session that silently cannot be
 * resumed, rewound or searched is indistinguishable from one that lost its
 * history to a bug.
 *
 * The zero-writes arm carries a NORMAL session as its positive control, without
 * which "nothing was written" is indistinguishable from "the test wrote to a
 * directory nobody looked at".
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { getSessionDirPath } from '@nessy-agent/shared/sessions'
import { createTestSessionManager } from './test-session-manager.ts'

const workspaces = ['workspace-p6502-ephemeral', 'workspace-p6502-normal']

afterEach(() => {
  for (const workspaceId of workspaces) {
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  }
})

function notices(managed: { messages: Array<{ role: string; content: string }> }): string[] {
  return managed.messages.filter(message => message.role === 'info').map(message => message.content)
}

describe('P6.502 never-persist', () => {
  test('states the cost of the mode in the chat, where it stays', async () => {
    const manager = createTestSessionManager() as any
    const workspaceId = 'workspace-p6502-ephemeral'
    try {
      const session = await manager.createSession(workspaceId, { ephemeral: true })
      const managed = manager.getManaged(session.id, workspaceId)

      const [line] = notices(managed)
      expect(line).toContain('never written to disk')
      // All three, because all three are gone and each is one a user reaches
      // for by reflex.
      expect(line).toContain('resumed')
      expect(line).toContain('rewound')
      expect(line).toContain('search')
      // It rides the TRANSCRIPT, not a toast: the row asks for the mode to be
      // visible for the life of the session rather than only at entry.
      expect(managed.messages.some((m: { role: string }) => m.role === 'info')).toBe(true)
    } finally {
      await manager.cleanup()
    }
  }, 60_000)

  test('writes no session file, with a normal session as the positive control', async () => {
    const manager = createTestSessionManager() as any
    try {
      const ephemeral = await manager.createSession('workspace-p6502-ephemeral', { ephemeral: true })
      const normal = await manager.createSession('workspace-p6502-normal', {})

      // Both flushed the same way; only one of them may have left a file.
      await manager.flushSession(ephemeral.id, 'workspace-p6502-ephemeral')
      await manager.flushSession(normal.id, 'workspace-p6502-normal')

      const control = getSessionDirPath('workspace-p6502-normal', normal.id)
      expect(existsSync(join(control, 'session.jsonl'))).toBe(true)

      const kept = getSessionDirPath('workspace-p6502-ephemeral', ephemeral.id)
      expect(existsSync(join(kept, 'session.jsonl'))).toBe(false)
    } finally {
      await manager.cleanup()
    }
  }, 60_000)

  test('a normal session is told nothing — the mode announces itself, not every session', async () => {
    const manager = createTestSessionManager() as any
    try {
      const session = await manager.createSession('workspace-p6502-normal', {})
      const managed = manager.getManaged(session.id, 'workspace-p6502-normal')
      expect(notices(managed).filter(line => line.includes('never written to disk'))).toEqual([])
    } finally {
      await manager.cleanup()
    }
  }, 60_000)
})
