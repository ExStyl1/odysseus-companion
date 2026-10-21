/**
 * L2 — THE LIVE SESSION, AND THE TWO THINGS THE REVIEW SET AS THE BAR.
 *
 * The bar, in the review's own words: **a Stop must leave a session that answers
 * the next message**, and **an interrupted turn must not be resumed by the pass
 * loop**. Everything else here exists to make those two provable rather than
 * merely plausible.
 *
 * The rig replaces the SDK's `query` with a fake CLI that behaves like a real
 * one in the one way that matters: it READS THE INPUT CHANNEL and stays open
 * between turns. Under the old shape `ClaudeAgent` passed a STRING prompt, so a
 * fake could not tell a live session from a one-shot; under this one the
 * difference is observable, and every claim below has a control on the same rig
 * that produces the opposite result.
 *
 * ABSENCE/PRESENCE DISCIPLINE. "The session survived" is never asserted from the
 * lack of an error: every survival claim is paired with a SECOND completed turn
 * on the SAME query object, and every death claim is paired with a turn that
 * worked on the same rig before it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { AbortReason } from '../core/session-lifecycle.ts';
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import { TestAgent, collectEvents, createMockBackendConfig, createMockSession } from './test-utils.ts';
import { sessionRuntimeDebugLogDir } from '../session-debug-log.ts';
import { enableDebug } from '../../utils/debug.ts';

/**
 * Feed one raw `system/init` through the production capture, exactly as the live
 * reader does — the same seam `protocol-capability-channel.test.ts` uses, so the
 * capability list these arms read is the one a real child publishes.
 */
function feedProtocolCapabilities(agent: unknown, capabilities: readonly string[]): void {
  (agent as { captureAdvertisedProtocolCapabilities(message: unknown): void })
    .captureAdvertisedProtocolCapabilities({ type: 'system', subtype: 'init', session_id: 'sdk-seam', capabilities });
}

/**
 * A SNAPSHOT of the SDK's exports, taken before the mock is installed — NOT the
 * live namespace. `mock.module` mutates the namespace object in place, so
 * `() => claudeAgentSdk` in the `afterAll` would hand the MOCK back and leave it
 * installed for every later file in the process (AGENTS.md §Traps, the
 * `mock.module` bullet; `scripts/check-mock-module-spread.ts` is the gate).
 */
const realSdk = { ...claudeAgentSdk };

// ---------------------------------------------------------------------------
// A fake CLI that reads the input channel and outlives the turn.
// ---------------------------------------------------------------------------

interface FakeSession {
  /** Prompts this session actually received, in order. */
  prompts: string[];
  /** Interrupt requests the agent sent to this session. */
  interrupts: number;
  /**
   * D1.361 — the ARGUMENT each of those interrupts carried, in order.
   *
   * `undefined` for the call this product makes. The SDK's shipped `sdk.mjs`
   * implements `interrupt(e)` and maps `{ cancelQueued: true }` onto the wire's
   * `cancel_queued`, so the option is real even though `sdk.d.ts` declares the
   * method with no parameter; recording it here is what lets a test state the
   * host's refusal to send it as a fact rather than as a comment.
   */
  interruptArgs: unknown[];
  /** True once the SDK's abortController fired for this session (session death). */
  aborted: boolean;
  /** True once the input channel reached EOF. */
  inputEnded: boolean;
  /**
   * L4 — the live setters this session was asked to perform.
   *
   * The fake grew these because WITHOUT them this file's reuse control was a
   * FALSE GREEN the moment `model` stopped being hashed into the signature: the
   * agent guards every setter with a `typeof` check and respawns when one is
   * missing, so a fake with no `setModel` would keep producing the second child
   * the control asserts — for the opposite of the stated reason.
   */
  setModelCalls: Array<string | undefined>;
}

/** One entry per `query()` call — i.e. per CHILD PROCESS the agent would spawn. */
const sessions: FakeSession[] = [];
/** Scripted responses, consumed one per prompt that arrives. */
const scripts: Array<(prompt: string) => AsyncGenerator<unknown>> = [];

/**
 * D1.361 — what this child's `interrupt()` RESOLVES to, per test.
 *
 * `null` is the product's ordinary shape (`{ still_queued: [] }`); a test BOXES a
 * value to drive the two other documented answers — a receipt naming survivors,
 * and the `undefined` an older CLI resolves to. The box is what makes the second
 * one expressible at all: `interruptReceipt ?? { still_queued: [] }` reads an
 * `undefined` as "unset" and hands back the default, so the older-CLI arm passed
 * against the ordinary shape and could never have failed. Reset in `beforeEach`
 * beside `scripts`, so a test that sets it cannot colour the next one.
 */
let interruptReceipt: { value: unknown } | null = null;

function resultMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    session_id: 'fake-live-session',
    stop_reason: null,
    modelUsage: {},
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  };
}

/**
 * A real turn produces assistant content before its result, and the fixture has
 * to as well: `chatImpl`'s empty-response recovery fires on a RESUMED turn that
 * produced none, and a fake that only ever emits a result would trip it on every
 * turn after the first — measured, not guessed.
 */
