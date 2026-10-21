import { describe, expect, test } from 'bun:test'
import { AskUserService } from '../pi-harness/ask-user-service.ts'
import { PlanModeService } from '../pi-harness/plan-mode-service.ts'
import {
  createManagedSession,
  createPiInteractionPorts,
  persistManagedInteractionState,
} from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sessionKey = { workspaceId: 'workspace-a', sessionId: 'session-a' }

describe('SessionManager Pi interaction composition', () => {
  test('binds hydrated AskUser and Plan services to one canonical SessionKey', async () => {
    const askPersistence: Array<string | undefined> = []
    const projected: string[] = []
    const ask = new AskUserService(sessionKey, pending => {
      askPersistence.push(pending?.requestId)
    }, {
      schemaVersion: 1,
      requestId: 'ask-1',
      question: 'Continue?',
      options: ['Yes', 'No'],
      allowFreeText: false,
    })
    const planPersistence: string[] = []
    const submitted: string[] = []
    const plan = new PlanModeService({
      sessionKey,
      initialMode: 'plan',
      previousMode: 'default',
      setMode: async () => {},
      persist: state => { planPersistence.push(state.kind) },
      onSubmit: path => { submitted.push(path) },
    })
    const { askUserPort, planModePort } = createPiInteractionPorts(sessionKey, ask, plan)

    askUserPort.reproject({ sessionKey, publish: requestId => { projected.push(requestId) } })
    askUserPort.reproject({ sessionKey, publish: requestId => { projected.push(requestId) } })
    await askUserPort.answer({
      sessionKey,
      requestId: 'ask-1',
      answer: { type: 'option', value: 'Yes', optionIndex: 0 },
    })
    await planModePort.submit({ sessionKey, planPath: 'plan.md' })

    expect(projected).toEqual(['ask-1'])
    expect(askPersistence).toEqual([undefined])
    expect(ask.pending()).toBeUndefined()
    expect(planPersistence).toEqual(['awaiting_user', 'awaiting_user'])
    expect(submitted).toEqual(['plan.md'])
    expect(() => planModePort.exit({ sessionKey: { ...sessionKey, workspaceId: 'other' } })).toThrow('pi-interaction-session-mismatch')
  })

  /**
   * ELC-2 (live): an MCP elicitation refusal is an ACKNOWLEDGEMENT — a single
   * `OK` — and on Pi it reaches the user through this port. `validateAskUser`
   * held it to the `ask_user` TOOL's 2-4 floor, threw `invalid-options` before
   * `publish` ever ran, and the throw degraded to `action=cancel`: no card, no
   * `Permission request` line, and the refusal the rule exists to make visible
   * was the one thing the user never saw. The allowance is explicit and travels
   * with the one request that earns it; the tool's floor is unchanged.
   */
  test('publishes a one-option elicitation acknowledgement and keeps the ask_user tool at 2', async () => {
    const published: string[] = []
    const ask = new AskUserService(sessionKey)
    const plan = new PlanModeService({ sessionKey, initialMode: 'default', setMode: async () => {} })
    const { askUserPort } = createPiInteractionPorts(sessionKey, ask, plan)

    const answer = askUserPort.request({
      sessionKey,
      requestId: 'mcp-elicitation',
      askUser: { question: 'Refused: the URL could not be opened.', options: ['OK'], allowFreeText: false },
      headless: false,
      minOptions: 1,
      publish: requestId => { published.push(requestId) },
    })
    await Promise.resolve()
    expect(published).toEqual(['mcp-elicitation'])
    await askUserPort.answer({
      sessionKey,
      requestId: 'mcp-elicitation',
      answer: { type: 'option', value: 'OK', optionIndex: 0 },
    })
    await expect(answer).resolves.toEqual({ type: 'option', value: 'OK', optionIndex: 0 })

    // No allowance, no exemption: the tool a model calls still needs 2 options.
    await expect(askUserPort.request({
      sessionKey,
      requestId: 'ask-tool',
      askUser: { question: 'Only one way out?', options: ['OK'], allowFreeText: false },
      headless: false,
      publish: requestId => { published.push(requestId) },
    })).rejects.toThrow('invalid-options')
    expect(published).toEqual(['mcp-elicitation'])
  })

  /**
   * P2.57 — a cancel arriving under a DRIFTED session key must still tear the
   * host card down.
   *
   * MEASURED on the pre-fix tree, in this exact shape: the port threw
   * `pi-interaction-session-mismatch`, the card stayed (`pending()` = `ask-1`),
   * the persist callback was never called a second time so the pending survived
   * a reload, `onTerminal` never fired, the waiting `ask_user` promise stayed
   * UNSETTLED, and the next question the model tried threw
   * `pending-request-exists` — the session could not ask the user anything again
   * until a human answered the abandoned question themselves.
   *
   * The four assertions below are the four halves of that, and each bites alone:
   * restore the assert in `cancel` and all four fail; make the soft-fail a
   * silent no-op instead and the first three fail.
   */
  test('tears the host card down on a cancel whose session key has drifted', async () => {
    const persisted: Array<string | undefined> = []
    const terminal: string[] = []
    const published: string[] = []
    const ask = new AskUserService(sessionKey, pending => { persisted.push(pending?.requestId) }, undefined, requestId => { terminal.push(requestId) })
    const plan = new PlanModeService({ sessionKey, initialMode: 'default', setMode: async () => {} })
    const { askUserPort } = createPiInteractionPorts(sessionKey, ask, plan)
    const drifted = { ...sessionKey, sessionId: `${sessionKey.sessionId}-drifted` }

    const answer = askUserPort.request({
      sessionKey,
      requestId: 'ask-1',
      askUser: { question: 'Deploy to production?', options: ['Yes', 'No'], allowFreeText: false },
      headless: false,
      publish: requestId => { published.push(requestId) },
    })
    const settlement = answer.then(() => 'resolved', (error: Error) => `rejected:${error.message}`)
    await Promise.resolve()
    expect(ask.pending()?.requestId).toBe('ask-1')

    await askUserPort.cancel({ sessionKey: drifted, requestId: 'ask-1' })

    // 1. the card is gone, 2. and gone from the persisted state a reload reads,
    // 3. the settlement hook the manager clears its own metadata from fired,
    // 4. and the suspended tool call is settled rather than hanging.
    expect(ask.pending()).toBeUndefined()
    expect(persisted).toEqual(['ask-1', undefined])
    expect(terminal).toEqual(['ask-1'])
    await expect(settlement).resolves.toBe('rejected:cancelled')

    // And the session can ask again — the wedge (`pending-request-exists`) is
    // what made this more than a stale card.
    const second = askUserPort.request({
      sessionKey,
      requestId: 'ask-2',
      askUser: { question: 'And now?', options: ['A', 'B'], allowFreeText: false },
      headless: false,
      publish: requestId => { published.push(requestId) },
    })
    second.catch(() => {})
    await Promise.resolve()
    expect(published).toEqual(['ask-1', 'ask-2'])
    await askUserPort.cancel({ sessionKey, requestId: 'ask-2' })
  })

  /**
   * P2.57's blast radius, asserted as IDENTITY rather than as "nothing else
   * changed": the soft-fail is one method wide. `answer` applies data to a card
   * and must still refuse a drifted key, and a `cancel` for a request this
   * service does not hold still fails — `unknown-request` is the guard that
   * actually protects the card, and the soft-fail must not have swallowed it.
   */
  test('keeps the key assert on every port method except cancel', async () => {
    const ask = new AskUserService(sessionKey)
    const plan = new PlanModeService({ sessionKey, initialMode: 'default', setMode: async () => {} })
    const { askUserPort, planModePort } = createPiInteractionPorts(sessionKey, ask, plan)
    const drifted = { ...sessionKey, sessionId: `${sessionKey.sessionId}-drifted` }

    const pending = askUserPort.request({
      sessionKey,
      requestId: 'ask-1',
      askUser: { question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false },
      headless: false,
      publish: () => {},
    })
    pending.catch(() => {})
    await Promise.resolve()

    expect(() => askUserPort.answer({ sessionKey: drifted, requestId: 'ask-1', answer: { type: 'option', value: 'Yes', optionIndex: 0 } }))
      .toThrow('pi-interaction-session-mismatch')
    expect(() => askUserPort.reproject({ sessionKey: drifted, publish: () => {} })).toThrow('pi-interaction-session-mismatch')
    expect(() => planModePort.exit({ sessionKey: drifted })).toThrow('pi-interaction-session-mismatch')
    expect(ask.pending()?.requestId).toBe('ask-1')

    await expect(askUserPort.cancel({ sessionKey: drifted, requestId: 'some-other-request' })).rejects.toThrow('unknown-request')
    expect(ask.pending()?.requestId).toBe('ask-1')
    await askUserPort.cancel({ sessionKey, requestId: 'ask-1' })
    expect(ask.pending()).toBeUndefined()
  })

  test('uses a stable plan submission identity across an outbox retry', async () => {
    const projected: string[] = []
    let fail = true
    const plan = new PlanModeService({
      sessionKey,
      initialMode: 'plan',
      setMode: async () => {},
      onSubmit: async (_path, submissionId) => {
        projected.push(submissionId)
        if (fail) throw new Error('projection-failed')
      },
    })
    await expect(plan.submit('plan.md')).rejects.toThrow('projection-failed')
    fail = false
    await plan.reprojectPendingSubmission()
    expect(projected).toEqual([projected[0]!, projected[0]!])
  })

  test('rolls back managed state when strict persistence fails', () => {
    let state = { revision: 1 }
    expect(() => persistManagedInteractionState(
      () => state,
      value => { state = value },
      { revision: 2 },
      () => { throw new Error('persist-failed') },
    )).toThrow('persist-failed')
    expect(state).toEqual({ revision: 1 })
  })

  test('a Pi plan approval restores the existing mode owner, acceptPlan is gone (F1.259), and manager cleanup disposes AskUser', async () => {
    const manager = createTestSessionManager()
    const managed = {
      id: sessionKey.sessionId,
      workspace: { id: sessionKey.workspaceId },
      permissionMode: 'plan', activeProvider: 'pi', llmConnection: 'pi', // F1.413 — approve_plan refuses a non-Pi session
      messages: [],
    }
    const plan = new PlanModeService({
      sessionKey,
      initialMode: 'plan',
      setMode: async mode => { managed.permissionMode = mode },
      initial: {
        schemaVersion: 1,
        kind: 'awaiting_user',
        revision: 1,
        previousMode: 'default',
        planPath: 'plan.md',
        submissionId: 'stable-plan',
        notificationDispatched: true,
      },
    })
    const waitingAsk = new AskUserService(sessionKey)
    const waiting = waitingAsk.request({ requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false }, () => {})
    await Promise.resolve()
    const key = encodeSessionKey(sessionKey)
    ;(manager as any).sessions.set(key, managed)
    ;(manager as any).piPlanModeServices.set(key, plan)
    ;(manager as any).piAskUserServices.set(key, waitingAsk)
    // F1.259 — `acceptPlan` (callerless outside this test; its non-Pi branch switched explore to bypass) was
    // deleted. F1.413 — the approval now goes through the REAL door, `controlPiHarnessRuntime`'s `approve_plan`.
    expect((manager as any).acceptPlan).toBeUndefined()
    // (No `sendMessage` stub: `PlanModeService.approve` never reaches the manager, so one here could not fail.)
    await manager.controlPiHarnessRuntime({ schemaVersion: 1, session: sessionKey, action: 'approve_plan' })
    expect(managed.permissionMode).toBe('default')
    expect(plan.state()).toMatchObject({ kind: 'inactive', revision: 1 })

    manager.cleanup()
    await expect(waiting).rejects.toThrow('session-manager-cleanup')
  })

  test('clears manager AskUser metadata only after durable timeout settlement', async () => {
    const manager = createTestSessionManager()
    const workspace = {
      id: sessionKey.workspaceId,
      name: 'Interaction tools test',
      rootPath: tmpdir(),
      createdAt: Date.now(),
    }
    const managed = createManagedSession({ id: sessionKey.sessionId }, workspace as never)
    ;(manager as any).sessions.set(encodeSessionKey(sessionKey), managed)
    ;(manager as any).pendingPermissionRequests.set('r1', {
      workspaceId: sessionKey.workspaceId,
      sessionId: sessionKey.sessionId,
      type: 'ask_user',
    })
    const service = new AskUserService(
      sessionKey,
      undefined,
      undefined,
      requestId => (manager as any).clearSettledAskUserPermission(
        sessionKey.sessionId,
        sessionKey.workspaceId,
        requestId,
      ),
    )
    const waiting = service.request({ requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false, timeoutMs: 1 }, () => {})
    await expect(waiting).resolves.toEqual({ type: 'batched', answers: {}, autoContinued: true })
    expect((manager as any).pendingPermissionRequests.has('r1')).toBe(false)
    manager.cleanup()
  })

  test('permission prompts and plan approval never auto-resolve on the question clock', async () => {
    // settings.md scopes askUserQuestionTimeout to AskUserQuestion only;
    // permission prompts (including plan approval) must sit unanswered
    // indefinitely. The ask-user clock below FIRES while both stay pending.
    const manager = createTestSessionManager()
    const managed = {
      id: sessionKey.sessionId,
      workspace: { id: sessionKey.workspaceId },
      permissionMode: 'default',
      messages: [],
    }
    ;(manager as any).sessions.set(encodeSessionKey(sessionKey), managed)
    ;(manager as any).sendEvent = () => {}
    let settled: unknown = null
    const approval = (manager as any).requestPiToolApproval(managed, {
      decisionId: 'perm-clock-1',
      toolName: 'bash',
      type: 'bash',
      description: 'run a command',
      command: 'echo hi',
    }) as Promise<unknown>
    void approval.then(result => { settled = result })

    const plan = new PlanModeService({
      sessionKey,
      initialMode: 'plan',
      previousMode: 'default',
      setMode: async () => {},
      initial: {
        schemaVersion: 1,
        kind: 'awaiting_user',
        revision: 1,
        previousMode: 'default',
        planPath: 'plan.md',
        submissionId: 'clock-plan',
        notificationDispatched: true,
      },
    })

    // The question clock (30ms here) fires and auto-continues the question...
    const ask = new AskUserService({ workspaceId: sessionKey.workspaceId, sessionId: 'clock-ask' })
    await expect(ask.request(
      { requestId: 'rq', question: 'Q?', options: ['a', 'b'], allowFreeText: false, timeoutMs: 30 },
      () => {},
    )).resolves.toMatchObject({ type: 'batched', autoContinued: true })

    // ...while well past that clock the permission prompt and the plan
    // approval are still waiting for a human.
    await new Promise(resolve => setTimeout(resolve, 90))
    expect(settled).toBeNull()
    expect((manager as any).pendingPermissionRequests.has('perm-clock-1')).toBe(true)
    expect(plan.state()).toMatchObject({ kind: 'awaiting_user', submissionId: 'clock-plan' })

    const resolver = (manager as any).directPermissionResolvers.get('perm-clock-1')
    ;(manager as any).directPermissionResolvers.delete('perm-clock-1')
    resolver.resolve(false)
    await approval
    manager.cleanup()
  })

  test('resumes a stable persisted plan projection after a later lifecycle failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-plan-projection-'))
    try {
      const planPath = join(root, 'plan.md')
      await writeFile(planPath, '# Plan')
      const manager = createTestSessionManager()
      const events: Array<{ type: string; message?: { id: string } }> = []
      let failComplete = true
      ;(manager as any).sendEvent = (event: { type: string; message?: { id: string } }) => {
        events.push(event)
        if (event.type === 'complete' && failComplete) {
          failComplete = false
          throw new Error('complete-event-failed')
        }
      }
      let persistCalls = 0
      ;(manager as any).persistSession = () => { persistCalls += 1 }
      const managed = {
        id: sessionKey.sessionId,
        workspace: { id: sessionKey.workspaceId },
        messages: [], messageQueue: [], // F1.346 — the handoff reads the queue; a real session always has one
        piPlanProjectionId: 'stable-plan',
        isProcessing: true,
        agent: { interruptForHandoff: () => {} },
      }
      await expect((manager as any).projectPiPlanSubmission(managed, planPath)).rejects.toThrow('complete-event-failed')
      await (manager as any).projectPiPlanSubmission(managed, planPath)
      expect(managed.messages.map((message: { id: string }) => message.id)).toEqual(['stable-plan'])
      expect(events.filter(event => event.type === 'plan_submitted').map(event => event.message?.id)).toEqual(['stable-plan', 'stable-plan'])
      expect(managed.isProcessing).toBe(false)
      expect(persistCalls).toBe(1)

      const adjacent = {
        id: 'adjacent-session',
        workspace: { id: sessionKey.workspaceId },
        messages: [], messageQueue: [], // F1.346 — as above
        isProcessing: true,
        agent: { interruptForHandoff: () => {} },
      }
      await (manager as any).projectPiPlanSubmission(adjacent, planPath)
      expect(adjacent.messages).toHaveLength(1)
      expect(adjacent.isProcessing).toBe(false)
      expect(persistCalls).toBe(2)
      manager.cleanup()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('F1.413 — NEGATIVE: approve_plan on a Pi session with no plan service refuses by name, and a non-Pi session is refused first', async () => {
    const manager = createTestSessionManager()
    const managed: Record<string, unknown> = {
      id: sessionKey.sessionId,
      workspace: { id: sessionKey.workspaceId },
      permissionMode: 'plan', activeProvider: 'pi', llmConnection: 'pi',
      messages: [],
    }
    ;(manager as any).sessions.set(encodeSessionKey(sessionKey), managed)
    await expect(manager.controlPiHarnessRuntime({ schemaVersion: 1, session: sessionKey, action: 'approve_plan' }))
      .rejects.toThrow('pi-plan-service-unavailable')
    expect(managed.permissionMode).toBe('plan')
    // F1.415's control: no server-side plan approval exists for a claude or codex session.
    // (Planted: the provider resolver answers 'anthropic', the way a claude session's connection resolves; a test
    // connection slug would fall back to the default provider, which is Pi.)
    managed.activeProvider = 'anthropic'
    ;(manager as any).resolveManagedProvider = () => 'anthropic'
    await expect(manager.controlPiHarnessRuntime({ schemaVersion: 1, session: sessionKey, action: 'approve_plan' }))
      .rejects.toThrow('pi-runtime-provider-required')
    expect(managed.permissionMode).toBe('plan')
    manager.cleanup()
  })
})
