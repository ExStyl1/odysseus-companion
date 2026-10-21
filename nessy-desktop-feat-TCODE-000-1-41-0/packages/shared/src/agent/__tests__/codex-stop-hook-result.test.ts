/**
 * P6.11 — "codex fires four hook events of eleven and DISCARDS THE STOP
 * RESULT." This suite is the second half: the discard.
 *
 * `emitStopHookOnce` ended in `.then(() => undefined)`. A Stop hook's
 * `decision: block` and its `reason` were therefore received and thrown away on
 * this runtime, and `stop_hook_active` — the field hooks.md tells authors to
 * check "to prevent a condition that will never resolve" — was never sent at
 * all. Both halves of the documented channel were closed, and the failure was
 * invisible: the hook ran, exited, and nothing anywhere recorded that its answer
 * went nowhere.
 *
 * Pi routes the same result into `BaseAgent.recordHookBlockFeedback` and drains
 * the queue onto the next turn's user tail. Codex now does the same, through the
 * same shared implementation rather than a second one.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentEvent as AutomationAgentEvent, SdkAutomationInput } from '../../automations/types.ts';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
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
    model: 'codex/test-model',
    isHeadless: true,
  };
}

async function drain(agent: CodexAgent, prompt: string): Promise<void> {
  for await (const _event of (agent as any).chatImpl(prompt)) { /* drain */ }
}

/** A codex agent whose runtime is a stub that completes every turn at once. */
function stubRuntime(agent: CodexAgent, turns: Array<{ method: string; params: any }>): void {
  (agent as any).ensureRuntime = async () => {
    (agent as any).client = {
      request(method: string, params: any) {
        turns.push({ method, params });
        if (method === 'turn/start') queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
        return Promise.resolve({ thread: { id: 'thread-1' } });
      },
      notify() {},
      close() {},
    };
    (agent as any).threadId = 'thread-1';
  };
}

describe('codex Stop hook result', () => {
  it("a blocking Stop hook's reason reaches the next turn instead of being discarded", async () => {
    const agent = new CodexAgent(createConfig());
    const turns: Array<{ method: string; params: any }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event) {
        if (event === 'Stop') {
          return { matchedCount: 1, decision: { decision: 'block', reason: 'the changelog is still unwritten' } };
        }
        return { matchedCount: 1 };
      },
    });
    stubRuntime(agent, turns);

    await drain(agent, 'first');
    await drain(agent, 'second');

    const starts = turns.filter(entry => entry.method === 'turn/start');
    const secondTurn = String(starts[1]?.params.input[0].text);
    expect(secondTurn).toContain('<hook_feedback event="Stop">');
    expect(secondTurn).toContain('the changelog is still unwritten');
    // Fenced, unlike Pi's raw compose: the body is a hook's stdout, and this
    // file's own P2.59 note records that composing such a body raw into a host
    // band is a live defect.
    expect(secondTurn).toContain('<untrusted source="hook_feedback">');
    // It rides the tail, ahead of the user's own text and never behind it.
    expect(secondTurn.indexOf('the changelog is still unwritten')).toBeLessThan(secondTurn.lastIndexOf('second'));

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('a non-blocking Stop hook adds nothing to the next turn', async () => {
    // The negative: only a BLOCK feeds a reason back. A Stop hook that simply
    // ran must leave the next prompt byte-identical to an unhooked one.
    const agent = new CodexAgent(createConfig());
    const turns: Array<{ method: string; params: any }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent() { return { matchedCount: 1 } },
    });
    stubRuntime(agent, turns);

    await drain(agent, 'first');
    await drain(agent, 'second');

    const starts = turns.filter(entry => entry.method === 'turn/start');
    expect(String(starts[1]?.params.input[0].text)).not.toContain('hook_feedback');

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('the queued reason is one-shot: it does not ride a third turn as well', async () => {
    const agent = new CodexAgent(createConfig());
    const turns: Array<{ method: string; params: any }> = [];
    let blocks = 0;
    agent.setAutomationSystem({
      async executeAgentEvent(event) {
        if (event === 'Stop' && blocks++ === 0) {
          return { matchedCount: 1, decision: { decision: 'block', reason: 'say it once' } };
        }
        return { matchedCount: 1 };
      },
    });
    stubRuntime(agent, turns);

    await drain(agent, 'first');
    await drain(agent, 'second');
    await drain(agent, 'third');

    const starts = turns.filter(entry => entry.method === 'turn/start');
    expect(String(starts[1]?.params.input[0].text)).toContain('say it once');
    expect(String(starts[2]?.params.input[0].text)).not.toContain('say it once');

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('stop_hook_active reports the streak the block cap counts, not a second flag', async () => {
    // hooks.md:2190 pairs the field with the consecutive-block override in one
    // sentence, so it must read the SAME counter `recordHookBlockFeedback`
    // maintains — a flag sourced elsewhere could say `false` while the cap was
    // already counting down.
    const agent = new CodexAgent(createConfig());
    const turns: Array<{ method: string; params: any }> = [];
    const stops: SdkAutomationInput[] = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event: AutomationAgentEvent, input: SdkAutomationInput) {
        if (event !== 'Stop') return { matchedCount: 1 };
        stops.push(input);
        return { matchedCount: 1, decision: { decision: 'block', reason: `pass ${stops.length}` } };
      },
    });
    stubRuntime(agent, turns);

    await drain(agent, 'first');
    await drain(agent, 'second');

    // The first Stop of the session cannot be "already continuing from a stop
    // hook"; the second follows a block, so it is.
    expect(stops[0]?.stop_hook_active).toBe(false);
    expect(stops[1]?.stop_hook_active).toBe(true);

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });
});
