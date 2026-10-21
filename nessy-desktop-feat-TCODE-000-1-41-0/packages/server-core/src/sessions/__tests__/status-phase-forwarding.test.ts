/**
 * F1.1150 (origin DN-229) — the host forwards a runtime PHASE status (`AgentEvent` `status` with `phase: true`) as
 * `statusType: 'phase'`, the label-only kind the renderer clears on its empty message; an ordinary status keeps
 * today's stamping (`retrying` for a retry, `compacting` for the compaction keyword, none otherwise).
 */
import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@nessy-agent/core/types'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

async function forwarded(event: AgentEvent): Promise<Record<string, unknown> | undefined> {
  const managed = {
    id: 'session-f1-1150',
    permissionMode: 'default',
    isProcessing: true,
    processingGeneration: 1,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, string>(),
    workspace: { id: 'workspace-f1-1150', rootPath: process.cwd() },
    workingDirectory: process.cwd(),
  }
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.sessions.set(encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id }), managed)
  const sent: Array<Record<string, unknown>> = []
  manager.sendEvent = (wire: Record<string, unknown>) => { sent.push(wire) }
  await manager.processEvent(managed, event)
  return sent.find(wire => wire.type === 'status')
}

describe('F1.1150 — a phase status crosses the wire as statusType phase', () => {
  test('a phase label and its empty end are both stamped phase', async () => {
    expect(await forwarded({ type: 'status', message: 'Auto-reviewing this action...', phase: true }))
      .toMatchObject({ type: 'status', message: 'Auto-reviewing this action...', statusType: 'phase' })
    expect(await forwarded({ type: 'status', message: '', phase: true }))
      .toMatchObject({ type: 'status', message: '', statusType: 'phase' })
  })

  test('NEGATIVE — an ordinary status keeps its stamping: compaction keyword, or none', async () => {
    expect(await forwarded({ type: 'status', message: 'Compacting context...' })).toMatchObject({ statusType: 'compacting' })
    const plain = await forwarded({ type: 'status', message: 'Auto-review approved this action' })
    expect(plain?.statusType).toBeUndefined()
  })
})
