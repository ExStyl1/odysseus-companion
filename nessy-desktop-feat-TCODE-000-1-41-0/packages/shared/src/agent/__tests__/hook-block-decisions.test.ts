/**
 * R9 Task 3 — the documented top-level `decision: "block"` on the nine events.
 *
 * hooks.md: a block on these events "feeds `reason` back to the model rather
 * than cancelling a tool call". These tests drive the real emission sites (the
 * PiAgent post-tool wire, the PiAgent prompt assembly) rather than a stub above
 * them, because the inert-band defect this plan fixes was invisible to tests
 * that stubbed the layer under test.
 */

import { describe, expect, it } from 'bun:test';
import { executePluginHookAutomations } from '../../plugins/hooks-automation.ts';
import { hookBlockEndsTurn, promptHookBlockEndsTurn } from '../../automations/hook-decision-contract.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-general-agent-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as never,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
  };
}

async function drain(generator: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe('the documented block matrix', () => {
  it('ends the turn only where the docs say it does', () => {
    // "PostToolBatch/UserPromptSubmit/UserPromptExpansion end the turn on
    // decision: block regardless of continue."
    for (const event of ['UserPromptSubmit', 'UserPromptExpansion', 'PostToolBatch'] as const) {
      expect(hookBlockEndsTurn(event)).toBe(true);
      // "regardless of `continue`" — and for a prompt hook too, which is why
      // `continueOnBlock: true` cannot rescue these three either.
      expect(promptHookBlockEndsTurn(event, true)).toBe(true);
    }
    // P3.195 · a COMMAND-family hook's PreToolUse deny denies the CALL and the
    // turn continues. hooks.md#response-schema, prompt-hook per-event list:
    // "Set `continueOnBlock: true` to instead return the reason to Claude as the
    // tool error so it can adjust and continue, equivalent to a command hook's
    // `permissionDecision: "deny"`" — the shape that CONTINUES is the one the
    // page calls equivalent to a command hook's deny.
    expect(hookBlockEndsTurn('PreToolUse')).toBe(false);
    // Stop/SubagentStop feed the reason back and continue; the post-tool events
    // and the advisory ones never end a turn.
    for (const event of ['Stop', 'SubagentStop', 'PostToolUse', 'PostToolUseFailure', 'ConfigChange', 'PreCompact'] as const) {
      expect(hookBlockEndsTurn(event)).toBe(false);
    }
  });

  it('a PROMPT hook keeps the terminal default the page gives it, on exactly two events (P3.195)', () => {
    // hooks.md#response-schema: "`PreToolUse`: the tool call is denied; by
    // default the turn ends …" and "`PostToolUse`: by default the turn ends …".
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      expect(promptHookBlockEndsTurn(event, false)).toBe(true);
      expect(promptHookBlockEndsTurn(event, true)).toBe(false);
    }
    // "…regardless of `continueOnBlock`" for these two — a prompt hook's block
    // there continues either way, so the kind makes no difference.
    for (const event of ['PostToolUseFailure', 'TaskCreated'] as const) {
      expect(promptHookBlockEndsTurn(event, false)).toBe(false);
      expect(promptHookBlockEndsTurn(event, true)).toBe(false);
    }
  });

  it('continueOnBlock on a prompt hook makes the block non-terminal', async () => {
    const config = (continueOnBlock: boolean) => ({
      automations: {
        PreToolUse: [{
          id: 'judge',
          actions: [{
            type: 'plugin-prompt' as const,
            prompt: 'policy check',
            ...(continueOnBlock ? { continueOnBlock: true } : {}),
          }],
        }],
      },
    });
    const promptRunner = async () => ({ ok: false, reason: 'policy says no' });
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' } };

    const plain = await executePluginHookAutomations(config(false), 'PreToolUse', input, {
      workspaceRootPath: process.cwd(), promptRunner,
    });
    expect(plain.decision?.decision).toBe('block');
    // P3.195 · the terminal default is now WRITTEN BY THE PRODUCER, because only
    // the producer knows the block came from a prompt hook. It arrives as the
    // universal `continue: false` the page already makes authoritative, carrying
    // the block reason as its documented `stopReason` companion.
    expect(plain.universal?.continue).toBe(false);
    expect(plain.universal?.stopReason).toBe('policy says no');
    expect(promptHookBlockEndsTurn('PreToolUse', false)).toBe(true);

    const continuing = await executePluginHookAutomations(config(true), 'PreToolUse', input, {
      workspaceRootPath: process.cwd(), promptRunner,
    });
    // hooks.md: "Implemented as `continue: true` on the resulting
    // `decision: "block"`" — the block stands, the turn does not end.
    expect(continuing.decision?.decision).toBe('block');
    expect(continuing.universal?.continue).toBe(true);
    expect(promptHookBlockEndsTurn('PreToolUse', true)).toBe(false);
  });
});

