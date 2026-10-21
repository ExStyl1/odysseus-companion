/**
 * R7 Task 4 — durable approvals: an unanswered permission prompt persists
 * with the session, survives a restart-shaped reload, appears in the LISTING,
 * re-emits through the production PermissionRequest band on OPEN, and
 * answering settles it durably.
 *
 * Contract: agent-sdk/user-input.md — "The callback can stay pending
 * indefinitely. Execution remains paused until your callback returns." The
 * interactive pending-forever approval is Claude's documented equivalent of
 * headless defer, and R6's lesson (defect class twelve) is that these seams
 * must be proven through the persist → hydrate → listing → open → band path
 * the renderer actually hits, not through unit shims.
 */
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { sessionPersistenceQueue } from '@nessy-agent/shared/sessions'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

let createManagedSessionFn: typeof import('./SessionManager.ts')['createManagedSession']
let createTestSessionManagerFn: typeof import('./__tests__/test-session-manager.ts')['createTestSessionManager']

type SessionManagerInstance = InstanceType<typeof import('./SessionManager.ts')['SessionManager']>

const cleanupRoots: string[] = []

function eventSink(events: SessionEvent[]) {
  return ((...args: unknown[]) => { events.push(args[2] as SessionEvent) }) as never
}

/**
 * P3.18 · await the REAL turn-end signal — the `complete` reaching the sink —
 * rather than assuming a single `setImmediate`/`getSession` tick carries it
 * there before we assert on it. The renderer-facing `complete` is emitted
 * fire-and-forget from `onProcessingStopped` (the two 'complete' sites in
 * SessionManager.ts) several awaits deep, inside `sendTurnEndEvent` →
 * `sendEvent`. Polling the actual array — yielding macrotasks — means any
 * `await` a future change inserts before that emit only DELAYS the signal,
 * never loses it here. Throws loudly, naming the cause, only when the `complete`
 * is genuinely never sent — the real regression worth catching.
 */
async function awaitComplete(events: ReadonlyArray<{ type: string }>, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!events.some(event => event.type === 'complete')) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `awaitComplete: no 'complete' reached the event sink within ${timeoutMs}ms — `
        + 'an await inserted before this.sendEvent in SessionManager.sendTurnEndEvent '
        + 'likely lost the turn-end event (P3.18).',
      )
    }
    await new Promise(resolve => setTimeout(resolve))
  }
}

