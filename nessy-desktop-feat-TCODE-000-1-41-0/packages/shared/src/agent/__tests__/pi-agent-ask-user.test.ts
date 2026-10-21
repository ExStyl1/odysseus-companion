import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { AbortReason, type BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-general-agent-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    skipConfigWatcher: true,
  };
}

function setupAgent(config: BackendConfig = createConfig()): {
  agent: PiAgent;
  sent: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  permissionRequests: any[];
} {
  const agent = new PiAgent(config);
  const sent: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const permissionRequests: any[] = [];

  (agent as any).send = (message: Record<string, unknown>) => {
    sent.push(message);
  };
  (agent as any).subprocess = {};
  (agent as any).emitAutomationEvent = async () => {};
  (agent as any).eventQueue.enqueue = (event: Record<string, unknown>) => {
    events.push(event);
  };
  (agent as any).eventQueue.complete = () => {};
  agent.onPermissionRequest = request => {
    permissionRequests.push(request);
  };

  return { agent, sent, events, permissionRequests };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

function sendAskUserRequest(agent: PiAgent, requestId = 'ask-subprocess-1'): void {
  (agent as any).handleLine(JSON.stringify({
    type: 'ask_user_request',
    requestId,
    question: 'Continue?',
    options: ['Yes', 'No'],
    allowFreeText: false,
    timeoutMs: 300000,
  }));
}

describe('PiAgent ask_user lifecycle', () => {
  it('routes Pi ask_user through the SessionKey-bound host port without a second pending owner', async () => {
    let resolveAnswer!: (answer: any) => void;
    const portCalls: string[] = [];
    const config = createConfig();
    config.isHeadless = false;
    config.askUserPort = {
      request: input => {
        portCalls.push(`request:${input.sessionKey.workspaceId}:${input.sessionKey.sessionId}:${input.requestId}`);
        input.publish(input.requestId, input.askUser);
        return new Promise(resolve => { resolveAnswer = resolve; });
      },
      answer: async input => { portCalls.push(`answer:${input.requestId}`); resolveAnswer(input.answer); },
      cancel: async input => { portCalls.push(`cancel:${input.requestId}`); },
      reproject: () => {},
    };
    const { agent, sent, permissionRequests } = setupAgent(config);

    sendAskUserRequest(agent);
    await flushMicrotasks();
    expect(permissionRequests).toHaveLength(1);
    expect((agent as any).pendingPermissions.size).toBe(0);
    agent.respondToPermission('ask-subprocess-1', true, false, {
      askUserAnswer: { type: 'option', value: 'Yes', optionIndex: 0 },
    });
    await flushMicrotasks();

    expect(portCalls).toEqual([
      'request:ws-test:session-test:ask-subprocess-1',
      'answer:ask-subprocess-1',
    ]);
    expect(sent).toContainEqual({
      type: 'ask_user_response',
      requestId: 'ask-subprocess-1',
      answer: { type: 'option', value: 'Yes', optionIndex: 0 },
    });
    (agent as any).subprocess = null;
    agent.destroy();
  });

  it('refuses ask_user in dontAsk mode instead of publishing a prompt', async () => {
    // `ask_user` reaches the user through the permission-request channel, not
    // runPreToolUseChecks, so the gate's interaction rule cannot see it. In a mode
    // whose promise is "never prompts", the request has to be refused here or the
    // unattended session hangs on a human who is not there.
    // Its own sessionId: mode state is a per-session singleton, so reusing the
    // shared one would leave every later test in this file in dontAsk.
    const config = createConfig();
    (config.session as any).id = 'session-dont-ask';
    const { agent, sent, permissionRequests } = setupAgent(config);
    agent.setPermissionMode('dontAsk');

    sendAskUserRequest(agent);
    await flushMicrotasks();

    expect(permissionRequests).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'ask_user_response', requestId: 'ask-subprocess-1' });
    expect(String((sent[0] as { error?: string }).error)).toContain("Don't ask");
    (agent as any).subprocess = null;
    agent.destroy();
  });

  it('routes subprocess cancellation to the durable host owner', async () => {
    let rejectAnswer!: (error: Error) => void;
    const cancelled: string[] = [];
    const config = createConfig();
    config.isHeadless = false;
    config.askUserPort = {
      request: input => {
        input.publish(input.requestId, input.askUser);
        return new Promise((_resolve, reject) => { rejectAnswer = reject; });
      },
      answer: async () => {},
      cancel: async input => { cancelled.push(input.requestId); rejectAnswer(new Error('cancelled')); },
      reproject: () => {},
    };
    const { agent, sent } = setupAgent(config);
    sendAskUserRequest(agent);
    await flushMicrotasks();
    (agent as any).handleLine(JSON.stringify({ type: 'ask_user_cancel', requestId: 'ask-subprocess-1' }));
    await flushMicrotasks();
    expect(cancelled).toEqual(['ask-subprocess-1']);
    expect(sent).toContainEqual({ type: 'ask_user_response', requestId: 'ask-subprocess-1', error: 'cancelled' });
    (agent as any).subprocess = null;
    agent.destroy();
  });

  it('reports a rejected host terminal operation instead of leaking an unhandled promise', async () => {
    const config = createConfig();
    config.isHeadless = false;
    config.askUserPort = {
      request: async () => ({ type: 'option', value: 'Yes', optionIndex: 0 }),
      answer: async () => { throw new Error('terminal-persist-failed'); },
      cancel: async () => { throw new Error('terminal-persist-failed'); },
      reproject: () => {},
    };
    const { agent } = setupAgent(config);
    const diagnostics: string[] = [];
    (agent as any).debug = (message: string) => { diagnostics.push(message); };
    (agent as any).hostAskUserRequestIds.add('ask-subprocess-1');
    agent.respondToPermission('ask-subprocess-1', false);
    await flushMicrotasks();
    expect(diagnostics).toEqual(['AskUser host terminal failed: terminal-persist-failed']);
    (agent as any).subprocess = null;
    agent.destroy();
  });

  it('clears the pending ask_user permission when the subprocess cancels it', async () => {
    const { agent, sent, events, permissionRequests } = setupAgent();

    sendAskUserRequest(agent);
    expect(permissionRequests).toHaveLength(1);
    expect((agent as any).pendingPermissions.size).toBe(1);

    (agent as any).handleLine(JSON.stringify({
      type: 'ask_user_cancel',
      requestId: 'ask-subprocess-1',
      reason: 'timed_out',
    }));
    await flushMicrotasks();

    expect((agent as any).pendingPermissions.size).toBe(0);
    expect(events).toContainEqual({
      type: 'permission_request_cancelled',
      requestId: permissionRequests[0].requestId,
    });
    expect(sent).toContainEqual({
      type: 'ask_user_response',
      requestId: 'ask-subprocess-1',
      error: 'timed_out',
    });

    (agent as any).subprocess = null;
    agent.destroy();
  });

  it('resolves pending ask_user requests with an aborted error on abort()', async () => {
    const { agent, sent, events, permissionRequests } = setupAgent();

    sendAskUserRequest(agent);
    await agent.abort();
    await flushMicrotasks();

    expect((agent as any).pendingPermissions.size).toBe(0);
    expect(events).toContainEqual({
      type: 'permission_request_cancelled',
      requestId: permissionRequests[0].requestId,
    });
    expect(sent).toContainEqual({
      type: 'ask_user_response',
      requestId: 'ask-subprocess-1',
      error: 'aborted',
    });

    (agent as any).subprocess = null;
    agent.destroy();
  });

  it('resolves pending ask_user requests cleanly on forceAbort(PlanSubmitted)', async () => {
    const { agent, sent, events, permissionRequests } = setupAgent();

    sendAskUserRequest(agent);
    agent.forceAbort(AbortReason.PlanSubmitted);
    await flushMicrotasks();

    expect((agent as any).pendingPermissions.size).toBe(0);
    expect(events).toContainEqual({
      type: 'permission_request_cancelled',
      requestId: permissionRequests[0].requestId,
    });
    expect(sent).toContainEqual({
      type: 'ask_user_response',
      requestId: 'ask-subprocess-1',
      error: 'aborted',
    });
    // F1.1242 (CR-A, final sitting 2026-10-01) — FLIPPED from `not.toContainEqual`: the handoff now aborts the
    // subprocess's run too (as Claude's `interruptForHandoff` interrupts its query). Without it the handed-off run kept
    // going, retried SubmitPlan, and the retry landed in the user's next turn. The question is still answered above.
    expect(sent).toContainEqual({ type: 'abort' });

    (agent as any).subprocess = null;
    agent.destroy();
  });
});