function assistantMessage(text: string): unknown {
  return {
    type: 'assistant',
    session_id: 'fake-live-session',
    message: {
      id: `msg-${text}`,
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield assistantMessage('ok');
  yield resultMessage();
}

/** The text of one streamed `SDKUserMessage`, as the CLI would read it. */
function promptTextOf(message: unknown): string {
  const content = (message as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      !!block && typeof block === 'object' && (block as { type?: string }).type === 'text')
    .map(block => block.text)
    .join('\n');
}

/** The user's own text is the LAST line: `buildTextPrompt` prepends the context. */
function userLineOf(prompt: string): string {
  const lines = prompt.trimEnd().split('\n');
  return lines[lines.length - 1] ?? prompt;
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    const session: FakeSession = {
      prompts: [], interrupts: 0, interruptArgs: [], aborted: false, inputEnded: false, setModelCalls: [],
    };
    sessions.push(session);
    const abortController = input.options.abortController as AbortController | undefined;
    abortController?.signal.addEventListener('abort', () => { session.aborted = true; }, { once: true });

    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          session.inputEnded = true;
          return;
        }
        const prompt = promptTextOf(next.value);
        session.prompts.push(prompt);
        const script = scripts.shift() ?? plainSuccess;
        yield* script(prompt);
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & {
      interrupt(arg?: unknown): Promise<unknown>;
      setModel(model?: string): Promise<void>;
    };
    stream.interrupt = async (arg?: unknown) => {
      session.interrupts += 1;
      session.interruptArgs.push(arg);
      return interruptReceipt ? interruptReceipt.value : { still_queued: [] };
    };
    stream.setModel = async (model?: string) => { session.setModelCalls.push(model); };
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

const WORKSPACE_ID = 'ws-l2-live-session';
const WORKSPACE_ROOT = '/tmp/nessy-l2-live-session';

let sessionCounter = 0;

function agentConfig(): BackendConfig {
  sessionCounter += 1;
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: WORKSPACE_ID,
      name: 'L2 Live Session',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-l2-${sessionCounter}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

type Agent = InstanceType<typeof ClaudeAgent>;

/** Drive one real `chatImpl` turn and collect the events it emitted. */
async function runTurn(agent: Agent, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as {
    chatImpl: (message: string) => AsyncGenerator<AgentEvent>;
  }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

let agents: Agent[] = [];

function makeAgent(): Agent {
  const agent = new ClaudeAgent(agentConfig()) as Agent;
  agents.push(agent);
  return agent;
}

beforeEach(() => {
  sessions.length = 0;
  scripts.length = 0;
  interruptReceipt = null;
});

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy();
});

// ---------------------------------------------------------------------------

describe('one process, many turns', () => {
  it('two turns run through ONE query, on the SAME input channel', async () => {
    const agent = makeAgent();

    const first = await runTurn(agent, 'turn one');
    const second = await runTurn(agent, 'turn two');

    // ONE child for two turns — the claim.
    expect(sessions).toHaveLength(1);
    // And the SECOND message went down the SAME channel, which is the part a
    // silently one-shot build cannot fake: a fresh query would have put it in a
    // second session's prompt list.
    expect(sessions[0]!.prompts.map(userLineOf)).toEqual(['turn one', 'turn two']);
    expect(sessions[0]!.aborted).toBe(false);
    expect(sessions[0]!.inputEnded).toBe(false);
    // Both turns really completed; "one query" is not "one query and one hang".
    expect(first.filter(event => event.type === 'complete')).toHaveLength(1);
    expect(second.filter(event => event.type === 'complete')).toHaveLength(1);
  });

  it('THE CONTROL: a drifted construction option respawns, so the reuse check can fail', async () => {
    // Without this, "one query for two turns" proves only that the rig cannot
    // count to two. The option has to be one with NO live setter, or the control
    // proves the opposite of what it says: L4 gave `model` a setter, and this
    // test used to change the model.
    //
    // `thinking` is such an option (an effort-only move goes live through
    // `applyFlagSettings` since F1.821/F1.1099): its only live equivalent is the
    // DEPRECATED `setMaxThinkingTokens`, which cannot express the adaptive
    // shape, so a thinking change is a genuine respawn and stays one.
    const agent = makeAgent();

    await runTurn(agent, 'turn one');
    agent.setThinkingLevel('off');
    await runTurn(agent, 'turn two');

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.prompts.map(userLineOf)).toEqual(['turn one']);
    expect(sessions[1]!.prompts.map(userLineOf)).toEqual(['turn two']);
    // The superseded child was torn down rather than left running.
    expect(sessions[0]!.aborted).toBe(true);
  });

  it('isProcessing() is false between turns even though the query is alive', async () => {
    // It used to be `currentQuery !== null`, which is now permanently true.
    // `SessionManager` gates runtime-config refresh, agent eviction and the
    // mid-stream send decision on this, so a stuck `true` is not cosmetic.
    const agent = makeAgent();
    expect(agent.isProcessing()).toBe(false);
    await runTurn(agent, 'turn one');
    expect(agent.isProcessing()).toBe(false);
    // PRESENCE on the same rig: the query really is alive, which is what makes
    // the `false` above a statement about the SLOT rather than about the child.
    await runTurn(agent, 'turn two');
    expect(sessions).toHaveLength(1);
  });
});

describe('a Stop stops the TURN and leaves a session that answers the next message', () => {
  it('THE BAR: interrupt, then the next message is answered by the same child', async () => {
    const agent = makeAgent();

    // Turn 1 is in flight when the user presses Stop. The fake settles it the
    // way the CLI does: an ORDINARY result carrying the SDK's own
    // `terminal_reason`, never a distinct terminal subtype.
    scripts.push(async function* interruptedTurn() {
      yield assistantMessage('working on it');
      agent.forceAbort(AbortReason.UserStop);
      yield resultMessage({ is_error: true, terminal_reason: 'aborted_streaming', result: '' });
    });

    const stopped = await runTurn(agent, 'do the long thing');

    // The turn was cancelled the SDK's own way, not by killing the child.
    expect(sessions[0]!.interrupts).toBe(1);
    expect(sessions[0]!.aborted).toBe(false);
    expect(sessions[0]!.inputEnded).toBe(false);
    // The user is told, on the channel they were told on before.
    expect(stopped.some(event => event.type === 'status' && event.message === 'Interrupted')).toBe(true);
    // PRECONDITION 1 — the completion is NAMED, so the pass loop cannot resume it.
    const stoppedComplete = stopped.find(event => event.type === 'complete') as { terminalReason?: string };
    expect(stoppedComplete.terminalReason).toBe('user_stop');

    // THE BAR ITSELF: the very next message is answered, by the same process,
    // through the same channel.
    const next = await runTurn(agent, 'now do the short thing');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.prompts.map(userLineOf)).toEqual(['do the long thing', 'now do the short thing']);
    const nextComplete = next.find(event => event.type === 'complete') as { terminalReason?: string };
    expect(nextComplete).toBeDefined();
    expect(nextComplete.terminalReason).toBeUndefined();
  });

  /**
   * D1.361 + D1.362 — WHAT A STOP LEAVES BEHIND FOR THE NEXT READER.
   *
   * RS-81 (packaged 1.40.0, 2026-09-18) asked the artefact what the host does at
   * this seam and could not tell, because the only record went through
   * `this.debug` — the seam line scored **0** in both arms' per-session runtime
   * diagnostic while the file itself grew 214 → 319 and 214 → 246 lines, so the
   * channel was live and the host's half simply was not in it. These three arms
   * are that reading made falsifiable without the packaged app.
   *
   * The positive names the FILE and its two lines; the negative is the same Stop
   * with the host out of debug mode, which must write nothing while still
   * interrupting (a negative that also stopped interrupting would prove nothing
   * about the writer); and the third drives the receipt shapes the SDK documents.
   */
  describe('the seam a Stop leaves behind', () => {
    const noteFile = (agent: Agent): string =>
      join(sessionRuntimeDebugLogDir(), `${(agent as unknown as { config: { session: { id: string } } }).config.session.id}-claude-host.txt`);

    /** Drive one Stop through the real `forceAbort` → `interruptLiveTurn` path. */
    async function stopATurn(agent: Agent): Promise<void> {
      scripts.push(async function* interruptedTurn() {
        yield assistantMessage('working on it');
        agent.forceAbort(AbortReason.UserStop);
        yield resultMessage({ is_error: true, terminal_reason: 'aborted_streaming', result: '' });
      });
      await runTurn(agent, 'do the long thing');
      // The receipt is read on a microtask after the interrupt resolves; the
      // turn settling does not order that write, so give it one tick. Bounded
      // and not a poll: a longer wait would hide a write that never happens.
      await Bun.sleep(20);
    }

    it('writes the capability read AND the receipt into this session\'s own host-note file', async () => {
      enableDebug();
      interruptReceipt = { value: { still_queued: ['queued-uuid-1'] } };
      const agent = makeAgent();
      feedProtocolCapabilities(agent, ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1']);

      await stopATurn(agent);

      expect(sessions[0]!.interrupts).toBe(1);
      const written = readFileSync(noteFile(agent), 'utf-8');
      // P6.263's question, answered where a Stop is investigated.
      expect(written).toContain('Claude turn interrupt (user_stop); child advertises interrupt_receipt_v1');
      expect(written).toContain('interrupt_receipt_v1, interrupt_cancel_queued_v1');
      // D1.361 — the receipt is no longer thrown away. This is the line that
      // makes `still_queued` answerable on an artefact at all.
      expect(written).toContain('still_queued=[queued-uuid-1]');
      // THE REFUSAL, as a fact rather than a comment: the host asks for the
      // plain interrupt. `cancel_queued` names messages the CHILD holds, and
      // this product never gives it one while a turn is in flight — the queue is
      // `SessionManager.messageQueue` and a steer is on `pendingSteers` (F1.238).
      expect(sessions[0]!.interruptArgs).toEqual([undefined]);
    });

    it('THE CONTROL: out of debug mode the same Stop still interrupts and writes no file', async () => {
      enableDebug();
      // `isDebugEnabled()` answers false for a CLI-json run whatever the flag
      // says, which is the only way to take the switch back inside one process —
      // `enableDebug()` has no twin, and an arm that relied on test ORDER would
      // be the kind of control that cannot fail.
      delete process.env.NESSY_CLI_JSON_ONLY;
      process.env.NESSY_CLI_JSON_ONLY = '1';
      try {
        const agent = makeAgent();
        feedProtocolCapabilities(agent, ['interrupt_receipt_v1']);

        await stopATurn(agent);

        // The Stop itself is UNCHANGED — this is a statement about the writer.
        expect(sessions[0]!.interrupts).toBe(1);
        expect(existsSync(noteFile(agent))).toBe(false);
      } finally {
        delete process.env.NESSY_CLI_JSON_ONLY;
      }
    });

    it('records the older CLI\'s empty answer as an answer, not as a blank', async () => {
      enableDebug();
      // `sdk.d.ts` on `Query.interrupt`: "Older CLIs resolve to undefined."
      // Writing nothing for that case would leave a reader unable to tell an old
      // child from a host that never asked — the exact confusion RS-81 hit.
      interruptReceipt = { value: undefined };
      const agent = makeAgent();
      feedProtocolCapabilities(agent, []);

      await stopATurn(agent);

      const written = readFileSync(noteFile(agent), 'utf-8');
      expect(written).toContain('child does NOT advertise interrupt_receipt_v1 (capabilities: none)');
      expect(written).toContain('receipt (user_stop): none');
      expect(written).not.toContain('still_queued=');
    });
  });

  /**
   * REGRESSION — a Stop the child never answers used to hang the turn forever.
   *
   * Before one query per agent, `UserStop` was `abortController.abort()`, and
   * the SDK registers `() => this.close()` as its abort handler: stdin EOF at
   * once, SIGTERM about two seconds later. So a Stop ALWAYS ended the turn
   * within a bound, whatever the child was doing. `interrupt()` is a control
   * request written to stdin, so a wedged child simply never answers it — and
   * the first version of L2 armed nothing behind it. Measured in review: a fake
   * CLI that acknowledges the interrupt and then emits nothing left the turn
   * unsettled past the probe's bound, while the same script settled under the
   * old abort.
   *
   * The deadline restores the guarantee. This test uses a short one so the suite
   * does not wait five real seconds for it.
   */
  it('REGRESSION: a Stop the child never answers still ends the turn', async () => {
    const agent = makeAgent();
    // Shorten the backstop for the test rather than waiting out the shipped one.
    (agent as unknown as { interruptDeadlineMs: number }).interruptDeadlineMs = 200;

    scripts.push(async function* wedgedTurn() {
      yield assistantMessage('working on it');
      agent.forceAbort(AbortReason.UserStop);
      // The CLI acknowledges the interrupt and then never produces a result.
      await new Promise(resolve => setTimeout(resolve, 5_000));
      yield resultMessage({});
    });

    const events = await runTurn(agent, 'do the long thing');

    // It ended. Before the deadline existed this call never returned.
    expect(events.length).toBeGreaterThan(0);
    expect(sessions[0]!.interrupts).toBe(1);
    // The escalation is deliberate session death — the child has already proven
    // it is not answering its control channel, so nothing gentler is left.
    expect(sessions[0]!.aborted).toBe(true);
  }, 10_000);

  /**
   * REGRESSION — a Stop pressed BETWEEN turns poisoned the next one.
   *
   * `lastAbortReason` was recorded before the "is a turn open" check, and the
   * reader consumes it at whatever completion comes next. Measured in review:
   * turn 1 completes clean, a Stop lands between turns, and turn 2's completion
   * comes back `terminalReason: 'user_stop'` with an "Interrupted" status — on a
   * message the user never stopped.
   *
   * The window is not theoretical. `SessionManager.cancelProcessing` gates on
   * `isProcessing`, which stays true while a completion is being processed and
   * across the skill continuation, and both run with no slot open.
   */
  /**
   * REGRESSION — a Stop during turn PREPARATION used to be swallowed, and the
   * turn then ran anyway.
   *
   * L4 made `ensureLiveSession` awaited, because the live setters are control
   * requests that must be acknowledged before the turn's message is written.
   * That opened a window: `isProcessing()` is slot-based, so a Stop arriving
   * between the await and the slot returns at the "no slot open" guard having
   * cancelled the UI and nothing else — and then the turn proceeds.
   *
   * "Stop did nothing, and then it answered" is the same removed-guarantee class
   * as L2's own blocking finding, which is why it is caught rather than raced.
   */
  it('REGRESSION: a Stop during session preparation does not start the turn', async () => {
    const agent = makeAgent();

    // Turn 1 builds the session; nothing is stopped.
    await runTurn(agent, 'first');
    const promptsAfterFirst = sessions[0]!.prompts.length;

    // The Stop lands while the next turn is preparing. `ensureLiveSession` is
    // awaited there, so the flag is what carries the intent across it.
    const internals = agent as unknown as { turnPreparing: boolean; stopRequestedWhilePreparing: boolean };
    internals.turnPreparing = true;
    agent.forceAbort(AbortReason.UserStop);
    expect(internals.stopRequestedWhilePreparing).toBe(true);
    internals.turnPreparing = false;

    // THE CLAIM: the message the user stopped is never written to the session.
    // (`chat()` still surfaces a completion for the aborted turn — that is the
    // existing abort classification and not this fix's subject. What must not
    // happen is the model being asked.)
    const events = await runTurn(agent, 'second');
    expect(sessions[0]!.prompts.length).toBe(promptsAfterFirst);
    expect(sessions[0]!.prompts.map(userLineOf)).not.toContain('second');
    expect(events).toBeDefined();
    // And the flag is consumed, so the turn after it is unaffected.
    expect(internals.stopRequestedWhilePreparing).toBe(false);
    const third = await runTurn(agent, 'third');
    expect(third.some(event => event.type === 'complete')).toBe(true);
  });

  it('REGRESSION: a Stop between turns does not mark the NEXT turn as interrupted', async () => {
    const agent = makeAgent();

    await runTurn(agent, 'first');

    // The user presses Stop with nothing running.
    agent.forceAbort(AbortReason.UserStop);

    const second = await runTurn(agent, 'second');
    const complete = second.find(event => event.type === 'complete') as { terminalReason?: string };
    expect(complete).toBeDefined();
    expect(complete.terminalReason).toBeUndefined();
    expect(second.some(event => event.type === 'status' && event.message === 'Interrupted')).toBe(false);
    // And the session was never interrupted or killed for a turn that was not running.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.interrupts).toBe(0);
    expect(sessions[0]!.aborted).toBe(false);
  });

  it('THE CONTROL: a dispose reason still kills the session, so "it survived" is a real distinction', async () => {
    // `forceAbort` dispatches on the reason. An internal error is teardown, and
    // it must still tear down — otherwise the survival above would just mean
    // "this build never kills anything".
    const agent = makeAgent();

    scripts.push(async function* dyingTurn() {
      agent.forceAbort(AbortReason.InternalError);
      yield resultMessage();
    });
    await runTurn(agent, 'first');

    expect(sessions[0]!.aborted).toBe(true);
    expect(sessions[0]!.interrupts).toBe(0);

    // And the next turn has to build a new child, because the old one is gone.
    await runTurn(agent, 'second');
    expect(sessions).toHaveLength(2);
  });

  it('PRECONDITION 2: the Stop cancels the permission card and the model question', async () => {
    // `forceAbort` performed both; no turn-end path ever did. Moving Stop onto
    // the interrupt path without carrying them would leave a card on screen
    // holding a promise nobody will resolve — the SDK may be blocked on it.
    const agent = makeAgent();
    const internals = agent as unknown as {
      askToolApproval(request: Record<string, unknown>): Promise<{ allowed: boolean; comment?: string }>;
      onPermissionRequest: ((request: unknown) => void) | null;
      pendingPermissions: Map<string, unknown>;
    };
    internals.onPermissionRequest = () => {};

    const approval = internals.askToolApproval({
      requestId: 'req-1',
      toolName: 'Bash',
      command: 'rm -rf /',
      description: 'dangerous',
    });
    expect(internals.pendingPermissions.size).toBe(1);

    agent.forceAbort(AbortReason.UserStop);

    // Settled with a refusal rather than left hanging. P6.951 made the answer an
    // OBJECT so a denial can carry the user's note; an abort writes no note, so
    // the whole answer is asserted rather than only its verdict.
    expect(await approval).toEqual({ allowed: false });
    expect(internals.pendingPermissions.size).toBe(0);
    // And it was the INTERRUPT path that did it — the session is still alive.
    expect(sessions).toHaveLength(0);
  });
});

describe('the option signature — what decides reuse', () => {
  // The signature is the whole safety of reusing a child: an `Options` field
  // with no live setter — `systemPrompt`, `cwd`, `tools`, `agents`, `hooks` —
  // can only be honoured by a NEW child, so a session may be reused only while
  // the options it was built with are still the ones the turn wants. Two ways to
  // get it wrong, and both are silent: hashing too much respawns on every turn
  // and leaves the shape one-shot; hashing too little runs a turn against a
  // stale option set.
  //
  // L4 moved three fields OUT of it — `model`, `permissionMode` and
  // `mcpServers` — because each does have a setter. The controls below are split
  // to match: the settable three must NOT move the signature, and everything
  // else must.
  const baseOptions = () => ({
    model: 'claude-sonnet-4-6',
    cwd: '/tmp/project',
    systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: 'hello' },
    tools: { type: 'preset' as const, preset: 'claude_code' as const },
    disallowedTools: ['Read', 'Write'],
    mcpServers: { session: { instance: {} }, linear: { instance: {} } },
    hooks: { PreToolUse: [{ hooks: [() => {}] }] },
    // Live callbacks whose IDENTITY changes every turn while their meaning does
    // not — they read agent state at call time.
    canUseTool: () => {},
    stderr: () => {},
    abortController: new AbortController(),
  });

  it('is stable across turns: fresh closures, fresh server instances, same signature', async () => {
    const { claudeLiveSessionSignature } = await import('../backend/claude/live-session.ts');
    expect(claudeLiveSessionSignature(baseOptions() as never))
      .toBe(claudeLiveSessionSignature(baseOptions() as never));
  });

  it('ignores the resume anchor, which is the one that would respawn on turn two of every session', async () => {
    const { claudeLiveSessionSignature } = await import('../backend/claude/live-session.ts');
    const first = { ...baseOptions() };
    const second = { ...baseOptions(), resume: 'sdk-session-abc' };
    expect(claudeLiveSessionSignature(second as never)).toBe(claudeLiveSessionSignature(first as never));
    // The anchor still gates reuse — `ClaudeAgent.ensureLiveSession` compares it
    // against the session id the live stream reported. It is just not hashed.
  });

  it('THE CONTROLS: each construction option that has no live setter moves it', async () => {
    const { claudeLiveSessionSignature } = await import('../backend/claude/live-session.ts');
    const base = claudeLiveSessionSignature(baseOptions() as never);
    const drift = (mutate: (options: Record<string, unknown>) => void): string => {
      const options = baseOptions() as unknown as Record<string, unknown>;
      mutate(options);
      return claudeLiveSessionSignature(options as never);
    };
    expect(drift(o => { o.cwd = '/tmp/other'; })).not.toBe(base);
    expect(drift(o => { (o.systemPrompt as { append: string }).append = 'goodbye'; })).not.toBe(base);
    expect(drift(o => { o.hooks = {}; })).not.toBe(base);
    expect(drift(o => { o.tools = ['Read']; })).not.toBe(base);
    expect(drift(o => { o.agents = { helper: { description: 'x', prompt: 'y' } }; })).not.toBe(base);
    expect(drift(o => { o.effort = 'high'; })).not.toBe(base);
    // The bypass flag is a SPAWN-TIME CLI FLAG, and the CLI refuses to enter the
    // mode that needs it on a session launched without it — "Cannot set
    // permission mode to bypassPermissions because the session was not launched
    // with --dangerously-skip-permissions". So it stays hashed even though the
    // mode it rides with does not.
    expect(drift(o => { o.allowDangerouslySkipPermissions = true; })).not.toBe(base);
  });

  it('L4 — the three options WITH a live setter no longer move it', async () => {
    // The mirror of the controls above, and the half that can silently rot: if
    // one of these ever starts moving the signature again, the setter it belongs
    // to becomes unreachable and the session goes back to respawning with
    // nothing in the log to say so.
    const { claudeLiveSessionSignature } = await import('../backend/claude/live-session.ts');
    const base = claudeLiveSessionSignature(baseOptions() as never);
    const drift = (mutate: (options: Record<string, unknown>) => void): string => {
      const options = baseOptions() as unknown as Record<string, unknown>;
      mutate(options);
      return claudeLiveSessionSignature(options as never);
    };
    expect(drift(o => { o.model = 'claude-opus-4-1'; })).toBe(base);
    expect(drift(o => { o.permissionMode = 'plan'; })).toBe(base);
    expect(drift(o => { (o.mcpServers as Record<string, unknown>).github = { instance: {} }; })).toBe(base);
    // P6.221 — the FOURTH, and the one that moved out of the controls above: a
    // GROWN deny list rides `applyFlagSettings({permissions:{deny}})` instead of
    // a new process. The direction it cannot take (a narrowed list) is refused
    // by `claudeDenyListDrift`, not by this signature — see
    // `claude-live-deny-list.test.ts`.
    expect(drift(o => { o.disallowedTools = ['Monitor', 'Read']; })).toBe(base);
  });

  it('P6.931 — the MANAGED tier moves it, and its absence is the unmanaged baseline', async () => {
    // `managedSettings` had no signature entry and no live setter: `Query`
    // exposes nothing that touches it, and it was not among the deliberate
    // absences this module's header enumerates either. Meanwhile it is composed
    // PER TURN from four contributors, two of which are re-read on every turn
    // (`resolveManagedPiPolicyFloor()`, `resolveGitAttribution()`), so an
    // administrator tightening a policy mid-session was answered by a child
    // still enforcing the launch-time one.
    const { claudeLiveSessionSignature } = await import('../backend/claude/live-session.ts');
    const base = claudeLiveSessionSignature(baseOptions() as never);
    const withPolicy = (permissions: unknown): string => {
      const options = baseOptions() as unknown as Record<string, unknown>;
      options.managedSettings = { permissions };
      return claudeLiveSessionSignature(options as never);
    };

    const denied = withPolicy({ deny: ['Bash(rm *)'] });
    // A TIGHTENING must respawn: this is the direction with the security
    // meaning, and the one a live child cannot be told about.
    expect(denied).not.toBe(base);
    // …and so must a change WITHIN the tier, not only its appearance.
    expect(withPolicy({ deny: ['Bash(rm *)', 'Bash(curl *)'] })).not.toBe(denied);

    // THE BASELINE, and it is load-bearing: an unmanaged install gets no option
    // at all (`buildClaudeManagedSettingsOptions` returns `{}` with nothing to
    // say), so its signature must be exactly what it was before this row —
    // otherwise shipping this respawns every live session once for nothing.
    const unmanaged = baseOptions() as unknown as Record<string, unknown>;
    expect('managedSettings' in unmanaged).toBe(false);
    expect(claudeLiveSessionSignature(unmanaged as never)).toBe(base);

    // And the control that keeps all of the above from passing by accident: the
    // same policy twice is the same signature, so a managed install does not
    // churn its child every turn.
    expect(withPolicy({ deny: ['Bash(rm *)'] })).toBe(denied);
  });

  it('P6.312 — the main-thread pin moves it, separately from the roster it names', async () => {
    // `Options.agent` has no live setter: `Query` exposes nothing that
    // re-points the main thread, so a changed pin has to respawn or the child
    // keeps running as the agent it launched as. Hashed SEPARATELY from
    // `agents`, because two agents that declare no model register identically —
    // a pin moving between them leaves `agents` byte-identical.
    const { claudeLiveSessionSignature } = await import('../backend/claude/live-session.ts');
    const withAgents = (agent?: string): string => {
      const options = baseOptions() as unknown as Record<string, unknown>;
      options.agents = { reviewer: { description: 'r', prompt: 'p' }, scout: { description: 's', prompt: 'q' } };
      if (agent !== undefined) options.agent = agent;
      return claudeLiveSessionSignature(options as never);
    };
    expect(withAgents('reviewer')).not.toBe(withAgents('scout'));
    expect(withAgents('reviewer')).not.toBe(withAgents(undefined));
    // The control: the same pin twice is the same signature, so a pinned
    // session does not churn its child every turn.
    expect(withAgents('reviewer')).toBe(withAgents('reviewer'));
  });

  it('server ORDER is not a drift — the same set spelled differently must reuse', async () => {
    // `createSourceProxyServers` builds a fresh object each turn; key order is
    // not a promise anyone made, and treating it as one would respawn at random.
    // The claim moved to `claudeLiveSettings` when the servers left the
    // signature, so it is asserted on BOTH — the signature must be blind to them
    // and the reconciliation must not read a reorder as a changed set.
    const { claudeLiveSessionSignature, claudeLiveSettings, sameMcpServerNames } =
      await import('../backend/claude/live-session.ts');
    const reordered = baseOptions() as unknown as Record<string, unknown>;
    reordered.mcpServers = { linear: { instance: {} }, session: { instance: {} } };
    expect(claudeLiveSessionSignature(reordered as never))
      .toBe(claudeLiveSessionSignature(baseOptions() as never));
    expect(sameMcpServerNames(
      claudeLiveSettings(reordered as never).mcpServerNames,
      claudeLiveSettings(baseOptions() as never).mcpServerNames,
    )).toBe(true);
  });
});