function makeManaged(sm: SessionManagerInstance, workspaceId: string, sessionId: string) {
  const rootPath = mkdtempSync(join(tmpdir(), 'sm-durable-approvals-ws-'))
  cleanupRoots.push(rootPath)
  const workspace = { id: workspaceId, name: 'Durable approvals', rootPath, createdAt: Date.now() }
  const managed = createManagedSessionFn(
    { id: sessionId, name: 'durable approvals' },
    workspace as never,
    { messagesLoaded: true },
  ) as never as Record<string, unknown> & {
    id: string
    workspace: { id: string }
    pendingApproval?: { requestId: string; toolName: string; commandHash?: string }
    agent: unknown
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
  return managed
}

const promptRequest = {
  requestId: 'perm-d1',
  toolName: 'Bash',
  command: 'npm install express',
  description: 'Execute: npm install express',
  type: 'bash' as const,
  rememberForMinutes: 10,
  commandHash: 'hash-durable-1',
}

describe('SessionManager durable approvals (R7 Task 4)', () => {
  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('persists the prompt, survives a restart-shaped reload into the listing, re-fires through the band on open, and answering settles durably', async () => {
    const workspaceId = `ws_durable_${Date.now().toString(36)}`
    const sessionId = 'session_durable_1'
    const sm1 = createTestSessionManagerFn()
    const events1: SessionEvent[] = []
    sm1.setEventSink(eventSink(events1))
    const managed1 = makeManaged(sm1, workspaceId, sessionId)
    const agentResponses: Array<{ requestId: string; allowed: boolean }> = []
    managed1.agent = {
      respondToPermission: (requestId: string, allowed: boolean) => { agentResponses.push({ requestId, allowed }) },
    }

    ;(sm1 as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed1, promptRequest)

    // Published through the band AND persisted beside pendingAskUser.
    expect(events1.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(managed1.pendingApproval).toMatchObject({
      requestId: 'perm-d1',
      toolName: 'Bash',
      commandHash: 'hash-durable-1',
    })
    await sessionPersistenceQueue.flushAll()
    sm1.cleanup()

    // Restart-shaped: a NEW manager over the same on-disk sessions.
    const sm2 = createTestSessionManagerFn()
    ;(sm2 as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(workspaceId)
    sm2.reloadSessions()

    // LISTING includes the session, with the pending approval hydrated.
    const listed = sm2.getSessions(workspaceId)
    expect(listed.map(session => session.id)).toContain(sessionId)
    const managed2 = (sm2 as unknown as { sessions: Map<string, typeof managed1> }).sessions.get(`${workspaceId}:${sessionId}`)!
    expect(managed2.pendingApproval).toMatchObject({ requestId: 'perm-d1', toolName: 'Bash' })

    // OPEN re-emits the prompt through the production PermissionRequest band.
    const events2: SessionEvent[] = []
    sm2.setEventSink(eventSink(events2))
    await sm2.getSession(sessionId, workspaceId)
    const reEmitted = events2.filter(event => event.type === 'permission_request') as unknown as Array<{ request: Record<string, unknown> }>
    expect(reEmitted).toHaveLength(1)
    expect(reEmitted[0]!.request).toMatchObject({
      requestId: 'perm-d1',
      toolName: 'Bash',
      type: 'bash',
      sessionId,
    })
    // A second open must not stack duplicate prompts.
    await sm2.getSession(sessionId, workspaceId)
    expect(events2.filter(event => event.type === 'permission_request')).toHaveLength(1)

    // Answering after restart settles the durable record even with no live
    // agent, re-drives the interrupted turn, and an allow is remembered for
    // the re-driven call.
    const redriveDispatches: string[] = []
    ;(sm2 as unknown as { sendMessage(sessionId: string, message: string): Promise<void> }).sendMessage
      = async (_sessionId: string, message: string) => { redriveDispatches.push(message) }
    expect(sm2.respondToPermission(sessionId, 'perm-d1', true, false, undefined, workspaceId)).toBe(true)
    expect(managed2.pendingApproval).toBeUndefined()
    await new Promise(resolve => setImmediate(resolve))
    expect(redriveDispatches).toHaveLength(1)
    await sessionPersistenceQueue.flushAll()

    // The re-driven call (same command hash after resume) auto-approves
    // without a second human prompt — "exactly as if never interrupted".
    const autoResponses: Array<{ requestId: string; allowed: boolean }> = []
    managed2.agent = {
      respondToPermission: (requestId: string, allowed: boolean) => { autoResponses.push({ requestId, allowed }) },
    }
    ;(sm2 as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed2, { ...promptRequest, requestId: 'perm-d2' })
    expect(events2.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(autoResponses).toEqual([{ requestId: 'perm-d2', allowed: true }])
    sm2.cleanup()
  })

  it('completes the re-driven call after a restart-refired approval: allow re-drives the turn and the tool result lands in the transcript', async () => {
    // Pass-11 live-blocker shape: a hash-less workflow-launch consent (no
    // commandHash, so no remember window can cover it) killed mid-prompt.
    // After restart + re-fire + Allow, the interrupted turn must actually be
    // re-driven and the re-issued call must execute WITHOUT a second card —
    // the transcript gains the tool result, not just the approval outcome.
    const workspaceId = `ws_durable_redrive_${Date.now().toString(36)}`
    const sessionId = 'session_redrive_1'
    const workflowPrompt = {
      requestId: 'perm-wf-1',
      toolName: 'workflow',
      command: 'pass11-demo',
      description: 'Launch workflow "pass11-demo"',
      type: 'workflow_launch' as const,
    }

    const sm1 = createTestSessionManagerFn()
    sm1.setEventSink(eventSink([]))
    const managed1 = makeManaged(sm1, workspaceId, sessionId)
    ;(sm1 as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed1, workflowPrompt)
    expect(managed1.pendingApproval).toMatchObject({ requestId: 'perm-wf-1', toolName: 'workflow' })
    await sessionPersistenceQueue.flushAll()
    sm1.cleanup()

    // Restart-shaped: a NEW manager over the same storage.
    const sm2 = createTestSessionManagerFn()
    ;(sm2 as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(workspaceId)
    sm2.reloadSessions()
    const managed2 = (sm2 as unknown as { sessions: Map<string, typeof managed1> }).sessions.get(`${workspaceId}:${sessionId}`)!
    const events2: SessionEvent[] = []
    sm2.setEventSink(eventSink(events2))

    // Real turn plumbing with a scripted backend: the resumed subprocess
    // re-drives the pending call (PreToolUse re-fires through the production
    // band), then the tool executes and reports its result.
    const internals = sm2 as unknown as {
      acquireCapabilityTurn(managed: unknown): Promise<() => void>
      createCapabilityTurn(managed: unknown): Promise<unknown>
      createRetainedCapabilityLease(leaseId: string): unknown
      getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
      handleAgentPermissionRequest(m: unknown, r: unknown): void
    }
    internals.acquireCapabilityTurn = async () => () => {}
    internals.createCapabilityTurn = async () => ({
      snapshot: { leaseId: 'redrive-lease' },
      runtime: { view: { sources: [] }, materializer: {} },
    })
    internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })
    sm2.flushSession = async () => {}

    const agentResponses: Array<{ requestId: string; allowed: boolean }> = []
    const chatInvocations: string[] = []
    const agent = {
      isProcessing: () => true,
      setAllSources: () => {},
      setSourceServers: async () => {},
      getModel: () => 'test-model',
      getSessionId: () => undefined,
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      drainAutomationEvents: async () => {},
      forceAbort: () => {},
      dispose: () => {},
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
      respondToPermission: (requestId: string, allowed: boolean) => { agentResponses.push({ requestId, allowed }) },
      chat: async function* (message: string) {
        chatInvocations.push(message)
        // The re-driven call re-fires the gate for the SAME action.
        internals.handleAgentPermissionRequest(managed2, { ...workflowPrompt, requestId: 'perm-wf-redriven' })
        yield { type: 'tool_start', toolName: 'workflow', toolUseId: 'wf-run-1', input: { name: 'pass11-demo' } }
        yield { type: 'tool_result', toolUseId: 'wf-run-1', toolName: 'workflow', result: 'pass11-demo ran', isError: false }
        yield { type: 'complete', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }
      },
    }
    internals.getOrCreateAgent = async () => {
      ;(managed2 as { agent: unknown }).agent = agent
      return agent
    }

    // Open re-fires the card; Allow must re-drive and complete the call.
    await sm2.getSession(sessionId, workspaceId)
    expect(events2.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(sm2.respondToPermission(sessionId, 'perm-wf-1', true, false, undefined, workspaceId)).toBe(true)

    // Wait for the async re-drive to run the scripted turn to completion.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (JSON.stringify((managed2 as unknown as { messages: unknown[] }).messages).includes('pass11-demo ran')) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    expect(chatInvocations).toHaveLength(1)
    // The re-driven prompt auto-approved: no second card reached the renderer.
    expect(events2.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(agentResponses).toEqual([{ requestId: 'perm-wf-redriven', allowed: true }])
    // The tool RESULT landed in the session transcript.
    expect(JSON.stringify((managed2 as unknown as { messages: unknown[] }).messages)).toContain('pass11-demo ran')
    sm2.cleanup()
  })

  it('deny on a re-fired prompt executes nothing and ends the turn cleanly', async () => {
    const workspaceId = `ws_durable_deny_${Date.now().toString(36)}`
    const sessionId = 'session_redrive_deny'
    const workflowPrompt = {
      requestId: 'perm-wf-deny',
      toolName: 'workflow',
      command: 'pass11-demo',
      description: 'Launch workflow "pass11-demo"',
      type: 'workflow_launch' as const,
    }

    const sm1 = createTestSessionManagerFn()
    sm1.setEventSink(eventSink([]))
    const managed1 = makeManaged(sm1, workspaceId, sessionId)
    ;(sm1 as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed1, workflowPrompt)
    await sessionPersistenceQueue.flushAll()
    sm1.cleanup()

    const sm2 = createTestSessionManagerFn()
    ;(sm2 as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(workspaceId)
    sm2.reloadSessions()
    const managed2 = (sm2 as unknown as { sessions: Map<string, typeof managed1> }).sessions.get(`${workspaceId}:${sessionId}`)!
    const events2: SessionEvent[] = []
    sm2.setEventSink(eventSink(events2))
    const redriveDispatches: string[] = []
    ;(sm2 as unknown as { sendMessage(sessionId: string, message: string): Promise<void> }).sendMessage
      = async (_sessionId: string, message: string) => { redriveDispatches.push(message) }

    await sm2.getSession(sessionId, workspaceId)
    expect(events2.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(sm2.respondToPermission(sessionId, 'perm-wf-deny', false, false, undefined, workspaceId)).toBe(true)
    await new Promise(resolve => setImmediate(resolve))
    await awaitComplete(events2)

    // Nothing executes and nothing is re-driven...
    expect(redriveDispatches).toHaveLength(0)
    expect(managed2.pendingApproval).toBeUndefined()
    // ...and the turn ends cleanly: the renderer gets a `complete`, so it can
    // never sit on "Responding…" (the pass-11 hang shape).
    expect(events2.filter(event => event.type === 'complete')).toHaveLength(1)
    expect((managed2 as { isProcessing?: boolean }).isProcessing ?? false).toBe(false)
    sm2.cleanup()
  })

  it('does not re-present a prompt that outlived its lifetime: it is denied, cleared and the turn ends cleanly', async () => {
    // The inert half of the durable record: `requestedAt` was written and read
    // by nothing, so a week-old prompt came back on open looking live.
    const workspaceId = `ws_durable_expiry_${Date.now().toString(36)}`
    const sessionId = 'session_durable_expired'
    const sm1 = createTestSessionManagerFn()
    sm1.setEventSink(eventSink([]))
    const managed1 = makeManaged(sm1, workspaceId, sessionId)
    ;(sm1 as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed1, { ...promptRequest, requestId: 'perm-expired-1' })
    // Age the persisted record a week, then round-trip it through disk.
    ;(managed1.pendingApproval as unknown as { requestedAt: number }).requestedAt
      = Date.now() - 7 * 24 * 60 * 60 * 1000
    ;(sm1 as unknown as { persistSession(m: unknown, strict?: boolean): void }).persistSession(managed1, true)
    await sessionPersistenceQueue.flushAll()
    sm1.cleanup()

    const sm2 = createTestSessionManagerFn()
    ;(sm2 as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(workspaceId)
    sm2.reloadSessions()
    const managed2 = (sm2 as unknown as { sessions: Map<string, typeof managed1> }).sessions.get(`${workspaceId}:${sessionId}`)!
    expect((managed2.pendingApproval as unknown as { requestedAt: number }).requestedAt).toBeLessThan(Date.now() - 60_000)
    const events2: SessionEvent[] = []
    sm2.setEventSink(eventSink(events2))

    await sm2.getSession(sessionId, workspaceId)
    await awaitComplete(events2)

    // No card: the human is never asked to approve a decision from last week.
    expect(events2.filter(event => event.type === 'permission_request')).toHaveLength(0)
    // The record is gone, so it cannot be settled into an execution later...
    expect(managed2.pendingApproval).toBeUndefined()
    // ...and the turn ends cleanly rather than hanging on "Responding…".
    expect(events2.filter(event => event.type === 'complete')).toHaveLength(1)
    expect((managed2 as { isProcessing?: boolean }).isProcessing ?? false).toBe(false)
    // The human is told what happened instead of watching a card vanish.
    const info = events2.filter(event => event.type === 'info') as unknown as Array<{ message: string }>
    expect(info.some(event => event.message.includes('expired'))).toBe(true)
    sm2.cleanup()
  })

  it('refuses an allow that arrives after the prompt expired: nothing is re-driven and nothing is remembered', async () => {
    const workspaceId = `ws_durable_late_allow_${Date.now().toString(36)}`
    const sessionId = 'session_durable_late_allow'
    const sm1 = createTestSessionManagerFn()
    sm1.setEventSink(eventSink([]))
    const managed1 = makeManaged(sm1, workspaceId, sessionId)
    ;(sm1 as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed1, { ...promptRequest, requestId: 'perm-late-1' })
    await sessionPersistenceQueue.flushAll()
    sm1.cleanup()

    const sm2 = createTestSessionManagerFn()
    ;(sm2 as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(workspaceId)
    sm2.reloadSessions()
    const managed2 = (sm2 as unknown as { sessions: Map<string, typeof managed1> }).sessions.get(`${workspaceId}:${sessionId}`)!
    const events2: SessionEvent[] = []
    sm2.setEventSink(eventSink(events2))
    const redriveDispatches: string[] = []
    ;(sm2 as unknown as { sendMessage(sessionId: string, message: string): Promise<void> }).sendMessage
      = async (_sessionId: string, message: string) => { redriveDispatches.push(message) }

    // The card was re-fired while the record was still fresh...
    await sm2.getSession(sessionId, workspaceId)
    expect(events2.filter(event => event.type === 'permission_request')).toHaveLength(1)
    // ...and the answer arrives a week later, with the window left open.
    ;(managed2.pendingApproval as unknown as { requestedAt: number }).requestedAt
      = Date.now() - 7 * 24 * 60 * 60 * 1000
    expect(sm2.respondToPermission(sessionId, 'perm-late-1', true, false, undefined, workspaceId)).toBe(true)
    await new Promise(resolve => setImmediate(resolve))
    await awaitComplete(events2)

    // The allow fails toward NOT executing: no re-drive, record cleared,
    // terminal `complete` so the renderer is not left waiting.
    expect(redriveDispatches).toHaveLength(0)
    expect(managed2.pendingApproval).toBeUndefined()
    expect(events2.filter(event => event.type === 'complete')).toHaveLength(1)

    // And nothing was remembered: the same command still asks. (The fresh-path
    // test above proves this assertion fires the other way when it should.)
    const agentResponses: Array<{ requestId: string; allowed: boolean }> = []
    managed2.agent = {
      respondToPermission: (requestId: string, allowed: boolean) => { agentResponses.push({ requestId, allowed }) },
    }
    ;(sm2 as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed2, { ...promptRequest, requestId: 'perm-late-2' })
    expect(agentResponses).toHaveLength(0)
    expect(events2.filter(event => event.type === 'permission_request')).toHaveLength(2)
    sm2.cleanup()
  })

  it('clears the persisted pending approval when a live prompt is answered', () => {
    const workspaceId = `ws_durable_live_${Date.now().toString(36)}`
    const sm = createTestSessionManagerFn()
    sm.setEventSink(eventSink([]))
    const managed = makeManaged(sm, workspaceId, 'session_live')
    const responses: unknown[] = []
    managed.agent = { respondToPermission: (...args: unknown[]) => { responses.push(args) } }

    ;(sm as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed, { ...promptRequest, requestId: 'perm-live-1' })
    expect(managed.pendingApproval).toMatchObject({ requestId: 'perm-live-1' })

    expect(sm.respondToPermission('session_live', 'perm-live-1', false, false, undefined, workspaceId)).toBe(true)
    expect(responses).toHaveLength(1)
    expect(managed.pendingApproval).toBeUndefined()
    sm.cleanup()
  })

  it('does not double-persist ask_user prompts, which stay durable through pendingAskUser', () => {
    const workspaceId = `ws_durable_ask_${Date.now().toString(36)}`
    const sm = createTestSessionManagerFn()
    sm.setEventSink(eventSink([]))
    const managed = makeManaged(sm, workspaceId, 'session_ask')

    ;(sm as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed, {
        requestId: 'ask-1',
        toolName: 'ask_user',
        command: 'Which path?',
        description: 'Which path?',
        type: 'ask_user',
        askUser: { question: 'Which path?', options: ['a', 'b'], allowFreeText: false },
      })
    expect(managed.pendingApproval).toBeUndefined()
    sm.cleanup()
  })
})

describe('UA12.75 — the Conductor withdraws the durable card of a child it abandoned at a restart', () => {
  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  type Withdrawing = { withdrawAbandonedTaskChildApproval(sessionId: string, workspaceId: string): Promise<boolean> }

  /** A session (a Conductor child when `taskNodeId` is set) with a card persisted, then a restart-shaped reload. */
  async function restartedWithCard(tag: string, taskNodeId: string | undefined) {
    const workspaceId = `ws_ua12_75_${tag}_${Date.now().toString(36)}`
    const sessionId = `session_ua12_75_${tag}`
    const sm1 = createTestSessionManagerFn()
    sm1.setEventSink(eventSink([]))
    const managed1 = makeManaged(sm1, workspaceId, sessionId)
    if (taskNodeId) Object.assign(managed1, { taskSlug: 'weekly', taskRunId: 'r1', taskNodeId })
    ;(sm1 as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed1, { ...promptRequest, requestId: `perm-${tag}` })
    await sessionPersistenceQueue.flushAll()
    sm1.cleanup()
    const sm2 = createTestSessionManagerFn()
    ;(sm2 as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(workspaceId)
    sm2.reloadSessions()
    const managed2 = (sm2 as unknown as { sessions: Map<string, typeof managed1> }).sessions.get(`${workspaceId}:${sessionId}`)!
    const events: SessionEvent[] = []
    sm2.setEventSink(eventSink(events))
    const redrives: string[] = []
    ;(sm2 as unknown as { sendMessage(sessionId: string, message: string): Promise<void> }).sendMessage
      = async (_sessionId: string, message: string) => { redrives.push(message) }
    return { sm2, managed2, events, redrives, workspaceId, sessionId, requestId: `perm-${tag}` }
  }

  it('CONTROL: withdrawn on Resume — never re-presented, and an Allow re-drives no turn', async () => {
    const h = await restartedWithCard('abandoned', 'a')
    expect(await (h.sm2 as unknown as Withdrawing).withdrawAbandonedTaskChildApproval(h.sessionId, h.workspaceId)).toBe(true)
    await awaitComplete(h.events)
    expect(h.managed2.pendingApproval).toBeUndefined()
    await h.sm2.getSession(h.sessionId, h.workspaceId)
    expect(h.events.filter(event => event.type === 'permission_request')).toHaveLength(0)
    h.sm2.respondToPermission(h.sessionId, h.requestId, true, false, undefined, h.workspaceId)
    await new Promise(resolve => setImmediate(resolve))
    expect(h.redrives).toEqual([])
    h.sm2.cleanup()
  })

  it('CONTROL: a card already re-presented (the child was opened before Resume) is withdrawn from the renderer too', async () => {
    const h = await restartedWithCard('shown', 'a')
    await h.sm2.getSession(h.sessionId, h.workspaceId)
    expect(h.events.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(await (h.sm2 as unknown as Withdrawing).withdrawAbandonedTaskChildApproval(h.sessionId, h.workspaceId)).toBe(true)
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'permission_request_cancelled', requestId: h.requestId }))
    h.sm2.respondToPermission(h.sessionId, h.requestId, true, false, undefined, h.workspaceId)
    await new Promise(resolve => setImmediate(resolve))
    expect(h.redrives).toEqual([])
    h.sm2.cleanup()
  })

  it('NEGATIVE: a session that is not a Conductor child keeps its card, and its Allow still re-drives (the instrument sees a re-drive)', async () => {
    const h = await restartedWithCard('plain', undefined)
    expect(await (h.sm2 as unknown as Withdrawing).withdrawAbandonedTaskChildApproval(h.sessionId, h.workspaceId)).toBe(false)
    await h.sm2.getSession(h.sessionId, h.workspaceId)
    expect(h.events.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(h.sm2.respondToPermission(h.sessionId, h.requestId, true, false, undefined, h.workspaceId)).toBe(true)
    await new Promise(resolve => setImmediate(resolve))
    expect(h.redrives).toHaveLength(1)
    h.sm2.cleanup()
  })
})

/**
 * F1.1231 — the durable record keeps the SDK's `defaultToNo` hint (F1.1219), so
 * a card re-fired after a restart still opens on Deny. Claude records expire on
 * that path today (F1.954); this holds for any producer that sets the field.
 */
describe('F1.1231 — a re-fired card keeps defaultToNo', () => {
  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  async function refireAfterRestart(request: Record<string, unknown>, sessionId: string) {
    const workspaceId = `ws_durable_dtn_${sessionId}_${Date.now().toString(36)}`
    const sm1 = createTestSessionManagerFn()
    sm1.setEventSink(eventSink([]))
    const managed1 = makeManaged(sm1, workspaceId, sessionId)
    managed1.agent = { respondToPermission: () => {} }
    ;(sm1 as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed1, request)
    const persisted = { ...(managed1.pendingApproval as Record<string, unknown>) }
    await sessionPersistenceQueue.flushAll()
    sm1.cleanup()

    const sm2 = createTestSessionManagerFn()
    ;(sm2 as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(workspaceId)
    sm2.reloadSessions()
    const events2: SessionEvent[] = []
    sm2.setEventSink(eventSink(events2))
    await sm2.getSession(sessionId, workspaceId)
    const reEmitted = events2.filter(event => event.type === 'permission_request') as unknown as Array<{ request: Record<string, unknown> }>
    sm2.cleanup()
    return { persisted, reEmitted }
  }

  it('a defaultToNo ask is persisted with the hint and re-fired with it', async () => {
    const { persisted, reEmitted } = await refireAfterRestart({ ...promptRequest, requestId: 'perm-dtn-1', defaultToNo: true }, 'session_dtn')
    expect(persisted.defaultToNo).toBe(true)
    expect(reEmitted).toHaveLength(1)
    expect(reEmitted[0]!.request.requestId).toBe('perm-dtn-1')
    expect(reEmitted[0]!.request.defaultToNo).toBe(true)
  })

  it('CONTROL: an ordinary ask carries no defaultToNo before or after the restart', async () => {
    const { persisted, reEmitted } = await refireAfterRestart({ ...promptRequest, requestId: 'perm-dtn-2' }, 'session_plain')
    expect('defaultToNo' in persisted).toBe(false)
    expect(reEmitted).toHaveLength(1)
    expect('defaultToNo' in reEmitted[0]!.request).toBe(false)
  })
})

/**
 * UA12.187 — UA12.75's withdrawal also reached a LIVE card: once the user opened the abandoned child and a turn ran
 * there again (an Allow re-drove it, or they typed), the card was raised in THIS process and its waiter — the runtime
 * (`agent`) or Pi's host resolver — is alive. Expiring it left that waiter unresolved while the session showed idle.
 * A live waiter is denied through the ordinary answer path, and the card leaves the screen; only a record with no live
 * waiter is expired (the UA12.75 arms above).
 */
describe('UA12.187 — a LIVE card in an abandoned child is denied through its waiter', () => {
  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  type Withdrawing = { withdrawAbandonedTaskChildApproval(sessionId: string, workspaceId: string): Promise<boolean> }

  function liveCard(tag: string, waiter: 'agent' | 'resolver', taskNodeId: string | undefined) {
    const workspaceId = `ws_ua12_187_${tag}_${Date.now().toString(36)}`
    const sessionId = `session_ua12_187_${tag}`
    const requestId = `perm-live-${tag}`
    const sm = createTestSessionManagerFn()
    const events: SessionEvent[] = []
    sm.setEventSink(eventSink(events))
    const managed = makeManaged(sm, workspaceId, sessionId)
    Object.assign(managed, { isProcessing: true })
    if (taskNodeId) Object.assign(managed, { taskSlug: 'weekly', taskRunId: 'r1', taskNodeId })
    const answers: Array<{ requestId: string; allowed: boolean }> = []
    if (waiter === 'agent') {
      managed.agent = { respondToPermission: (id: string, allowed: boolean) => { answers.push({ requestId: id, allowed }) } }
    } else {
      ;(sm as unknown as { directPermissionResolvers: Map<string, unknown> }).directPermissionResolvers.set(requestId, {
        sessionId,
        resolve: (allowed: boolean) => { answers.push({ requestId, allowed }) },
      })
    }
    ;(sm as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed, { ...promptRequest, requestId })
    return { sm, managed, events, answers, workspaceId, sessionId, requestId }
  }

  for (const waiter of ['agent', 'resolver'] as const) {
    it(`RED (${waiter}): Resume denies the live card through its waiter and takes it off the screen; the waiter's turn is not ended by the host`, async () => {
      const h = liveCard(`${waiter}-child`, waiter, 'a')
      expect(h.managed.pendingApproval?.requestId).toBe(h.requestId)
      expect(await (h.sm as unknown as Withdrawing).withdrawAbandonedTaskChildApproval(h.sessionId, h.workspaceId)).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(h.answers).toEqual([{ requestId: h.requestId, allowed: false }])
      expect(h.managed.pendingApproval).toBeUndefined()
      expect(h.events).toContainEqual(expect.objectContaining({ type: 'permission_request_cancelled', requestId: h.requestId }))
      // The runtime ends its own turn after the denial; the host's expiry `complete` would race it.
      expect(h.events.filter(event => event.type === 'complete')).toEqual([])
      expect(h.managed.isProcessing).toBe(true)
      h.sm.cleanup()
    })

    it(`NEGATIVE (${waiter}): a live card in a session that is not a Conductor child is untouched`, async () => {
      const h = liveCard(`${waiter}-plain`, waiter, undefined)
      expect(await (h.sm as unknown as Withdrawing).withdrawAbandonedTaskChildApproval(h.sessionId, h.workspaceId)).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(h.answers).toEqual([])
      expect(h.managed.pendingApproval?.requestId).toBe(h.requestId)
      expect(h.events.filter(event => event.type === 'permission_request_cancelled' || event.type === 'complete')).toEqual([])
      h.sm.cleanup()
    })
  }
})

/**
 * UA12.190 (P-LF-4-3) — UA12.75 withdraws an abandoned child's durable PERMISSION card; an `ask_user` question is
 * durable through `pendingAskUser` instead (Pi's AskUserService, never `pendingApproval`), so whether answering it
 * after Resume re-drives anything was unmeasured. Measured here on both states the child can be in: nothing re-drives.
 * (UA12.203 then made Resume withdraw the question itself — its describe at the end of this file.)
 */
describe('UA12.190 — an abandoned child\'s persisted ask_user, answered after a restart, re-drives no turn', () => {
  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  const answer = { type: 'option' as const, value: 'Yes', optionIndex: 0 }

  /** A Conductor child with a question persisted (`pendingAskUser`), then a restart-shaped reload and Resume. */
  async function restartedWithQuestion(tag: string) {
    const workspaceId = `ws_ua12_190_${tag}_${Date.now().toString(36)}`
    const sessionId = `session_ua12_190_${tag}`
    const requestId = `ask-${tag}`
    const sm1 = createTestSessionManagerFn()
    sm1.setEventSink(eventSink([]))
    const managed1 = makeManaged(sm1, workspaceId, sessionId)
    Object.assign(managed1, {
      taskSlug: 'weekly', taskRunId: 'r1', taskNodeId: 'a',
      pendingAskUser: { schemaVersion: 1, requestId, question: 'Proceed?', options: ['Yes', 'No'], allowFreeText: false },
    })
    ;(sm1 as unknown as { persistSession(m: unknown, immediate: boolean): void }).persistSession(managed1, true)
    await sessionPersistenceQueue.flushAll()
    sm1.cleanup()
    const sm2 = createTestSessionManagerFn()
    ;(sm2 as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(workspaceId)
    sm2.reloadSessions()
    const managed2 = (sm2 as unknown as { sessions: Map<string, typeof managed1> }).sessions.get(`${workspaceId}:${sessionId}`)!
    const events: SessionEvent[] = []
    sm2.setEventSink(eventSink(events))
    const redrives: string[] = []
    ;(sm2 as unknown as { sendMessage(sessionId: string, message: string): Promise<void> }).sendMessage
      = async (_sessionId: string, message: string) => { redrives.push(message) }
    await sm2.getSession(sessionId, workspaceId)
    // UA12.203 — Resume now withdraws this question (the describe below); these arms measure the answer path on a
    // question that outlived a restart with no Resume (a run that was never resumed), which UA12.190 owed.
    expect((managed2 as unknown as { pendingAskUser?: { requestId: string } }).pendingAskUser?.requestId).toBe(requestId)
    return { sm2, managed2, events, redrives, workspaceId, sessionId, requestId }
  }

  it('NO AGENT (what a restart leaves): the question is not re-presented on open, and an answer settles nothing and re-drives nothing', async () => {
    const h = await restartedWithQuestion('idle')
    expect(h.events.filter(event => event.type === 'permission_request')).toEqual([])
    expect(h.sm2.respondToPermission(h.sessionId, h.requestId, true, false, { askUserAnswer: answer }, h.workspaceId)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.redrives).toEqual([])
    expect(h.events.filter(event => event.type === 'complete')).toEqual([])
    h.sm2.cleanup()
  })

  it('RE-PRESENTED (a later turn built the Pi AskUserService, which re-fires the card): the answer clears the question and re-drives nothing', async () => {
    const h = await restartedWithQuestion('shown')
    const { AskUserService } = await import('../pi-harness/ask-user-service.ts')
    const sm = h.sm2 as unknown as {
      managedKey(m: unknown): string
      piAskUserServices: Map<string, unknown>
      persistSession(m: unknown, immediate: boolean): void
      clearSettledAskUserPermission(sessionId: string, workspaceId: string, requestId: string): void
      handleAgentPermissionRequest(m: unknown, r: unknown): void
    }
    const managed = h.managed2 as unknown as { pendingAskUser?: { requestId: string; question: string } } & Record<string, unknown>
    // The production construction (SessionManager's Pi agent build): persist through the managed field, settle the
    // card's record on a terminal answer, start from the persisted question with NO waiter (it died with the process).
    const service = new AskUserService({ workspaceId: h.workspaceId, sessionId: h.sessionId } as never, pending => {
      managed.pendingAskUser = pending as never
      sm.persistSession(managed, true)
    }, managed.pendingAskUser as never, requestId => { sm.clearSettledAskUserPermission(h.sessionId, h.workspaceId, requestId) })
    sm.piAskUserServices.set(sm.managedKey(managed), service)
    managed.agent = { respondToPermission: () => { throw new Error('an ask_user answer must not reach the runtime') } }
    service.reproject(request => sm.handleAgentPermissionRequest(managed, {
      requestId: request.requestId, toolName: 'ask_user', command: request.question, description: request.question, type: 'ask_user', askUser: request,
    }))
    expect(h.events.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(h.sm2.respondToPermission(h.sessionId, h.requestId, true, false, { askUserAnswer: answer }, h.workspaceId)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(managed.pendingAskUser).toBeUndefined()
    expect(service.pending()).toBeUndefined()
    expect(h.redrives).toEqual([])
    h.sm2.cleanup()
  })
})

/**
 * UA12.202 — UA12.187 denies a LIVE card of an abandoned child through the ordinary answer path, and that path counts
 * P6.461's `code_edit_tool.decision` ("Incremented when user accepts or rejects Edit, Write, or NotebookEdit tool
 * usage"). The host's withdrawal is no person's answer, so a withdrawal-denied `file_write` card counts nothing; a
 * person's reject of the same card still counts one `user_reject`.
 */
describe('UA12.202 — a withdrawal-denied file_write card counts no code_edit_tool.decision', () => {
  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  type Withdrawing = { withdrawAbandonedTaskChildApproval(sessionId: string, workspaceId: string): Promise<boolean> }
  const writeRequest = {
    requestId: 'perm-write',
    toolName: 'Write',
    command: '/tmp/ua12-202/src/index.ts',
    description: 'Write /tmp/ua12-202/src/index.ts',
    type: 'file_write' as const,
  }

  function liveWriteCard(tag: string, taskNodeId: string | undefined) {
    const workspaceId = `ws_ua12_202_${tag}_${Date.now().toString(36)}`
    const sessionId = `session_ua12_202_${tag}`
    const requestId = `perm-write-${tag}`
    const counted: Array<{ metric: string } & Record<string, unknown>> = []
    const sm = createTestSessionManagerFn({
      usageMetrics: {
        record: () => {},
        count: event => { counted.push(event as never) },
        flush: async () => undefined,
        shutdown: async () => undefined,
      },
    })
    sm.setEventSink(eventSink([]))
    const managed = makeManaged(sm, workspaceId, sessionId)
    Object.assign(managed, { isProcessing: true })
    if (taskNodeId) Object.assign(managed, { taskSlug: 'weekly', taskRunId: 'r1', taskNodeId })
    const answers: boolean[] = []
    managed.agent = { respondToPermission: (_id: string, allowed: boolean) => { answers.push(allowed) } }
    ;(sm as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void })
      .handleAgentPermissionRequest(managed, { ...writeRequest, requestId })
    const decisions = () => counted.filter(event => event.metric === 'code_edit_tool.decision')
    return { sm, managed, answers, decisions, workspaceId, sessionId, requestId }
  }

  it('RED: Resume denies the live file_write card of an abandoned child and counts no decision', async () => {
    const h = liveWriteCard('child', 'a')
    expect(await (h.sm as unknown as Withdrawing).withdrawAbandonedTaskChildApproval(h.sessionId, h.workspaceId)).toBe(true)
    expect(h.answers).toEqual([false])
    expect(h.decisions()).toEqual([])
    h.sm.cleanup()
  })

  it('POSITIVE + BOUNDARY: a person\'s reject of the same card counts one user_reject, before and after a withdrawal in that manager', async () => {
    const h = liveWriteCard('person', undefined)
    expect(h.sm.respondToPermission(h.sessionId, h.requestId, false, false, undefined, h.workspaceId)).toBe(true)
    expect(h.decisions()).toEqual([expect.objectContaining({ decision: 'reject', source: 'user_reject', toolName: 'Write' })])
    // A withdrawal in the same manager leaves no exemption behind: the next person's answer counts again.
    const child = makeManaged(h.sm, h.workspaceId, `${h.sessionId}_child`)
    Object.assign(child, { taskSlug: 'weekly', taskRunId: 'r1', taskNodeId: 'b', isProcessing: true })
    child.agent = { respondToPermission: () => {} }
    const sm = h.sm as unknown as { handleAgentPermissionRequest(m: unknown, r: unknown): void }
    sm.handleAgentPermissionRequest(child, { ...writeRequest, requestId: 'perm-write-child-b' })
    expect(await (h.sm as unknown as Withdrawing).withdrawAbandonedTaskChildApproval(child.id, h.workspaceId)).toBe(true)
    sm.handleAgentPermissionRequest(h.managed, { ...writeRequest, requestId: 'perm-write-person-2' })
    expect(h.sm.respondToPermission(h.sessionId, 'perm-write-person-2', true, false, undefined, h.workspaceId)).toBe(true)
    expect(h.decisions().map(event => event.source)).toEqual(['user_reject', 'user_temporary'])
    h.sm.cleanup()
  })
})

/**
 * UA12.203 — an abandoned child's persisted `ask_user` question survived Resume (UA12.75 and UA12.187 touched only
 * `pendingApproval`), so the session kept counting `pendingAskUser: 1` — its attention state — for a question nobody
 * can answer usefully (UA12.190: an answer re-drives nothing). Resume withdraws it the way UA12.187 settles a card: a
 * question the Pi AskUserService holds is cancelled through the service (a live waiter hears the ordinary `cancelled`,
 * the persisted record is cleared, the card's record goes), a record with no service is cleared; a question already on
 * screen leaves it. Only a Conductor child (`taskNodeId`) is touched.
 */
describe('UA12.203 — Resume withdraws an abandoned child\'s pending ask_user', () => {
  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  type Internals = {
    withdrawAbandonedTaskChildApproval(sessionId: string, workspaceId: string): Promise<boolean>
    liveAgentBusyDomainsFor(managed: unknown): Promise<readonly string[]>
    managedKey(m: unknown): string
    piAskUserServices: Map<string, unknown>
    pendingPermissionRequests: Map<string, unknown>
    persistSession(m: unknown, immediate: boolean): void
    clearSettledAskUserPermission(sessionId: string, workspaceId: string, requestId: string): void
    handleAgentPermissionRequest(m: unknown, r: unknown): void
  }
  type WithAsk = { pendingAskUser?: { requestId: string } }

  /** A question persisted in a session (a Conductor child when `taskNodeId`), then a restart-shaped reload and open. */
  async function restartedWithQuestion(tag: string, taskNodeId: string | undefined) {
    const workspaceId = `ws_ua12_203_${tag}_${Date.now().toString(36)}`
    const sessionId = `session_ua12_203_${tag}`
    const requestId = `ask-${tag}`
    const sm1 = createTestSessionManagerFn()
    sm1.setEventSink(eventSink([]))
    const managed1 = makeManaged(sm1, workspaceId, sessionId)
    Object.assign(managed1, {
      ...(taskNodeId ? { taskSlug: 'weekly', taskRunId: 'r1', taskNodeId } : {}),
      pendingAskUser: { schemaVersion: 1, requestId, question: 'Proceed?', options: ['Yes', 'No'], allowFreeText: false },
    })
    ;(sm1 as unknown as Internals).persistSession(managed1, true)
    await sessionPersistenceQueue.flushAll()
    sm1.cleanup()
    const sm2 = createTestSessionManagerFn()
    ;(sm2 as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(workspaceId)
    sm2.reloadSessions()
    const managed2 = (sm2 as unknown as { sessions: Map<string, typeof managed1> }).sessions.get(`${workspaceId}:${sessionId}`)!
    sm2.setEventSink(eventSink([]))
    await sm2.getSession(sessionId, workspaceId)
    expect((managed2 as unknown as WithAsk).pendingAskUser?.requestId).toBe(requestId)
    return { sm2, managed2, workspaceId, sessionId, requestId }
  }

  /** A question a LIVE Pi AskUserService is waiting on, on screen (the production construction of the agent build). */
  async function liveQuestion(tag: string, taskNodeId: string | undefined) {
    const workspaceId = `ws_ua12_203_${tag}_${Date.now().toString(36)}`
    const sessionId = `session_ua12_203_${tag}`
    const requestId = `ask-live-${tag}`
    const sm = createTestSessionManagerFn()
    const events: SessionEvent[] = []
    sm.setEventSink(eventSink(events))
    const managed = makeManaged(sm, workspaceId, sessionId) as ReturnType<typeof makeManaged> & WithAsk
    Object.assign(managed, { isProcessing: true })
    if (taskNodeId) Object.assign(managed, { taskSlug: 'weekly', taskRunId: 'r1', taskNodeId })
    managed.agent = { respondToPermission: () => { throw new Error('an ask_user answer must not reach the runtime') } }
    const internals = sm as unknown as Internals
    const { AskUserService } = await import('../pi-harness/ask-user-service.ts')
    const service = new AskUserService({ workspaceId, sessionId } as never, pending => {
      managed.pendingAskUser = pending as never
      internals.persistSession(managed, true)
    }, undefined, id => { internals.clearSettledAskUserPermission(sessionId, workspaceId, id) })
    internals.piAskUserServices.set(internals.managedKey(managed), service)
    const settled: string[] = []
    void service.request(
      { requestId, question: 'Proceed?', options: ['Yes', 'No'], allowFreeText: false } as never,
      request => internals.handleAgentPermissionRequest(managed, {
        requestId: request.requestId, toolName: 'ask_user', command: request.question, description: request.question, type: 'ask_user', askUser: request,
      }),
    ).then(() => { settled.push('answered') }, (error: Error) => { settled.push(error.message) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(internals.pendingPermissionRequests.has(requestId)).toBe(true)
    expect(managed.pendingAskUser?.requestId).toBe(requestId)
    return { sm, managed, service, events, settled, internals, workspaceId, sessionId, requestId }
  }

  it('RED (no service — what a restart leaves): Resume clears the persisted question, durably, and the session stops counting it', async () => {
    const h = await restartedWithQuestion('child', 'a')
    const internals = h.sm2 as unknown as Internals
    expect(await internals.liveAgentBusyDomainsFor(h.managed2)).toContain('ask_user')
    expect(await internals.withdrawAbandonedTaskChildApproval(h.sessionId, h.workspaceId)).toBe(true)
    expect((h.managed2 as unknown as WithAsk).pendingAskUser).toBeUndefined()
    expect(await internals.liveAgentBusyDomainsFor(h.managed2)).not.toContain('ask_user')
    await sessionPersistenceQueue.flushAll()
    h.sm2.cleanup()
    const sm3 = createTestSessionManagerFn()
    ;(sm3 as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(h.workspaceId)
    sm3.reloadSessions()
    const reloaded = (sm3 as unknown as { sessions: Map<string, WithAsk> }).sessions.get(`${h.workspaceId}:${h.sessionId}`)!
    await sm3.getSession(h.sessionId, h.workspaceId)
    expect(reloaded.pendingAskUser).toBeUndefined()
    sm3.cleanup()
  })

  it('RED (live waiter): Resume cancels the question through the service, the waiter hears cancelled and the card leaves the screen', async () => {
    const h = await liveQuestion('child', 'a')
    expect(await h.internals.withdrawAbandonedTaskChildApproval(h.sessionId, h.workspaceId)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.settled).toEqual(['cancelled'])
    expect(h.service.pending()).toBeUndefined()
    expect(h.managed.pendingAskUser).toBeUndefined()
    expect(h.internals.pendingPermissionRequests.has(h.requestId)).toBe(false)
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'permission_request_cancelled', requestId: h.requestId }))
    expect(await h.internals.liveAgentBusyDomainsFor(h.managed)).not.toContain('ask_user')
    h.sm.cleanup()
  })

  it('NEGATIVE (no service): a persisted question in a session that is not a Conductor child stays', async () => {
    const h = await restartedWithQuestion('plain', undefined)
    const internals = h.sm2 as unknown as Internals
    expect(await internals.withdrawAbandonedTaskChildApproval(h.sessionId, h.workspaceId)).toBe(false)
    expect((h.managed2 as unknown as WithAsk).pendingAskUser?.requestId).toBe(h.requestId)
    expect(await internals.liveAgentBusyDomainsFor(h.managed2)).toContain('ask_user')
    h.sm2.cleanup()
  })

  it('NEGATIVE (live waiter): a live question in a session that is not a Conductor child is untouched', async () => {
    const h = await liveQuestion('plain', undefined)
    expect(await h.internals.withdrawAbandonedTaskChildApproval(h.sessionId, h.workspaceId)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.settled).toEqual([])
    expect(h.service.pending()?.requestId).toBe(h.requestId)
    expect(h.internals.pendingPermissionRequests.has(h.requestId)).toBe(true)
    expect(h.events.filter(event => event.type === 'permission_request_cancelled')).toEqual([])
    h.sm.cleanup()
  })
})
