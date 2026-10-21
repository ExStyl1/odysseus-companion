/**
 * PiAgent lifecycle hook events.
 *
 * ## THIS RIG CANNOT DRAIN A TURN — read this before writing a case here
 *
 * D1.259. Every rig in this file builds a bare `new PiAgent(createConfig())`
 * with no capability runtime behind it, and `chatImpl` refuses before it yields
 * anything a case could assert on. Measured 2026-09-18 at HEAD `08cdbeabf`, by
 * draining `chatImpl('hello')` on this file's own config:
 *
 * - with `ensureSubprocess` stubbed (the shape the D1.238 cases use):
 *   `[{ type: 'error', message: 'Pi execution manifest requires an active
 *   capability turn' }, { type: 'complete' }]`
 * - without that stub, a DIFFERENT guard fires first and the turn still ends:
 *   `[{ type: 'error', message: 'Pi capability runtime manifest is required
 *   before subprocess spawn' }, { type: 'complete' }]`
 *
 * Two guards, one outcome: `error` then `complete`, with nothing from the turn
 * in between.
 *
 * **Why that is a trap and not a limitation.** A case asserting on the events
 * `chatImpl` YIELDS passes VACUOUSLY in its negative arm — the stream carries
 * two events whatever the code under test does — and is unfixable in its
 * positive one. D1.238's first draft was exactly that, and the only reason it
 * was caught is that somebody drained the stream by hand and read it.
 *
 * **What to do instead.** Assert on a channel the rig really drives: the hook
 * ledger, `_sessionHookContext`, or an intercepted `eventQueue.enqueue` with
 * its ordering (`EventQueue.drain()` breaks out once `complete()` has been
 * signalled, so a notice enqueued after it vanishes without a trace). The
 * `noticeRig` below does the last of those and the D1.238 describe explains the
 * choice at length.
 *
 * **Or give the rig a real capability turn** — which is the other half of
 * D1.259 and is deliberately NOT done here: it changes what the ~20 existing
 * cases exercise, and that is a decision about this file's subject rather than
 * a repair. Stating the limit costs nothing and removes the vacuous-arm trap
 * today; converting the rig is a row of its own.
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { AgentEvent as AutomationAgentEvent, SdkAutomationInput } from '../../automations/types.ts';
import type { AgentEvent } from '@nessy-agent/core/types';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'pi/test-model',
    isHeadless: true,
  };
}

function collectAutomationEvents(agent: PiAgent): Array<{ event: AutomationAgentEvent; input: SdkAutomationInput }> {
  const events: Array<{ event: AutomationAgentEvent; input: SdkAutomationInput }> = [];
  (agent as any).emitAutomationEvent = async (event: AutomationAgentEvent, input: SdkAutomationInput) => {
    events.push({ event, input });
  };
  return events;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PiAgent lifecycle hook events', () => {
  it('emits one continuation boundary for success, failure and cancellation', async () => {
    const phases: string[] = [];
    const agent = new PiAgent({
      ...createConfig(),
      onPiContinuationBoundary: (phase) => { phases.push(phase); },
    });
    (agent as any).activeExecutionManifest = { snapshotGeneration: 'generation-1' };
    (agent as any).handleSubprocessEvent({ type: 'compaction_start' });
    (agent as any).handleSubprocessEvent({ type: 'compaction_start' });
    (agent as any).handleSubprocessEvent({ type: 'compaction_end', result: { ok: true }, aborted: false });
    (agent as any).handleSubprocessEvent({ type: 'compaction_start' });
    (agent as any).handleSubprocessEvent({ type: 'compaction_end', errorMessage: 'failed' });
    (agent as any).handleSubprocessEvent({ type: 'compaction_start' });
    (agent as any).send = () => {};
    await agent.abort('cancel');
    expect(phases).toEqual(['pre', 'post', 'pre', 'failed', 'pre', 'cancelled']);
    agent.destroy();
  });

  it('forwards subprocess automation_event messages', () => {
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);

    (agent as any).handleLine(JSON.stringify({
      type: 'automation_event',
      event: 'SubagentStart',
      input: {
        hook_event_name: 'SubagentStart',
        agent_id: 'subagent-1',
        agent_type: 'scout',
      },
    }));

    expect(events).toEqual([{
      event: 'SubagentStart',
      input: {
        hook_event_name: 'SubagentStart',
        agent_id: 'subagent-1',
        agent_type: 'scout',
      },
    }]);

    agent.destroy();
  });

  it('accepts PreCompact only from the extension lifecycle bridge', () => {
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);

    (agent as any).handleSubprocessEvent({ type: 'compaction_start' });
    expect(events.filter(entry => entry.event === 'PreCompact')).toHaveLength(0);
    (agent as any).handleLine(JSON.stringify({
      type: 'automation_event',
      event: 'PreCompact',
      input: { hook_event_name: 'PreCompact', source: 'compact' },
    }));
    expect(events.filter(entry => entry.event === 'PreCompact')).toHaveLength(1);

    agent.destroy();
  });

  it('applies SessionStart context once and keeps SessionEnd solely on teardown', async () => {
    const agent = new PiAgent(createConfig());
    const events: Array<{ event: AutomationAgentEvent; input: SdkAutomationInput }> = [];
    (agent as any).emitAutomationEvent = async (event: AutomationAgentEvent, input: SdkAutomationInput) => {
      events.push({ event, input });
      return event === 'SessionStart'
        ? { matchedCount: 1, decision: { additionalContext: 'Honey session directive' } }
        : { matchedCount: 0 };
    };

    (agent as any).ensureSubprocess = async () => {};
    (agent as any).send = (message: Record<string, unknown>) => {
      if (message.type === 'prompt') {
        (agent as any).eventQueue.complete();
      }
    };

    (agent as any).handleLine(JSON.stringify({
      type: 'automation_event',
      event: 'SessionStart',
      input: { hook_event_name: 'SessionStart', source: 'startup' },
    }));

    for await (const _ of (agent as any).chatImpl('hello')) { /* drain */ }
    for await (const _ of (agent as any).chatImpl('again')) { /* drain */ }

    // SessionStart fires once for the session, not once per prompt.
    expect(events.filter(entry => entry.event === 'SessionStart')).toHaveLength(1);
    // SessionEnd must NOT fire per turn — only on real teardown.
    expect(events.filter(entry => entry.event === 'SessionEnd')).toHaveLength(0);
    expect(events.find(entry => entry.event === 'SessionStart')?.input).toMatchObject({
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect((agent as any)._sessionHookContext).toBe('Honey session directive');

    await agent.endLifecycle();
    agent.destroy();

    // Real teardown fires SessionEnd once; destroy cannot duplicate it.
    expect(events.filter(entry => entry.event === 'SessionEnd')).toHaveLength(1);
  });

  it('orders Notification and Stop before exact-once SessionEnd', async () => {
    const agent = new PiAgent(createConfig());
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    agent.setAutomationSystem({
      async executeAgentEvent(event) {
        order.push(`start:${event}`);
        if (event === 'Notification') await gate;
        order.push(`end:${event}`);
        return { matchedCount: 1 };
      },
    });
    (agent as any)._sessionStartEmitted = true;
    (agent as any)._sessionStartHooksApplied = true;
    (agent as any).send = () => {};

    (agent as any).emitNotificationHook('permission_prompt', 'Response requested', 'Choose');
    await agent.abort('user_stop');
    const ending = agent.endLifecycle();
    await Bun.sleep(0);
    expect(order).toEqual(['start:Notification']);

    release();
    await ending;
    await agent.endLifecycle();
    expect(order).toEqual([
      'start:Notification', 'end:Notification',
      'start:Stop', 'end:Stop',
      'start:SessionEnd', 'end:SessionEnd',
    ]);
    agent.destroy();
  });

  /**
   * D1.238 — the OTHER half of the same hook result.
   *
   * The case above pins that `additionalContext` reaches the MODEL. Measured at
   * HEAD before this was written, `systemMessage` — the same result's
   * user-facing half, which `hooks.md#json-output` defines as *"Warning message
   * shown to the user"* — occurred ZERO times in `pi-agent.ts`, against 11 in
   * `codex-agent.ts` and 7 in `claude-agent.ts`. So a hook was being RUN with
   * half its output discarded, on the one runtime with no channel for it.
   *
   * ## The rig is `pi-worker-shutdown-notice.test.ts`'s, and the reason is a
   * measurement rather than a preference
   *
   * The first draft asserted on the events `chatImpl` YIELDS, which is the
   * shape the question deserves — and this file's rig cannot reach that path:
   * probed here, a drained `chatImpl('hello')` answers
   * `[{ type: 'error', message: 'Pi execution manifest requires an active
   * capability turn' }, { type: 'complete' }]`, so the turn ends before any
   * queued notice is drained. The case above never noticed because it asserts
   * only on the hook ledger and on `_sessionHookContext`, and a stream
   * assertion written on this rig would have passed vacuously in its NEGATIVE
   * arm and been unfixable in its positive one.
   *
   * So the assertion is the one the sibling notice on this same queue already
   * uses: intercept `eventQueue.enqueue`, and assert the notice was enqueued
   * BEFORE the queue closed. That second half is not decoration —
   * `EventQueue.drain()` breaks out once `complete()` has been signalled, so a
   * notice enqueued after it vanishes without a trace.
   */
  function noticeRig(): { agent: PiAgent; queued: AgentEvent[]; completedBeforeEnqueue: boolean[] } {
    const agent = new PiAgent(createConfig());
    const queued: AgentEvent[] = [];
    const completedBeforeEnqueue: boolean[] = [];
    (agent as any).send = () => {};
    (agent as any).debug = () => {};
    const eventQueue = (agent as any).eventQueue;
    const enqueue = eventQueue.enqueue.bind(eventQueue);
    eventQueue.enqueue = (event: AgentEvent) => {
      queued.push(event);
      completedBeforeEnqueue.push(eventQueue.isComplete === true);
      enqueue(event);
    };
    return { agent, queued, completedBeforeEnqueue };
  }

  function infoNotices(queued: AgentEvent[]): Array<Extract<AgentEvent, { type: 'info' }>> {
    return queued.filter((event): event is Extract<AgentEvent, { type: 'info' }> => event.type === 'info');
  }

  it('D1.238 — a post-compaction SessionStart hook\'s systemMessage reaches the user', async () => {
    const rig = noticeRig();
    (rig.agent as any).emitAutomationEvent = async () => ({
      matchedCount: 1,
      universal: { systemMessage: '  the corp proxy is down; expect slow tools  ' },
      decision: { additionalContext: 'Honey session directive' },
    });

    await (rig.agent as any).emitPostCompactSessionStart();
    rig.agent.destroy();

    const notices = infoNotices(rig.queued);
    expect(notices).toHaveLength(1);
    // The prefix is codex's `surfaceHookUserFacingOutput` and claude's D1.216,
    // character for character, so one user switching runtimes meets one
    // sentence; the value is trimmed as both of those trim it.
    expect(notices[0]!.message).toBe('SessionStart hook: the corp proxy is down; expect slow tools');
    expect(notices[0]!.level).toBe('warning');
    expect(rig.completedBeforeEnqueue).toEqual([false]);
  });

  it('D1.238 — the control: a result with no systemMessage adds no notice', async () => {
    // Non-vacuity. Same rig, same path, the same `additionalContext` still
    // reaching the model — only the user-facing field differs, so a helper that
    // queued unconditionally fails here, and so does one that queued the
    // additionalContext by mistake.
    const rig = noticeRig();
    (rig.agent as any).emitAutomationEvent = async () => ({
      matchedCount: 1,
      decision: { additionalContext: 'Honey session directive' },
    });

    await (rig.agent as any).emitPostCompactSessionStart();
    rig.agent.destroy();

    expect(infoNotices(rig.queued)).toEqual([]);
  });

  it('D1.238 — the OTHER emit site: the startup capture in chatImpl enqueues it too', async () => {
    // Both `SessionStart` sites go through the one helper, and a fix applied to
    // only the post-compaction path would leave the ordinary startup hook — the
    // common case — still silent. This rig cannot drain the turn (see the
    // docblock), so the assertion is the enqueue and its ordering.
    const rig = noticeRig();
    (rig.agent as any).emitAutomationEvent = async (event: AutomationAgentEvent) => (
      event === 'SessionStart'
        ? { matchedCount: 1, universal: { systemMessage: 'startup hook spoke' } }
        : { matchedCount: 0 }
    );
    (rig.agent as any).ensureSubprocess = async () => {};
    (rig.agent as any).handleLine(JSON.stringify({
      type: 'automation_event',
      event: 'SessionStart',
      input: { hook_event_name: 'SessionStart', source: 'startup' },
    }));

    for await (const _ of (rig.agent as any).chatImpl('hello')) { /* drain */ }
    rig.agent.destroy();

    const notices = infoNotices(rig.queued);
    expect(notices.map(notice => notice.message)).toContain('SessionStart hook: startup hook spoke');
  });

  it('treats clearHistory as ordered SessionEnd then next SessionStart', async () => {
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);
    (agent as any)._sessionStartEmitted = true;
    (agent as any)._sessionStartHooksApplied = true;

    await agent.clearHistory();
    (agent as any).ensureSubprocess = async () => {};
    (agent as any).send = (message: Record<string, unknown>) => {
      if (message.type === 'prompt') (agent as any).eventQueue.complete();
    };
    for await (const _ of (agent as any).chatImpl('after clear')) { /* drain */ }

    expect(events.filter(entry => entry.event === 'SessionEnd' || entry.event === 'SessionStart').map(entry => entry.event)).toEqual([
      'SessionEnd',
      'SessionStart',
    ]);
    await agent.endLifecycle();
    agent.destroy();
  });

  it('transfers lifecycle state across runtime replacement without a false boundary', async () => {
    const oldAgent = new PiAgent(createConfig());
    const oldEvents = collectAutomationEvents(oldAgent);
    (oldAgent as any)._sessionStartEmitted = true;
    (oldAgent as any)._sessionStartHooksApplied = true;
    (oldAgent as any)._sessionHookContext = 'pinned context';
    const state = oldAgent.captureLifecycleState();

    await oldAgent.disposeForRestart();
    expect(oldEvents.filter(entry => entry.event === 'SessionEnd')).toHaveLength(0);

    const replacement = new PiAgent(createConfig());
    const replacementEvents = collectAutomationEvents(replacement);
    replacement.restoreLifecycleState(state);
    expect((replacement as any)._sessionHookContext).toBe('pinned context');
    await replacement.endLifecycle();
    expect(replacementEvents.map(entry => entry.event)).toEqual(['SessionEnd']);
    replacement.destroy();
  });

  it('round-trips PostToolUse output replacement before Pi commits the result', async () => {
    const agent = new PiAgent(createConfig());
    const events: Array<{ event: AutomationAgentEvent; input: SdkAutomationInput }> = [];
    const sent: Record<string, unknown>[] = [];
    (agent as any).emitAutomationEvent = async (event: AutomationAgentEvent, input: SdkAutomationInput) => {
      events.push({ event, input });
      return { matchedCount: 1, decision: { updatedToolOutput: 'compressed output' } };
    };
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };

    (agent as any).handleLine(JSON.stringify({
      type: 'post_tool_use_request',
      requestId: 'post-1',
      toolName: 'Bash',
      input: { command: 'verbose' },
      toolResponse: 'long output',
      isError: false,
    }));
    await flushMicrotasks();

    expect(events).toEqual([{
      event: 'PostToolUse',
      input: {
        hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'verbose' }, tool_response: 'long output',
      },
    }]);
    expect(sent).toContainEqual({
      type: 'post_tool_use_response', requestId: 'post-1', updatedToolOutput: 'compressed output',
    });
    agent.destroy();
  });

  it('round-trips a PreCompact block back to the waiting compaction, and allows otherwise', async () => {
    // R73 · hooks.md#precompact — the exit-code table row is "`PreCompact` | Yes
    // | Blocks compaction", and § Decision control lists it among the top-level
    // `decision` events. Before this round trip the parsed decision was
    // discarded at the `automation_event` dispatch and Pi compacted anyway.
    const drive = async (result: Record<string, unknown>) => {
      const agent = new PiAgent(createConfig());
      const events: Array<{ event: AutomationAgentEvent; input: SdkAutomationInput }> = [];
      const sent: Record<string, unknown>[] = [];
      (agent as any).emitAutomationEvent = async (event: AutomationAgentEvent, input: SdkAutomationInput) => {
        events.push({ event, input });
        return result;
      };
      (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
      (agent as any).handleLine(JSON.stringify({
        type: 'pre_compact_request',
        requestId: 'precompact-1',
        trigger: 'manual',
        source: 'manual',
        customInstructions: 'keep the plan',
      }));
      await flushMicrotasks();
      agent.destroy();
      return { events, sent };
    };

    const blocked = await drive({
      matchedCount: 1,
      decision: { decision: 'block', reason: 'plan mid-execution' },
    });
    // hooks.md#precompact input: "PreCompact hooks receive `trigger` and
    // `custom_instructions`."
    expect(blocked.events).toEqual([{
      event: 'PreCompact',
      input: {
        hook_event_name: 'PreCompact',
        trigger: 'manual',
        custom_instructions: 'keep the plan',
        source: 'manual',
      },
    }]);
    expect(blocked.sent).toContainEqual({
      type: 'pre_compact_response', requestId: 'precompact-1', block: true, reason: 'plan mid-execution',
    });

    // The negative: a non-blocking hook still gets an answer, or the subprocess
    // would wait forever on a compaction nobody objected to.
    const allowed = await drive({ matchedCount: 1, decision: { additionalContext: 'noted' } });
    expect(allowed.sent).toContainEqual({ type: 'pre_compact_response', requestId: 'precompact-1' });
  });

  it('does not synthesize Notification or a second UI approval for PreToolUse', async () => {
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);
    const permissionRequests: any[] = [];

    agent.setPermissionMode('default');
    (agent as any).send = () => {};
    agent.onPermissionRequest = request => {
      permissionRequests.push(request);
    };

    (agent as any).handleLine(JSON.stringify({
      type: 'pre_tool_use_request',
      requestId: 'pre-tool-1',
      toolName: 'Bash',
      input: { command: 'npm install left-pad' },
    }));
    await flushMicrotasks();

    expect(permissionRequests).toHaveLength(0);
    expect(events.filter(entry => entry.event === 'Notification')).toHaveLength(0);
    agent.destroy();
  });

  it('emits Notification when ask_user waits for a response', async () => {
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);
    const permissionRequests: any[] = [];

    (agent as any).send = () => {};
    agent.onPermissionRequest = request => {
      permissionRequests.push(request);
    };

    (agent as any).handleLine(JSON.stringify({
      type: 'ask_user_request',
      requestId: 'ask-1',
      question: 'Continue deployment?',
      options: ['Yes', 'No'],
      allowFreeText: false,
    }));
    await flushMicrotasks();

    expect(permissionRequests).toHaveLength(1);
    expect(events).toContainEqual({
      event: 'Notification',
      input: {
        hook_event_name: 'Notification',
        // hooks.md#notification: the matcher reads `notification_type`, not the
        // free-text message. `ask_user` reaches the human through the
        // permission-request channel and opens the same blocking approval card,
        // so it is the documented `permission_prompt`.
        notification_type: 'permission_prompt',
        title: 'Response requested',
        message: 'Continue deployment?',
      },
    });

    agent.respondToPermission(permissionRequests[0].requestId, true, false, {
      askUserAnswer: { type: 'option', value: 'Yes', optionIndex: 0 },
    });
    await flushMicrotasks();
    agent.destroy();
  });

  it('emits Stop when a Pi turn is aborted', async () => {
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);
    (agent as any).send = () => {};

    await agent.abort('user_stop');
    await flushMicrotasks();

    // No `hookTaskRegistryPort` on this config, which is hooks.md `:2194`'s
    // "the task registry is [not] reachable" — the only case where the arrays
    // are absent rather than empty. `last_assistant_message` is absent for the
    // same kind of reason (`:2192`): this turn produced no assistant text.
    expect(events).toContainEqual({
      event: 'Stop',
      input: {
        hook_event_name: 'Stop',
        stop_hook_active: false,
      },
    });

    agent.destroy();
  });

  it('carries background_tasks and session_crons as PRESENT EMPTY arrays when nothing is in flight', async () => {
    // hooks.md `:2194` — "Both arrays are present when the task registry is
    // reachable and are empty when nothing is in flight or scheduled." A hook
    // distinguishing "session is done" from "session is paused waiting for
    // background work" reads a MISSING key as neither, so an "only include when
    // non-empty" implementation fails exactly here.
    const agent = new PiAgent({
      ...createConfig(),
      hookTaskRegistryPort: { backgroundTasks: () => [], sessionCrons: () => [] },
    });
    const events = collectAutomationEvents(agent);
    (agent as any).send = () => {};

    await agent.abort('user_stop');
    await flushMicrotasks();

    const stop = events.find(entry => entry.event === 'Stop');
    expect(stop?.input).toEqual({
      hook_event_name: 'Stop',
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    });
    expect(Object.keys(stop?.input ?? {})).toContain('background_tasks');
    expect(Object.keys(stop?.input ?? {})).toContain('session_crons');

    agent.destroy();
  });

  it('carries the registry entries verbatim, including an unrecognized raw type', async () => {
    const backgroundTasks = [
      { id: 'monitor_1', type: 'monitor' as const, status: 'running' as const, description: 'tail logs', server: 'example.test', tool: 'ws' },
      { id: 'child_1', type: 'subagent' as const, status: 'running' as const, description: 'audit the diff', agent_type: 'Explore' },
      // `:2201` — an unrecognized discriminant survives as itself rather than
      // being dropped or forced into a documented label.
      { id: 'odd_1', type: 'quantum_evaluator', status: 'running' as const, description: 'unknown producer' },
    ];
    const sessionCrons = [
      // `:2216` — `false` for a one-shot, `true` for a task that re-fires.
      { id: 'abcd1234', schedule: '0 9 * * 1-5', recurring: true, prompt: 'check the build' },
      { id: 'efgh5678', schedule: '30 14 3 8 *', recurring: false, prompt: 'ship the release' },
    ];
    const agent = new PiAgent({
      ...createConfig(),
      hookTaskRegistryPort: { backgroundTasks: () => backgroundTasks, sessionCrons: () => sessionCrons },
    });
    const events = collectAutomationEvents(agent);
    (agent as any).send = () => {};

    await agent.abort('user_stop');
    await flushMicrotasks();

    const stop = events.find(entry => entry.event === 'Stop');
    expect(stop?.input.background_tasks).toEqual(backgroundTasks);
    expect(stop?.input.session_crons).toEqual(sessionCrons);
    expect(stop?.input.session_crons?.map(cron => cron.recurring)).toEqual([true, false]);

    agent.destroy();
  });

  it('reports the completed turn text as last_assistant_message, not the transcript', async () => {
    // hooks.md `:2192` — "use this field rather than reading `transcript_path`:
    // the transcript file isn't guaranteed to include the final message at Stop
    // time on all versions." So it comes off the completed assistant message.
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);
    (agent as any).send = () => {};

    (agent as any).handleSubprocessEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Refactoring ' }, { type: 'toolCall' }, { type: 'text', text: 'done.' }] },
    });
    await agent.abort('user_stop');
    await flushMicrotasks();

    expect(events.find(entry => entry.event === 'Stop')?.input.last_assistant_message)
      .toBe('Refactoring done.');

    agent.destroy();
  });

  it('reports the LAST assistant message when a turn produced several', async () => {
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);
    (agent as any).send = () => {};

    (agent as any).handleSubprocessEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first pass' }] },
    });
    (agent as any).handleSubprocessEvent({
      type: 'message_end',
      // A user message in between must not become the "assistant" message.
      message: { role: 'user', content: [{ type: 'text', text: 'not this' }] },
    });
    (agent as any).handleSubprocessEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
    });
    await agent.abort('user_stop');
    await flushMicrotasks();

    expect(events.find(entry => entry.event === 'Stop')?.input.last_assistant_message)
      .toBe('final answer');

    agent.destroy();
  });

  it('sets stop_hook_active once a Stop hook has blocked, and clears it when one does not', async () => {
    // `:2190` — "`true` when Claude Code is already continuing as a result of a
    // stop hook". A block is what puts the hook's reason on the next turn, so a
    // live block streak means this turn was entered carrying that instruction.
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);
    (agent as any).send = () => {};
    const internals = agent as any;

    await agent.abort('user_stop');
    await flushMicrotasks();
    expect(events.at(-1)?.input.stop_hook_active).toBe(false);

    internals.recordHookBlockFeedback('Stop', {
      matchedCount: 1, decision: { decision: 'block', reason: 'run the tests first' },
    });
    internals.stopHookEmittedForTurn = false;
    await agent.abort('user_stop');
    await flushMicrotasks();
    expect(events.at(-1)?.input.stop_hook_active).toBe(true);

    // The flag is read from the SAME streak the 8-block override counts down,
    // so a non-blocking Stop result clears both together and the two can never
    // disagree about whether a continuation is in progress.
    internals.recordHookBlockFeedback('Stop', { matchedCount: 1 });
    internals.stopHookEmittedForTurn = false;
    await agent.abort('user_stop');
    await flushMicrotasks();
    expect(events.at(-1)?.input.stop_hook_active).toBe(false);

    agent.destroy();
  });

  it('merges centralized and hook decisions monotonically and revalidates rewrites', () => {
    const agent = new PiAgent(createConfig());

    // A hook rewrite becomes a modify AND is surfaced so the caller can re-run
    // the deny-path gate on the rewritten input.
    const rewrite = (agent as any).applyPreToolUseHookDecision(
      { type: 'allow' },
      { updatedInput: { command: 'echo hi > secrets/.env' } },
      'Bash',
    );
    expect(rewrite.result).toEqual({ type: 'modify', input: { command: 'echo hi > secrets/.env' } });
    expect(rewrite.hookUpdatedInput).toEqual({ command: 'echo hi > secrets/.env' });

    const centralPrompt = {
      type: 'prompt',
      promptType: 'bash',
      description: 'central approval',
    };
    // This overlay is NOT where a hook `allow` is resolved. It carries the
    // prompt forward intact because the documented exceptions to
    // "`allow` skips the permission prompt" (hooks.md#pretooluse — tools that
    // require user interaction, org `ask`, and the deny/ask rules that are
    // "still evaluated regardless of what the hook returns") are not computed
    // until the R15 band. The assertion below therefore pins DEFERRAL, not
    // refusal: it used to be read as "a hook allow can never clear a prompt",
    // which is the wrong contract. `PiAgent PreToolUse hook allow` in
    // pi-agent-pretool-hook-decision.test.ts pins where it does take effect.
    const promptAllow = (agent as any).applyPreToolUseHookDecision(
      centralPrompt,
      { decision: 'allow' },
      'Bash',
    );
    expect(promptAllow.result).toEqual(centralPrompt);

    const safeRewrite = { command: 'echo rewritten' };
    const promptRewrite = (agent as any).applyPreToolUseHookDecision(
      centralPrompt,
      { decision: 'allow', updatedInput: safeRewrite, additionalContext: 'hook context' },
      'Bash',
    );
    expect(promptRewrite.result).toEqual({ ...centralPrompt, modifiedInput: safeRewrite });
    expect(promptRewrite.hookUpdatedInput).toBe(safeRewrite);
    expect(promptRewrite.additionalContext).toBe('hook context');

    // Every centralized block is final; the rewrite is surfaced only for revalidation.
    const deniedBlock = { type: 'block', reason: 'blocked' };
    const overlay = (agent as any).applyPreToolUseHookDecision(
      deniedBlock,
      { decision: 'allow', updatedInput: { file_path: 'secrets/.env' } },
      'Read',
    );
    expect(overlay.result).toBe(deniedBlock);
    expect(overlay.hookUpdatedInput).toEqual({ file_path: 'secrets/.env' });

    const sourceGuard = {
      type: 'source_activation_needed',
      sourceSlug: 'github',
      sourceExists: true,
    };
    const guardedRewrite = (agent as any).applyPreToolUseHookDecision(
      sourceGuard,
      { decision: 'allow', updatedInput: { query: 'rewritten' } },
      'mcp__github__search',
    );
    expect(guardedRewrite.result).toBe(sourceGuard);
    expect(guardedRewrite.hookUpdatedInput).toEqual({ query: 'rewritten' });

    agent.destroy();
  });

  it('projects StopFailure onto the documented error vocabulary and carries details and the rendered error text', async () => {
    // hooks.md:2414 — "StopFailure hooks receive `error`, optional
    // `error_details`, and optional `last_assistant_message`", with `error`
    // bound to a closed ten-value vocabulary (:2418). `error` is a PROJECTION of
    // Nessy's own `ErrorCode`, not a rename of it: `error_code` keeps the raw
    // value beside it so every existing matcher stays byte-identical.
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);
    (agent as any).emitStopFailureHookOnce({
      code: 'rate_limited',
      title: 'Rate Limited',
      message: 'You have hit the provider rate limit.',
      originalError: '429 Too Many Requests',
    });
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('StopFailure');
    expect(events[0]?.input).toEqual({
      hook_event_name: 'StopFailure',
      lifecycle_version: 1,
      error: 'rate_limit',
      error_code: 'rate_limited',
      error_details: '429 Too Many Requests',
      // :2420 — for StopFailure this field is the API error string, NOT the
      // model's conversational output.
      last_assistant_message: 'Rate Limited: You have hit the provider rate limit.',
    });
    agent.destroy();
  });

  it('collapses an undocumented error code to `unknown` and omits the optional fields when nothing is available', async () => {
    // The negative. :2418 gives `error` a CLOSED vocabulary, so a Nessy-only
    // code (`mcp_unreachable`) cannot ride it — a hook switching on `.error`
    // would meet a word its case list cannot contain. The raw code survives on
    // `error_code`, which is also what the matcher reads first, so a
    // Nessy-specific matcher stays reachable.
    const agent = new PiAgent(createConfig());
    const events = collectAutomationEvents(agent);
    (agent as any).emitStopFailureHookOnce({ code: 'mcp_unreachable' });
    await flushMicrotasks();

    expect(events[0]?.input).toEqual({
      hook_event_name: 'StopFailure',
      lifecycle_version: 1,
      error: 'unknown',
      error_code: 'mcp_unreachable',
    });
    // Absent, not empty: `error_details` and `last_assistant_message` are both
    // documented optional.
    expect(events[0]?.input).not.toHaveProperty('error_details');
    expect(events[0]?.input).not.toHaveProperty('last_assistant_message');
    agent.destroy();
  });
});