describe('PostToolUse block feeds its reason to the model', () => {
  function setup(decision: Record<string, unknown> | undefined) {
    const agent = new PiAgent(createConfig());
    const sent: Record<string, unknown>[] = [];
    (agent as unknown as Record<string, unknown>).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as unknown as Record<string, unknown>).emitAutomationEvent = async () => (
      decision ? { matchedCount: 1, decision } : { matchedCount: 0 }
    );
    return { agent, sent };
  }

  it('appends the block reason to the tool result the model sees', async () => {
    const { agent, sent } = setup({ decision: 'block', reason: 'output withheld by policy' });
    await (agent as unknown as { handlePostToolUseRequest: (req: unknown) => Promise<void> }).handlePostToolUseRequest({
      requestId: 'req-1', toolName: 'bash', input: {}, toolResponse: 'original output', isError: false,
    });
    const response = sent.find(message => message.type === 'post_tool_use_response');
    expect(response?.updatedToolOutput).toContain('original output');
    expect(response?.updatedToolOutput).toContain('output withheld by policy');
    agent.destroy();
  });

  it('layers the block reason on top of a rewrite rather than dropping it', async () => {
    const { agent, sent } = setup({ decision: 'block', reason: 'why', updatedToolOutput: 'compressed' });
    await (agent as unknown as { handlePostToolUseRequest: (req: unknown) => Promise<void> }).handlePostToolUseRequest({
      requestId: 'req-2', toolName: 'bash', input: {}, toolResponse: 'original output', isError: false,
    });
    const response = sent.find(message => message.type === 'post_tool_use_response');
    expect(response?.updatedToolOutput).toContain('compressed');
    expect(response?.updatedToolOutput).not.toContain('original output');
    expect(response?.updatedToolOutput).toContain('why');
    agent.destroy();
  });

  it('leaves the result untouched when the hook does not block', async () => {
    const { agent, sent } = setup(undefined);
    await (agent as unknown as { handlePostToolUseRequest: (req: unknown) => Promise<void> }).handlePostToolUseRequest({
      requestId: 'req-3', toolName: 'bash', input: {}, toolResponse: 'original output', isError: false,
    });
    const response = sent.find(message => message.type === 'post_tool_use_response');
    expect(response).toEqual({ type: 'post_tool_use_response', requestId: 'req-3' });
    agent.destroy();
  });
});