describe('the pass loop must not resume an interrupted turn', () => {
  // The real `BaseAgent.chat` loop, driven by a backend that emits exactly what
  // `ClaudeAgent` now emits for an interrupted turn. The adapter half of the
  // chain — that an interrupted SDK result becomes `terminalReason: 'user_stop'`
  // — is pinned in `claude-result-is-error-baseline.test.ts`.
  const PROJECT = '/fixture/interrupted-pass-loop';

  function runtimeWithSkill(): CapabilityTurnRuntime {
    const resource = {
      source: 'project',
      scope: { kind: 'project', workspaceId: 'ws' },
      resourceId: 'skill:py',
      absolutePath: `${PROJECT}/.agents/skills/py/SKILL.md`,
      revision: '1',
      contentHash: 'c'.repeat(64),
    };
    return {
      provider: 'pi',
      view: {
        generation: 'generation-interrupted',
        sources: [],
        skills: [{
          key: 'skill:project:py',
          logicalName: 'py',
          description: 'Python helper',
          selectedAsUnqualifiedAlias: true,
          resource,
        }],
        mcpServers: [], hooks: [], automations: [], agents: [],
        promptLayers: [], memory: [], permissionLayers: [],
        commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
      },
      materializer: {
        assertActive() {},
        async verifyPlugin() {},
        async resolvePath() { return resource.absolutePath; },
        async readText() { return 'PY_SKILL_BODY'; },
        resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
      },
    } as unknown as CapabilityTurnRuntime;
  }

  const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

  it('a `user_stop` completion ends the turn even when the model asked for a skill', async () => {
    const agent = new TestAgent(createMockBackendConfig({
      session: createMockSession({ workingDirectory: PROJECT }),
    }));
    agent.setCapabilityTurnRuntime(runtimeWithSkill());
    agent.scriptedEvents = [
      { type: 'text_complete', text: 'Let me use [skill:py] for this.' },
      { type: 'complete', usage, terminalReason: 'user_stop' },
    ] as AgentEvent[];

    const events = await collectEvents(agent.chat('do the thing'));

    // ONE backend entry. A reason-free `complete` would have been held back and
    // continued from — which is exactly what a bare `complete` after a Stop
    // would have done before the adapter learned to name the ending.
    expect(agent.chatCalls).toHaveLength(1);
    const completes = events.filter(event => event.type === 'complete');
    expect(completes).toHaveLength(1);
    expect((completes[0] as { terminalReason?: string }).terminalReason).toBe('user_stop');
  });

  it('THE CONTROL: the same script WITHOUT the reason does continue — two entries', async () => {
    // Without this, "one entry" proves only that the fixture never continues.
    const agent = new TestAgent(createMockBackendConfig({
      session: createMockSession({ workingDirectory: PROJECT }),
    }));
    agent.setCapabilityTurnRuntime(runtimeWithSkill());
    agent.scriptedEvents = [
      { type: 'text_complete', text: 'Let me use [skill:py] for this.' },
      { type: 'complete', usage },
    ] as AgentEvent[];

    await collectEvents(agent.chat('do the thing'));

    expect(agent.chatCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// L5 — THE BACKGROUND-TASK LEVEL IS PER-PROCESS
// ---------------------------------------------------------------------------

/**
 * `SDKBackgroundTasksChangedMessage` is a LEVEL signal, and its own contract
 * ends: *"The level is per-process: nothing is emitted at startup, so consumers
 * must reset to the empty set whenever the session's CLI process (re)starts and
 * let the next membership change repopulate it."*
 *
 * That sentence cost nothing before L2, because a Claude turn WAS a process and
 * every process got a fresh `ClaudeEventAdapter`. Under one `query()` per agent
 * the adapter outlives every respawn `ensureLiveSession` performs, so the level
 * carried the dead child's task ids into the new one — with no payload able to
 * correct it, since the new child emits nothing at startup.
 *
 * Every claim here is paired with the control that produces the opposite on the
 * same rig, because the subject is an ABSENCE (a stale id no longer being held).
 */
describe('a respawned child gets a fresh background-task level', () => {
  /** The SDK's own level payload. `tasks` REPLACES the set. */
  function backgroundTasksChanged(...tasks: Array<{ id: string; description: string }>): unknown {
    return {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: tasks.map(task => ({
        task_id: task.id,
        task_type: 'bash_background',
        description: task.description,
      })),
      uuid: `uuid-bg-${tasks.map(task => task.id).join('-') || 'empty'}`,
      session_id: 'fake-live-session',
    };
  }

  const infoTexts = (events: AgentEvent[]): string[] => events
    .filter((event): event is AgentEvent & { message: string } => event.type === 'info')
    .map(event => event.message);

  it('the loss is ANNOUNCED rather than dropped when the child is replaced', async () => {
    const agent = makeAgent();

    // Turn 1 leaves one background task tracked by the adapter.
    scripts.push(async function* withBackgroundTask() {
      yield backgroundTasksChanged({ id: 'task-a', description: 'long build' });
      yield assistantMessage('started it');
      yield resultMessage();
    });
    const first = await runTurn(agent, 'run the build in the background');
    expect(infoTexts(first).some(text => text.includes('Background task started'))).toBe(true);

    // A drifted construction option with no live setter — the same respawn lever
    // the file's reuse control uses.
    agent.setThinkingLevel('off');
    const second = await runTurn(agent, 'anything else');

    expect(sessions).toHaveLength(2);
    expect(infoTexts(second)).toContain(
      'A background task did not survive the Claude session restart.',
    );
  });

  it('THE CONTROL: no respawn, no notice — and the task is still tracked', async () => {
    // Without this the assertion above proves only that the string can be
    // produced, not that a RESPAWN is what produces it.
    const agent = makeAgent();

    scripts.push(async function* withBackgroundTask() {
      yield backgroundTasksChanged({ id: 'task-a', description: 'long build' });
      yield assistantMessage('started it');
      yield resultMessage();
    });
    await runTurn(agent, 'run the build in the background');

    // Same second turn, no drifted option: the child is REUSED.
    const second = await runTurn(agent, 'anything else');

    expect(sessions).toHaveLength(1);
    expect(infoTexts(second).some(text => text.includes('did not survive'))).toBe(false);

    // And the level really is still held — a repeated identical payload stays
    // silent, which is only possible if `task-a` is still in the set.
    scripts.push(async function* repeatSamePayload() {
      yield backgroundTasksChanged({ id: 'task-a', description: 'long build' });
      yield assistantMessage('still going');
      yield resultMessage();
    });
    const third = await runTurn(agent, 'and again');
    expect(infoTexts(third).some(text => text.includes('Background task started'))).toBe(false);
  });

  it('the stale level no longer makes the NEW child announce a finish it never had', async () => {
    // The second lie, in the opposite direction: `hadTasks` was computed from
    // the dead child's ids, so the first EMPTY payload out of a fresh child
    // announced "Background tasks finished." for a process that never ran one.
    const agent = makeAgent();

    scripts.push(async function* withBackgroundTask() {
      yield backgroundTasksChanged({ id: 'task-a', description: 'long build' });
      yield assistantMessage('started it');
      yield resultMessage();
    });
    await runTurn(agent, 'run the build in the background');

    agent.setThinkingLevel('off');
    scripts.push(async function* freshChildReportsNothingRunning() {
      yield backgroundTasksChanged();
      yield assistantMessage('ok');
      yield resultMessage();
    });
    const second = await runTurn(agent, 'anything else');

    expect(sessions).toHaveLength(2);
    expect(infoTexts(second)).not.toContain('Background tasks finished.');
  });

  it('THE PRESENCE: a real finish inside ONE child still says so', async () => {
    // The assertion above is an absence, so the same rig has to produce the
    // presence — otherwise "no finish line" would be satisfied by a build that
    // never emits one at all.
    const agent = makeAgent();

    scripts.push(async function* withBackgroundTask() {
      yield backgroundTasksChanged({ id: 'task-a', description: 'long build' });
      yield assistantMessage('started it');
      yield resultMessage();
    });
    await runTurn(agent, 'run the build in the background');

    scripts.push(async function* sameChildReportsItFinished() {
      yield backgroundTasksChanged();
      yield assistantMessage('done');
      yield resultMessage();
    });
    const second = await runTurn(agent, 'anything else');

    expect(sessions).toHaveLength(1);
    expect(infoTexts(second)).toContain('Background tasks finished.');
  });
});
