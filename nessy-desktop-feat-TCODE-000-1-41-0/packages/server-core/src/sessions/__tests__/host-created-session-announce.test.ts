/**
 * F1.873 — a VISIBLE session the host creates in the background announces itself (`session_created`, UA4.1's
 * `announceSessionCreated`), so every client hydrates its row before its first streamed event instead of meeting an
 * unknown id (F1.855's hidden placeholder plus a refetch) or, for a session that never streams, not listing it at
 * all until a reload.
 *
 * The audit at HEAD (2026-10-09), every host `createSession` caller in server-core:
 *  - announced already: `spawn_session`, the automation runner, `createSessionFromBundle`, the Tasks Conductor's
 *    children (`conductor-host.ts`) and the generate draft (`rpc/tasks.ts`);
 *  - the four gaps this row closes, one arm each below: the typed `/branch` (`runBranchSessionCommand`), the `/batch`
 *    fan-out (`runWorktreeBatch`), the remote-workspace transfer (`importRemoteSessionTransfer`, created in ANOTHER
 *    workspace's window) and the board task's orchestrator (`createTaskFromSpec`: `tasks:create` and the agent's
 *    `create_board_task`);
 *  - left as they are: the RPC `sessions:create` (its caller receives the session in the reply) and the Pi child
 *    runtime (`startPiChildRuntime`, created `hidden`: a Guardian judge or a subagent is not listed, F1.855).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTaskFromSpec } from '../../tasks/create-task'
import { createTestSessionManager } from './test-session-manager'

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
})

/** A real manager whose `announceSessionCreated` is recorded and whose `createSession` mints ids. */
function rig() {
  const manager = createTestSessionManager()
  managers.push(manager)
  const announced: Array<{ sessionId: string; workspaceId: string }> = []
  let next = 0
  Object.assign(manager, {
    announceSessionCreated: (sessionId: string, workspaceId: string) => { announced.push({ sessionId, workspaceId }) },
    createSession: async (workspaceId: string, options: { name?: string }) => ({ id: `created-${++next}`, workspaceId, name: options.name }),
  })
  return { manager: manager as unknown as Record<string, any>, announced }
}

describe('F1.873 — host-created visible sessions announce session_created', () => {
  test('the typed /branch announces the branch it created', async () => {
    const { manager, announced } = rig()
    const managed = createManagedSession({ id: 'source' }, {
      id: 'ws-branch', name: 'Branch', rootPath: '/tmp/nessy-f1873-branch', createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true })
    managed.messages = [{ id: 'final', role: 'assistant', content: 'done', timestamp: 1 }] as never
    managed.agent = { supportsBranching: true } as never
    manager.sessions.set(`ws-branch:${managed.id}`, managed)
    await manager.runBranchSessionCommand(managed)
    expect(announced).toEqual([{ sessionId: 'created-1', workspaceId: 'ws-branch' }])
  })

  test('the /batch fan-out announces each unit before its prompt is sent', async () => {
    const { manager, announced } = rig()
    const order: string[] = []
    const announce = manager.announceSessionCreated
    Object.assign(manager, {
      announceSessionCreated: (sessionId: string, workspaceId: string) => { order.push(`announce ${sessionId}`); announce(sessionId, workspaceId) },
      getManaged: (id: string) => ({ id, workspace: { id: 'ws-a' } }),
      createSessionWorktreePort: () => ({
        enter: async (input: { name: string; branch?: string }) => ({ worktreeLeaseId: 'l', path: `/w/${input.name}`, branch: input.branch ?? 'b', previousWorkingDirectory: '/p', created: true }),
      }),
      sendMessage: (sessionId: string, _text: string, _a?: unknown, _b?: unknown, _c?: unknown, _d?: unknown, _e?: unknown, onAck?: (id: string) => void) => {
        order.push(`send ${sessionId}`)
        onAck?.('m1')
        return Promise.resolve()
      },
    })
    const outcome = await manager.runWorktreeBatch({ id: 'parent', workspace: { id: 'ws-a' } }, {
      tasks: [{ name: 'one', prompt: 'do 1' }, { name: 'two', prompt: 'do 2' }], branchPrefix: 'batch/x',
    })
    expect(outcome.started).toHaveLength(2)
    expect(announced.map(entry => entry.sessionId)).toEqual(['created-1', 'created-2'])
    expect(order).toEqual(['announce created-1', 'send created-1', 'announce created-2', 'send created-2'])
  })

  test('a remote-workspace transfer announces the session in its target workspace; a refused payload announces nothing', async () => {
    const { manager, announced } = rig()
    const target = createManagedSession({ id: 'created-1' }, {
      id: 'ws-target', name: 'Target', rootPath: '/tmp/nessy-f1873-target', createdAt: 1,
    }, { messagesLoaded: true, ephemeral: true })
    Object.assign(manager, { getManaged: () => target, persistSession: () => {} })
    await expect(manager.importRemoteSessionTransfer('ws-target', { summary: '  ' })).rejects.toThrow()
    expect(announced).toEqual([])
    await manager.importRemoteSessionTransfer('ws-target', { name: 'Moved', summary: 'what happened so far' })
    expect(announced).toEqual([{ sessionId: 'created-1', workspaceId: 'ws-target' }])
  })

  test('a board task announces its orchestrator once the label and sources are set', async () => {
    const calls: string[] = []
    const sessionManager = {
      createSession: async () => { calls.push('create'); return { id: 'orch-1' } },
      applyTaskLabel: async () => { calls.push('label'); return { labelId: 'TASK-x-1' } },
      setSessionSources: async () => { calls.push('sources') },
      announceSessionCreated: (sessionId: string, workspaceId: string) => { calls.push(`announce ${sessionId} ${workspaceId}`) },
    }
    const result = await createTaskFromSpec(sessionManager as never, 'ws-task', '/tmp/nessy-f1873-task', {
      id: 'x', title: 'X', sources: ['github'],
    } as never, { save: false })
    expect(result.orchestratorSessionId).toBe('orch-1')
    expect(calls).toEqual(['create', 'label', 'sources', 'announce orch-1 ws-task'])
  })
})