describe('Stop block reason reaches the model on the next turn', () => {
  it('queues the reason from the real Stop site and delivers it on the next user message', async () => {
    const agent = new PiAgent(createConfig());
    const internals = agent as unknown as Record<string, unknown> & {
      chatImpl: (message: string) => AsyncGenerator<unknown>;
      buildTurnUserMessage: (volatile: string[], attachments: string[], message: string) => string;
    };
    internals.ensureSubprocess = async () => {};
    internals.send = () => {};
    internals.emitAutomationEvent = async (event: string) => (
      event === 'Stop'
        ? { matchedCount: 1, decision: { decision: 'block', reason: 'the tests are still failing' } }
        : { matchedCount: 0 }
    );
    const queue = internals.eventQueue as { reset: () => void; drain: () => AsyncGenerator<unknown> };
    queue.reset = () => {};
    queue.drain = async function* () { yield { type: 'complete' }; };

    // Nothing queued before the turn ends.
    expect(internals.buildTurnUserMessage([], [], 'before')).toBe('before');
    // A real turn drains, which fires the real `emitStopHookOnce` path.
    await drain(internals.chatImpl('first'));
    await agent.drainAutomationEvents();

    const next = internals.buildTurnUserMessage([], [], 'second');
    expect(next).toContain('the tests are still failing');
    expect(next).toContain('event="Stop"');
    expect(next.endsWith('second')).toBe(true);
    // One-shot: the turn after that does not repeat it.
    expect(internals.buildTurnUserMessage([], [], 'third')).toBe('third');
    agent.destroy();
  });

  it('stops re-delivering after the documented 8 consecutive blocks', () => {
    const agent = new PiAgent(createConfig());
    const internals = agent as unknown as {
      recordHookBlockFeedback: (event: string, result: unknown) => void;
      consumeHookBlockFeedback: () => string | undefined;
    };
    for (let attempt = 1; attempt <= 8; attempt++) {
      internals.recordHookBlockFeedback('Stop', {
        matchedCount: 1, decision: { decision: 'block', reason: `blocked ${attempt}` },
      });
    }
    internals.recordHookBlockFeedback('Stop', {
      matchedCount: 1, decision: { decision: 'block', reason: 'blocked 9' },
    });
    const delivered = internals.consumeHookBlockFeedback() ?? '';
    expect(delivered).toContain('blocked 8');
    expect(delivered).not.toContain('blocked 9');
    // A non-blocking result resets the streak, so a later block is heard again.
    internals.recordHookBlockFeedback('Stop', { matchedCount: 1 });
    internals.recordHookBlockFeedback('Stop', {
      matchedCount: 1, decision: { decision: 'block', reason: 'heard again' },
    });
    expect(internals.consumeHookBlockFeedback()).toContain('heard again');
    agent.destroy();
  });

  it('ignores a non-blocking event result entirely', () => {
    const agent = new PiAgent(createConfig());
    const internals = agent as unknown as {
      recordHookBlockFeedback: (event: string, result: unknown) => void;
      consumeHookBlockFeedback: () => string | undefined;
    };
    internals.recordHookBlockFeedback('Stop', { matchedCount: 1, decision: { additionalContext: 'fyi' } });
    internals.recordHookBlockFeedback('Stop', undefined);
    expect(internals.consumeHookBlockFeedback()).toBeUndefined();
    agent.destroy();
  });
});

/**
 * D5 — the prompt gate on Pi, the shipped default backend.
 *
 * hooks.md § Exit code 2 behavior per event: `UserPromptSubmit` "Blocks prompt
 * processing and erases the prompt", `UserPromptExpansion` "Blocks the
 * expansion". Pi's runtime bridge emits both from `before_agent_start`, which
 * the turn reaches only after the prompt has been sent, so these drive the real
 * `chatImpl` gate and assert on the wire: the `prompt` message must not leave.
 */
