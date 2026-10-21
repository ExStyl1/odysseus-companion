/**
 * R29b Task 2 — `sub-agents.md:1043`, a fork's permission prompts get a surface.
 *
 * The table at `:1044` gives a fork "Prompts surface in your terminal" and a
 * background named subagent "Prompts surface in your main session"; `:770` says
 * background subagents "surface every permission prompt in your main session".
 * For a desktop app both mean the same place: the visible ancestor conversation.
 *
 * Before this, a child session was `hidden: true` and the prompt was emitted
 * with the CHILD's session id, so the renderer filed it under a session the
 * sidebar filters out and the fork stalled until its deadline with no
 * explanation. The two halves asserted here are the ones that matter:
 *  - the prompt names the visible ancestor it must be shown in, and
 *  - answering it UNBLOCKS the waiting call. A render with no unblocking is the
 *    same hang with a picture of it.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

const workspace = { id: 'workspace-fork', rootPath: '/tmp/workspace-fork' } as unknown as Parameters<typeof createManagedSession>[1]

interface Emitted { type: string; sessionId: string; request: Record<string, unknown> }

function setup(childOverrides: Record<string, unknown>) {
  const manager = createTestSessionManager()
  const events: Emitted[] = []
  ;(manager as any).sendEvent = (event: Emitted) => { events.push(event) }

  const parent = createManagedSession({ id: 'parent-session', name: 'Parser work' }, workspace)
  const child = createManagedSession({
    id: 'child-session',
    name: 'fork: draft unit tests',
    hidden: true,
    piParentSessionKey: { workspaceId: workspace.id, sessionId: 'parent-session' },
    ...childOverrides,
  } as never, workspace)
  const sessions: Map<string, any> = (manager as any).sessions
  sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: 'parent-session' }), parent)
  sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: 'child-session' }), child)
  return { manager, events, parent, child }
}

describe('a child session permission prompt reaches the session the user is watching', () => {
  test('a fork prompt names the visible ancestor, and answering it unblocks the fork', async () => {
    const { manager, events } = setup({ piChildRestrictions: { prompt: '', model: 'm', tools: [], thinkingLevel: 'off', worktreePolicy: 'shared', fork: true } })
    const child = (manager as any).getManaged('child-session', workspace.id)
    // A live child always has a backend; `respondToPermission` needs one to
    // reach the resolver branch rather than the restart-recovery branch.
    child.agent = { respondToPermission: () => undefined }

    // The real Pi approval seam: it registers the resolver the subprocess
    // executor is waiting on, then surfaces the prompt.
    const waiting = (manager as any).requestPiToolApproval(child, {
      decisionId: 'decision-1',
      toolName: 'bash',
      type: 'bash',
      description: 'run the tests',
      command: 'bun test',
    }) as Promise<{ allowed: boolean; canonicalInput?: Record<string, unknown> }>

    const emitted = events.find(event => event.type === 'permission_request')
    expect(emitted).toBeDefined()
    // The routing hint points at the visible parent…
    expect(emitted!.request.parentSessionId).toBe('parent-session')
    expect(emitted!.request.agentLabel).toBe('fork: draft unit tests')
    // …while the authority stays the child's, because that is what the answer
    // is validated against.
    expect(emitted!.request.sessionId).toBe('child-session')
    expect(emitted!.sessionId).toBe('child-session')

    let settled = false
    void waiting.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    const accepted = await manager.respondToPermission('child-session', 'decision-1', true, false, undefined, workspace.id)
    expect(accepted).toBe(true)
    expect(await waiting).toEqual({ allowed: true, canonicalInput: undefined })
  })

  test('a named subagent prompt is routed the same way — :770 puts it in the main session too', async () => {
    const { manager, events } = setup({
      name: 'scout: survey the repo',
      piChildRestrictions: { prompt: 'scout prompt', model: 'm', tools: [], thinkingLevel: 'off', worktreePolicy: 'shared' },
    })
    const child = (manager as any).getManaged('child-session', workspace.id)
    void (manager as any).requestPiToolApproval(child, {
      decisionId: 'decision-2', toolName: 'bash', type: 'bash', description: 'run the tests',
    })
    const emitted = events.find(event => event.type === 'permission_request')
    expect(emitted!.request.parentSessionId).toBe('parent-session')
    expect(emitted!.request.agentLabel).toBe('scout: survey the repo')
  })

  test('a top-level session prompt carries no routing hint', async () => {
    const manager = createTestSessionManager()
    const events: Emitted[] = []
    ;(manager as any).sendEvent = (event: Emitted) => { events.push(event) }
    const top = createManagedSession({ id: 'top-session', name: 'Parser work' }, workspace)
    ;((manager as any).sessions as Map<string, any>).set(encodeSessionKey({ workspaceId: workspace.id, sessionId: 'top-session' }), top)

    void (manager as any).requestPiToolApproval(top, {
      decisionId: 'decision-3', toolName: 'bash', type: 'bash', description: 'run the tests',
    })
    const emitted = events.find(event => event.type === 'permission_request')
    expect(emitted!.request.parentSessionId).toBeUndefined()
    expect(emitted!.request.agentLabel).toBeUndefined()
  })

  test('a nested child walks past a hidden parent to the visible root', async () => {
    const { manager, events } = setup({ piChildRestrictions: { prompt: '', model: 'm', tools: [], thinkingLevel: 'off', worktreePolicy: 'shared', fork: true } })
    const sessions: Map<string, any> = (manager as any).sessions
    const middle = sessions.get(encodeSessionKey({ workspaceId: workspace.id, sessionId: 'child-session' }))
    middle.hidden = true
    const grandchild = createManagedSession({
      id: 'grandchild-session',
      name: 'scout: check one thing',
      hidden: true,
      piParentSessionKey: { workspaceId: workspace.id, sessionId: 'child-session' },
    } as never, workspace)
    sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: 'grandchild-session' }), grandchild)

    void (manager as any).requestPiToolApproval(grandchild, {
      decisionId: 'decision-4', toolName: 'bash', type: 'bash', description: 'run the tests',
    })
    const emitted = events.find(event => event.type === 'permission_request')
    expect(emitted!.request.parentSessionId).toBe('parent-session')
  })
})
