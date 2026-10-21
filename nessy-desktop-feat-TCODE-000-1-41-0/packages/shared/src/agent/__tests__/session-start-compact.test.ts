/**
 * S8 Task 2 — `SessionStart` fires with `source: "compact"` after compaction.
 *
 * hooks.md#sessionstart, `source`: "How the session started: `"startup"` for new
 * sessions, `"resume"` for resumed sessions, `"clear"` after `/clear`,
 * `"compact"` after compaction, or `"fork"` for a new session forked from an
 * existing one".
 *
 * hooks-guide.md § Re-inject context after compaction is the recipe that depends
 * on it: "Use a `SessionStart` hook with a `compact` matcher to re-inject
 * critical context after every compaction." Nessy only ever emitted `startup`
 * and `resume`, so that recipe matched nothing.
 *
 * These drive a compaction through the subprocess wire PiAgent actually listens
 * to — the `/compact` RPC answered by `compact_result` plus the `compaction_end`
 * event the Pi runtime emits alongside it. Calling the emitter directly would
 * prove the emitter, and the emitter was never what was missing.
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { AgentEvent as AutomationAgentEvent, SdkAutomationInput } from '../../automations/types.ts';

function config(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-compact',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-compact',
      workspaceRootPath: '/tmp/ws-compact',
      sessionRootPath: '/tmp/ws-compact/sessions',
    },
    session: {
      id: 'session-compact',
      workspaceRootPath: '/tmp/ws-compact',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-compact',
    },
    model: 'pi/test-model',
    isHeadless: true,
  } as unknown as BackendConfig;
}

interface Harness {
  agent: PiAgent;
  events: Array<{ event: AutomationAgentEvent; input: SdkAutomationInput }>;
  prompts: Array<Record<string, unknown>>;
  run(message: string): Promise<void>;
}

/**
 * A PiAgent wired to a stub subprocess that answers a `/compact` RPC the way the
 * real one does: the `compaction_end` runtime event, then `compact_result`.
 */
function harness(sessionStartContext?: string): Harness {
  const agent = new PiAgent(config());
  const events: Array<{ event: AutomationAgentEvent; input: SdkAutomationInput }> = [];
  const prompts: Array<Record<string, unknown>> = [];
  const internals = agent as unknown as Record<string, unknown>;

  (internals as Record<string, unknown>).emitAutomationEvent = async (
    event: AutomationAgentEvent,
    input: SdkAutomationInput,
  ) => {
    events.push({ event, input });
    return event === 'SessionStart' && sessionStartContext && input.source === 'compact'
      ? { matchedCount: 1, decision: { additionalContext: sessionStartContext } }
      : { matchedCount: 0 };
  };
  internals.ensureSubprocess = async () => undefined;
  internals.syncExecutionManifestForCurrentTurn = async () => ({
    snapshotGeneration: 'generation-1',
    manifestHash: 'manifest-1',
    tools: [],
    deferredMcp: { candidatePiNames: [] },
  });
  internals.send = (message: Record<string, unknown>) => {
    if (message.type === 'prompt') {
      prompts.push(message);
      (internals.eventQueue as { complete: () => void }).complete();
      return;
    }
    if (message.type !== 'compact') return;
    queueMicrotask(() => {
      // The runtime event first — this is the seam the host reacts to.
      (internals as { handleSubprocessEvent(event: Record<string, unknown>): void })
        .handleSubprocessEvent({ type: 'compaction_end', reason: 'manual', result: { ok: true }, aborted: false });
      (internals as { handleLine(line: string): void }).handleLine(JSON.stringify({
        type: 'compact_result',
        id: message.id,
        success: true,
        result: { summary: 'compacted', firstKeptEntryId: 'entry-2', tokensBefore: 120_000 },
      }));
    });
  };

  return {
    agent,
    events,
    prompts,
    run: async (message: string) => {
      for await (const _ of (agent as unknown as { chatImpl: (m: string) => AsyncGenerator<unknown> }).chatImpl(message)) {
        /* drain */
      }
    },
  };
}