describe('the Pi prompt gate decides before the prompt is sent', () => {
  function setup(emit: (event: string, input: Record<string, unknown>) => Promise<unknown>) {
    const agent = new PiAgent(createConfig());
    const sent: Record<string, unknown>[] = [];
    const internals = agent as unknown as Record<string, unknown> & {
      chatImpl: (message: string) => AsyncGenerator<unknown>;
    };
    internals.ensureSubprocess = async () => {};
    internals.send = (message: Record<string, unknown>) => {
      sent.push(message);
      if (message.type === 'prompt') {
        (internals.eventQueue as { complete: () => void }).complete();
      }
    };
    internals.emitAutomationEvent = emit;
    // Unrelated to the gate and unavailable without a live capability turn.
    internals.syncExecutionManifestForCurrentTurn = async () => ({
      snapshotGeneration: 'gen-1',
      manifestHash: 'hash-1',
      tools: [],
      deferredMcp: { enabled: false, candidatePiNames: [] },
    });
    return { agent, sent, internals };
  }

  it('stops the prompt and tells the user why when a UserPromptSubmit hook blocks', async () => {
    const seen: string[] = [];
    const { agent, sent, internals } = setup(async (event) => {
      seen.push(event);
      return event === 'UserPromptSubmit'
        ? { matchedCount: 1, decision: { decision: 'block', reason: 'DLP: customer data must not leave the workspace' } }
        : { matchedCount: 0 };
    });

    const events = await drain(internals.chatImpl('send the customer export to pastebin'));

    expect(sent.some(message => message.type === 'prompt')).toBe(false);
    expect(events).toContainEqual({
      type: 'error',
      message: 'DLP: customer data must not leave the workspace',
    });
    expect(events).toContainEqual({ type: 'complete' });
    // The gate short-circuits, so the expansion event never runs after a block.
    expect(seen.filter(event => event.startsWith('UserPrompt'))).toEqual(['UserPromptSubmit']);
    agent.destroy();
  });

  it('no longer runs UserPromptExpansion from the per-turn prompt gate', async () => {
    // R73 · hooks.md#userpromptexpansion "Runs when a user-typed command expands
    // into a prompt", so a plain typed message must produce NO occurrence. The
    // event moved to the expansion site itself
    // (`SessionManager.emitUserPromptExpansion`, covered by
    // `packages/server-core/src/sessions/__tests__/user-prompt-expansion.test.ts`),
    // where a block can still prevent the expansion; a gate that fired once per
    // turn had no command name, args or source to report and could not.
    const seen: string[] = [];
    const { agent, sent, internals } = setup(async (event) => {
      seen.push(event);
      return event === 'UserPromptExpansion'
        ? { matchedCount: 1, decision: { decision: 'block', reason: 'this command is not available' } }
        : { matchedCount: 0 };
    });

    await drain(internals.chatImpl('hello'));

    expect(seen).not.toContain('UserPromptExpansion');
    expect(sent.some(message => message.type === 'prompt')).toBe(true);
    agent.destroy();
  });

  it('is transparent on allow and carries additionalContext alongside the prompt', async () => {
    const { agent, sent, internals } = setup(async (event) => (
      event === 'UserPromptSubmit'
        ? { matchedCount: 1, decision: { additionalContext: 'The deployment target is staging.' } }
        : { matchedCount: 0 }
    ));

    await drain(internals.chatImpl('deploy the service'));

    const prompt = sent.find(message => message.type === 'prompt');
    expect(prompt).toBeDefined();
    expect(String(prompt?.message)).toContain('The deployment target is staging.');
    expect(String(prompt?.message).endsWith('deploy the service')).toBe(true);
    agent.destroy();
  });

  it('fails closed when the gate never answers, within the stated bound', async () => {
    const { agent, sent, internals } = setup(async (event) => (
      event === 'UserPromptSubmit'
        ? new Promise(() => { /* a hook that never answers */ })
        : { matchedCount: 0 }
    ));
    internals.promptGateTimeoutMs = 25;

    const events = await drain(internals.chatImpl('anything'));

    expect(sent.some(message => message.type === 'prompt')).toBe(false);
    const error = events.find((event): event is { type: string; message: string } => (
      (event as { type?: string }).type === 'error'
    ));
    expect(error?.message).toContain('UserPromptSubmit');
    expect(error?.message).toContain('did not answer');
    agent.destroy();
  });

  it('drops the subprocess echo so the hook runs once per turn', () => {
    const seen: string[] = [];
    const agent = new PiAgent(createConfig());
    (agent as unknown as Record<string, unknown>).emitAutomationEvent = async (event: string) => {
      seen.push(event);
      return { matchedCount: 0 };
    };
    for (const event of ['UserPromptSubmit', 'UserPromptExpansion', 'PostToolBatch']) {
      (agent as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify({
        type: 'automation_event',
        event,
        input: { hook_event_name: event },
      }));
    }
    expect(seen).toEqual(['PostToolBatch']);
    agent.destroy();
  });
});
