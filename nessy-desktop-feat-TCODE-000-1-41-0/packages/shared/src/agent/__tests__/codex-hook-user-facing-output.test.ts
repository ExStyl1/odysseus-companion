/**
 * C3.361 — a hook's `systemMessage` and `stopReason` on codex, where both
 * reached no surface at all.
 *
 * MEASURED by R4 on the packaged build (C3.89, HEAD `70d269e46`, 2026-09-12),
 * three arms and two controls, one `UserPromptSubmit` hook per arm:
 *
 *  - `{continue:false, stopReason:"R4STOP-…"}` — claude shows *"Operation
 *    stopped by hook: R4STOP-…"*, codex the generic *"A UserPromptSubmit hook
 *    blocked this prompt."* with the hook's own reason nowhere;
 *  - `{systemMessage:"…"}` with the turn proceeding — rendered in the pane on
 *    claude (`systemMessageInBody: true`), reaching no surface on codex.
 *
 * `hooks.md#json-output` gives both fields to every event: `systemMessage` is a
 * *"Warning message shown to the user."* and `stopReason` the *"Message shown
 * to the user when `continue` is `false`."*
 *
 * ## The shape the stubs return, and why it is the real one
 *
 * `executeAgentEvent` is stubbed, so this file must hand back what the real
 * pipeline hands back. `packages/shared/src/automations/hook-command.ts` symbol
 * `parseHookOutputForEvent` projects `continue: false` onto
 * `decision: 'block'` and deliberately does NOT copy `stopReason` into
 * `reason` — so a hook that stops with `{continue:false, stopReason}` alone
 * produces `{decision: {decision: 'block'}, universal: {continue: false,
 * stopReason}}`, with `decision.reason` EMPTY. That empty `reason` is exactly
 * why the generic sentence used to win.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
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

async function collect(agent: CodexAgent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of (agent as any).chatImpl(prompt)) events.push(event as AgentEvent);
  return events;
}

function warnings(events: AgentEvent[]): string[] {
  return events
    .filter(event => event.type === 'info' && (event as any).level === 'warning')
    .map(event => String((event as any).message));
}

function errors(events: AgentEvent[]): string[] {
  return events.filter(event => event.type === 'error').map(event => String((event as any).message));
}

describe('C3.361 — a codex hook\'s user-facing output', () => {
  it('POSITIVE — a `systemMessage` from a non-blocking UserPromptSubmit hook reaches the turn', async () => {
    const agent = new CodexAgent(createConfig());
    const turns: Array<{ method: string; params: any }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event) {
        if (event === 'UserPromptSubmit') {
          return { matchedCount: 1, universal: { systemMessage: 'the staging database is read-only today' } };
        }
        return { matchedCount: 1 };
      },
    });
    stubRuntime(agent, turns);

    const events = await collect(agent, 'first');

    // The turn PROCEEDED — `systemMessage` is a warning, never a block.
    expect(turns.some(entry => entry.method === 'turn/start')).toBe(true);
    expect(errors(events)).toHaveLength(0);
    const shown = warnings(events);
    expect(shown).toContain('UserPromptSubmit hook: the staging database is read-only today');

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('POSITIVE — a `{continue:false, stopReason}` block names the hook\'s own reason, once', async () => {
    const agent = new CodexAgent(createConfig());
    const turns: Array<{ method: string; params: any }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event) {
        if (event === 'UserPromptSubmit') {
          return {
            matchedCount: 1,
            decision: { decision: 'block' },
            universal: { continue: false, stopReason: 'R4STOP-ALLOWED-E21CE362' },
          };
        }
        return { matchedCount: 1 };
      },
    });
    stubRuntime(agent, turns);

    const events = await collect(agent, 'first');

    // The prompt never reached the model.
    expect(turns.some(entry => entry.method === 'turn/start')).toBe(false);
    // …and the sentence the user meets is the hook's, not the generic one.
    expect(errors(events)).toEqual(['R4STOP-ALLOWED-E21CE362']);
    // ONE stop, ONE sentence: the stop is not ALSO repeated as a warning row.
    expect(warnings(events).join('\n')).not.toContain('R4STOP-ALLOWED-E21CE362');

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('a blocked prompt still carries a `systemMessage`, on its own row', async () => {
    // The two fields are independent: a hook may both stop the prompt and warn
    // about something else. The warning is YIELDED here rather than queued,
    // because this branch returns before the turn sink opens.
    const agent = new CodexAgent(createConfig());
    const turns: Array<{ method: string; params: any }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event) {
        if (event === 'UserPromptSubmit') {
          return {
            matchedCount: 1,
            decision: { decision: 'block', reason: 'no secrets in prompts' },
            universal: { continue: false, stopReason: 'ignored, reason outranks it', systemMessage: 'policy v4 is in force' },
          };
        }
        return { matchedCount: 1 };
      },
    });
    stubRuntime(agent, turns);

    const events = await collect(agent, 'first');

    // BOUNDARY — `decision.reason` outranks `stopReason`, which is the page's
    // own ordering (`hooks.md#posttoolbatch-decision-control`: "The blocking
    // message comes from the JSON `reason` or `stopReason`").
    expect(errors(events)).toEqual(['no secrets in prompts']);
    expect(warnings(events)).toContain('UserPromptSubmit hook: policy v4 is in force');

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('NEGATIVE — a `stopReason` without `continue:false` surfaces nothing', async () => {
    // The field is documented as the message shown "when `continue` is
    // `false`". Printing it otherwise would tell the user a turn ended when it
    // did not.
    const agent = new CodexAgent(createConfig());
    const turns: Array<{ method: string; params: any }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event) {
        if (event === 'UserPromptSubmit') {
          return { matchedCount: 1, universal: { stopReason: 'this hook asked for no stop' } };
        }
        return { matchedCount: 1 };
      },
    });
    stubRuntime(agent, turns);

    const events = await collect(agent, 'first');

    expect(turns.some(entry => entry.method === 'turn/start')).toBe(true);
    expect(warnings(events).join('\n')).not.toContain('this hook asked for no stop');

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('CONTROL — a hook that returns neither field adds no warning row at all', async () => {
    const agent = new CodexAgent(createConfig());
    const turns: Array<{ method: string; params: any }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent() { return { matchedCount: 1 } },
    });
    stubRuntime(agent, turns);

    const events = await collect(agent, 'first');

    expect(turns.some(entry => entry.method === 'turn/start')).toBe(true);
    expect(warnings(events).filter(line => line.includes(' hook: '))).toHaveLength(0);

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('a `Stop` hook\'s stop is shown to the user, beside the reason fed to the model', async () => {
    // `recordHookBlockFeedback` carries `decision.reason` to the MODEL on the
    // next turn (P6.11). This is the other half: the sentence the user sees.
    const agent = new CodexAgent(createConfig());
    const turns: Array<{ method: string; params: any }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event) {
        if (event === 'Stop') {
          return {
            matchedCount: 1,
            decision: { decision: 'block', reason: 'the changelog is still unwritten' },
            universal: { continue: false, stopReason: 'release checklist incomplete' },
          };
        }
        return { matchedCount: 1 };
      },
    });
    stubRuntime(agent, turns);

    const first = await collect(agent, 'first');
    // MEASURED, and it is why `holdForNextTurn` exists: at the moment the Stop
    // hook answers, `turnSink` is non-null and its consumer has ALREADY
    // finished — `chatImpl`'s `finally` awaits `emitStopHookOnce()` before it
    // clears the field. A straight push lands in a drained queue and the notice
    // reaches NEITHER turn. This arm pins both halves of that: absent from the
    // first turn…
    expect(warnings(first).join('\n')).not.toContain('release checklist incomplete');
    // …and present at the head of the second, which is
    // `flushPendingServerWarnings`' documented shape.
    const second = await collect(agent, 'second');

    // "asked to stop", NOT "stopped this turn". Two reasons, both structural:
    // `hooks.md#stop-decision-control` gives the Stop event no cancel at all —
    // on codex a `continue:false` from it ends nothing — and the notice arrives
    // on the turn AFTER the one it is about, so "this turn" would name the
    // wrong turn. The sentence is the implementation's; this assertion is the
    // pin that stops the two drifting apart.
    expect(warnings(second)).toContain('Stop hook asked to stop: release checklist incomplete');
    // …and the MODEL half is unchanged: the reason still rides the next prompt.
    const starts = turns.filter(entry => entry.method === 'turn/start');
    expect(String(starts[1]?.params.input[0].text)).toContain('the changelog is still unwritten');

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });
});