describe('SessionStart after compaction', () => {
  it('fires with source "compact" when a real compaction completes', async () => {
    const { agent, events, run } = harness();

    await run('hello');
    await run('/compact');

    expect(events.filter(entry => entry.event === 'SessionStart').map(entry => entry.input.source))
      .toEqual(['startup', 'compact']);

    agent.destroy();
  });

  it('does not fire when the compaction aborted or failed', async () => {
    const { agent, events } = harness();
    const internals = agent as unknown as Record<string, unknown>;
    (internals as { _sessionStartHooksApplied: boolean })._sessionStartHooksApplied = true;
    const handle = (internals as { handleSubprocessEvent(event: Record<string, unknown>): void });

    handle.handleSubprocessEvent({ type: 'compaction_end', result: { ok: true }, aborted: true });
    handle.handleSubprocessEvent({ type: 'compaction_end', errorMessage: 'context overflow' });
    handle.handleSubprocessEvent({ type: 'compaction_end' });
    await Bun.sleep(0);

    expect(events.filter(entry => entry.event === 'SessionStart')).toHaveLength(0);
    agent.destroy();
  });

  it('re-injects the hook context on the next turn, on the volatile user tail', async () => {
    const { agent, prompts, run } = harness('Reminder: use Bun, not npm.');

    await run('hello');
    await run('/compact');
    await run('carry on');

    // Turn 1 predates the compaction; turn 2 is the `/compact` turn, which sends
    // no prompt at all; so the re-injection belongs to turn 3.
    expect(prompts).toHaveLength(2);
    const afterCompaction = prompts[1]!;
    expect(String(afterCompaction.message)).toContain('Reminder: use Bun, not npm.');
    // #862: the system prefix is pi-ai's cache key before all history. A value
    // that changes on every compaction must never land there.
    expect(String(afterCompaction.systemPrompt)).not.toContain('Reminder: use Bun, not npm.');

    agent.destroy();
  });

  it('delivers the re-injected context exactly once', async () => {
    const { agent, prompts, run } = harness('Reminder: use Bun, not npm.');

    await run('hello');
    await run('/compact');
    await run('carry on');
    await run('and again');

    expect(String(prompts[1]!.message)).toContain('Reminder: use Bun, not npm.');
    expect(String(prompts[2]!.message)).not.toContain('Reminder: use Bun, not npm.');

    agent.destroy();
  });

  it('delivers a repeated identical re-injection once, not once per compaction', async () => {
    // Overflow recovery can compact several times before the next user turn, and
    // the same hook returns the same reminder each time. N copies of one
    // sentence is noise, not emphasis.
    const { agent, prompts, run } = harness('Reminder: use Bun, not npm.');
    const internals = agent as unknown as Record<string, unknown>;

    await run('hello');
    const handle = (internals as { handleSubprocessEvent(event: Record<string, unknown>): void });
    handle.handleSubprocessEvent({ type: 'compaction_end', reason: 'overflow', result: { ok: true }, aborted: false });
    handle.handleSubprocessEvent({ type: 'compaction_end', reason: 'overflow', result: { ok: true }, aborted: false });
    await run('carry on');

    const message = String(prompts[1]!.message);
    expect(message.split('Reminder: use Bun, not npm.').length - 1).toBe(1);

    agent.destroy();
  });

  it('carries queued re-injection across a runtime replacement', async () => {
    // `disposeForRestart` + `restoreLifecycleState` is the dispose/recreate path
    // a restart-signature drift takes. Context queued before it must survive, or
    // a model switch between the compaction and the next turn eats the recipe.
    const { agent, run } = harness('Reminder: use Bun, not npm.');

    await run('hello');
    await run('/compact');
    const state = agent.captureLifecycleState();
    expect(state.pendingCompactHookContext).toEqual(['Reminder: use Bun, not npm.']);

    const replacement = harness();
    replacement.agent.restoreLifecycleState(state);
    await replacement.run('carry on');

    expect(String(replacement.prompts[0]!.message)).toContain('Reminder: use Bun, not npm.');

    agent.destroy();
    replacement.agent.destroy();
  });

  it('does not carry queued re-injection into another workspace', async () => {
    // `setWorkspace` is the other session boundary. It already resets every
    // session-scoped hook field; the queued context has to go with them.
    const { agent, prompts, run } = harness('Reminder: use Bun, not npm.');

    await run('hello');
    await run('/compact');
    agent.setWorkspace({
      id: 'ws-other',
      name: 'Other Workspace',
      rootPath: '/tmp/ws-other',
      workspaceRootPath: '/tmp/ws-other',
      sessionRootPath: '/tmp/ws-other/sessions',
    } as never);
    await run('first turn elsewhere');

    expect(String(prompts[1]!.message)).not.toContain('Reminder: use Bun, not npm.');
    agent.destroy();
  });

  it('does not carry a latched "clear" source into another workspace', async () => {
    const { agent, events, run } = harness();

    await run('hello');
    await agent.clearHistory();
    agent.setWorkspace({
      id: 'ws-other',
      name: 'Other Workspace',
      rootPath: '/tmp/ws-other',
      workspaceRootPath: '/tmp/ws-other',
      sessionRootPath: '/tmp/ws-other/sessions',
    } as never);
    await run('fresh workspace');

    expect(events.filter(entry => entry.event === 'SessionStart').map(entry => entry.input.source))
      .toEqual(['startup', 'startup']);

    agent.destroy();
  });

  it('reports source "clear" after clearHistory', async () => {
    // hooks.md#sessionstart: `clear` is the documented source "after `/clear`".
    const { agent, events, run } = harness();

    await run('hello');
    await agent.clearHistory();
    await run('fresh start');

    expect(events.filter(entry => entry.event === 'SessionStart').map(entry => entry.input.source))
      .toEqual(['startup', 'clear']);

    agent.destroy();
  });
});
