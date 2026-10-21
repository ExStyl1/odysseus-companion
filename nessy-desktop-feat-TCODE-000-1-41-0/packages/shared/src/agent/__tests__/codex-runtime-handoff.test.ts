/**
 * T1a/T1b — the runtime handoff reaches Codex as native history, not as a
 * prompt prefix.
 *
 * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`. T1a's
 * delta over the shipped behaviour was narrow: the span P2 stashes stopped
 * being trimmed to 24 messages × 1200 characters and stopped arriving inside
 * `<runtime_handoff_context>` on the first user message. **T1b (2026-08-21)
 * added the half the plan's opening motivation is about** — a `native` payload
 * now carries the ROW projection as well, so tool calls and their results cross
 * too, each as a paired `function_call` + `function_call_output`. The T1b rows
 * live at the end of this file.
 *
 * The three properties this file pins, and why each one is here:
 *
 * 1. **The plan decides, not the agent.** `planHistoryCarry` weighed the
 *    payload against the target model's context window while the modal was on
 *    screen. An agent that re-derived its own bounds could deliver something
 *    the user was never shown, so `plan: 'text'` must inject nothing.
 * 2. **The inject is the LAST RPC before `turn/start`.** Measured on the
 *    shipped rust-v0.148.0 binary: `thread/inject_items` stamps its records
 *    `internal_chat_message_metadata_passthrough: {"turn_id":"auto-compact-0"}`
 *    and never closes that turn, so a `thread/fork` after it appends a
 *    model-visible `<turn_aborted>` developer message — a false statement about
 *    the conversation.
 * 3. **A refusal falls back to text IN THE SAME TURN.** The armed payload is
 *    spent either way; a native path that silently dropped the history would be
 *    worse than the text channel it replaced.
 *
 * The wire-level proof that the injected items actually reach the model lives
 * beside this file in `codex-inject-items-e2e.test.ts`, which drives the
 * bundled binary against a loopback Responses provider. This file proves the
 * agent's own decision-making, which that one cannot isolate.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import type { BackendConfig, RuntimeHandoffPayload } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import type { AgentEvent } from '@nessy-agent/core/types';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent } from '../codex-agent.ts';
import { createMockCapabilityTurnRuntime } from './test-utils.ts';

const WORKSPACE_ID = 'ws-handoff';
const SESSION_ID = 'session-handoff';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

/** The span a pi → codex switch hands over. Two rows, both roles. */
const SPAN = [
  { type: 'user' as const, content: 'the fixture password is opal-lantern-77' },
  { type: 'assistant' as const, content: 'Noted — opal-lantern-77.' },
];

interface Recorded { method: string; params: any }

interface Harness {
  agent: CodexAgent;
  requests: Recorded[];
  applied: Array<string | undefined>;
  /** Whether the payload is still armed, the way SessionManager one-shots it. */
  armed: () => boolean;
}

/**
 * T1b's span: the same two prose rows, plus one tool pair whose result is the
 * ONLY place a second fact appears. `history` is the ROW projection
 * (`buildRuntimeHandoffHistory`), which keeps `isIntermediate` assistant rows
 * that `messages` drops — the two are deliberately different projections.
 */
const HISTORY: NonNullable<RuntimeHandoffPayload['history']> = [
  { kind: 'message', role: 'user', content: SPAN[0]!.content },
  { kind: 'message', role: 'assistant', content: 'let me check the config' },
  {
    kind: 'tool',
    callId: 'nessy_handoff_k3',
    name: 'Read',
    input: { file_path: './config.json' },
    output: 'DEPLOY_FINGERPRINT=jade-cinder-42',
  },
  { kind: 'message', role: 'assistant', content: SPAN[1]!.content },
];

function createHarness(options: {
  plan?: RuntimeHandoffPayload['plan'];
  /** T1b · attach the row projection, the way a `native` payload carries it. */
  history?: RuntimeHandoffPayload['history'];
  /** Make `thread/inject_items` reject, the way an older app-server would. */
  rejectInject?: boolean;
  /**
   * Make `thread/fork` reject: `'no-rollout'` is the app-server's refusal for
   * a thread that has never written a rollout record (measured verbatim on
   * rust-v0.147.0 AND rust-v0.148.0), `'other'` is any other fork failure.
   */
  rejectFork?: 'no-rollout' | 'other';
}): Harness {
  cleanupModeState(SESSION_KEY);
  const requests: Recorded[] = [];
  const applied: Array<string | undefined> = [];
  let handoffApplied = false;

  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Handoff Workspace',
      rootPath: '/tmp/ws-handoff-root',
      workspaceRootPath: '/tmp/ws-handoff-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-handoff',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-handoff-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
    // One-shot, exactly the way `SessionManager` arms it: gone once applied.
    getRuntimeHandoffMessages: () => (handoffApplied
      ? null
      : {
          from: 'pi',
          messages: SPAN as never,
          ...(options.plan ? { plan: options.plan } : {}),
          ...(options.history ? { history: options.history } : {}),
        }),
    markRuntimeHandoffApplied: (delivery?: string) => {
      handoffApplied = true;
      applied.push(delivery);
    },
  };

  const agent = new CodexAgent(config);
  const client = {
    request(method: string, params: any) {
      requests.push({ method, params });
      if (method === 'thread/inject_items' && options.rejectInject) {
        return Promise.reject(new Error('unknown method thread/inject_items'));
      }
      if (method === 'thread/fork' && options.rejectFork) {
        return Promise.reject(new Error(options.rejectFork === 'no-rollout'
          ? `no rollout found for thread id ${params.threadId}`
          : 'thread/fork failed for some other reason'));
      }
      if (method === 'turn/start') {
        queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
      }
      // The fallback `thread/start` answers with a DISTINCT id so a test can
      // assert the agent actually moved onto the fresh thread.
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-2' } });
      return Promise.resolve(method === 'thread/inject_items' ? {} : { thread: { id: 'thread-1' } });
    },
    notify() {},
    close() {},
  };
  (agent as any).ensureRuntime = async () => {
    (agent as any).client = client;
    (agent as any).threadId = 'thread-1';
  };
  // `chat()` (not `chatImpl`) is the seam under test, and it refuses to run
  // without a pinned turn view.
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    provider: 'codex-runtime',
  }));

  return { agent, requests, applied, armed: () => !handoffApplied };
}

async function drainChat(agent: CodexAgent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.chat(prompt)) events.push(event);
  return events;
}

function turnText(requests: Recorded[], index = 0): string {
  const turns = requests.filter(entry => entry.method === 'turn/start');
  return turns[index]?.params.input[0].text as string;
}

describe('CodexAgent delivers a native runtime handoff', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  it('injects the span as Responses items and keeps it out of the user message', async () => {
    const { agent, requests, applied, armed } = createHarness({ plan: 'native' });

    await drainChat(agent, 'what was the fixture password?');

    const inject = requests.find(r => r.method === 'thread/inject_items');
    expect(inject).toBeDefined();
    expect(inject!.params.threadId).toBe('thread-1');
    // The exact mapping: a user row is `input_text`, an assistant row is
    // `output_text`. Codex rejects the pair the other way round.
    expect(inject!.params.items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: SPAN[0]!.content }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: SPAN[1]!.content }] },
    ]);
    // The whole point: nothing crossed as text.
    const text = turnText(requests);
    expect(text).not.toContain('<runtime_handoff_context>');
    expect(text).not.toContain('opal-lantern-77');
    expect(text.endsWith('what was the fixture password?')).toBe(true);
    // Marked applied only after a VERIFIED delivery, and marked with HOW.
    expect(applied).toEqual(['native-inject']);
    expect(armed()).toBe(false);

    agent.destroy();
  });

  // Known limit 3 of the row, as a guard rather than a note: a `thread/fork`
  // AFTER an inject makes the app-server append a model-visible
  // `<turn_aborted>` developer message, because the inject's own synthetic
  // `auto-compact-0` turn is never closed. The only defence is ordering, so
  // the ordering is asserted.
  it('injects AFTER the config fork and IMMEDIATELY before the turn, with no re-fork between', async () => {
    const { agent, requests } = createHarness({ plan: 'native' });
    // Force `applySelectedPluginSkillRuntimePolicy` to fork this turn by
    // invalidating the recorded config signature, the way a plugin runtime
    // selection or a model change does.
    (agent as any).runtimeConfigSignature = 'stale-signature';

    await drainChat(agent, 'continue');

    const methods = requests.map(r => r.method);
    const fork = methods.indexOf('thread/fork');
    const inject = methods.indexOf('thread/inject_items');
    const turn = methods.indexOf('turn/start');
    expect(fork).toBeGreaterThanOrEqual(0);
    expect(inject).toBeGreaterThan(fork);
    expect(turn).toBe(inject + 1);
    // The fork moved the thread; the inject must have used the NEW id, or the
    // span would land on a thread the turn does not run against.
    expect(requests[inject]!.params.threadId).toBe(requests[turn]!.params.threadId);

    agent.destroy();
  });

  // A thread that has never written a rollout record cannot be forked — the
  // app-server refuses with `no rollout found` (measured on rust-v0.147.0 AND
  // rust-v0.148.0, so not a bump regression). Such a thread provably holds
  // nothing (a turn or an inject would have created the rollout), so a fresh
  // `thread/start` with the same cwd/model/config is a LOSSLESS replacement.
  // The product windows are real: a plugin skill invoked on the very first
  // turn of a fresh thread, or a model change before the first turn.
  it('falls back to thread/start when the fork is refused for a rollout-less thread', async () => {
    const { agent, requests } = createHarness({ plan: 'native', rejectFork: 'no-rollout' });
    ;(agent as any).runtimeConfigSignature = 'stale-signature';

    await drainChat(agent, 'continue');

    const methods = requests.map(r => r.method);
    const fork = methods.indexOf('thread/fork');
    const start = methods.indexOf('thread/start');
    const turn = methods.indexOf('turn/start');
    expect(fork).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(fork);
    expect(turn).toBeGreaterThan(start);
    // Same config layer the fork would have carried, and the agent moved onto
    // the fresh thread — the turn runs against it.
    expect(requests[start]!.params.config).toEqual(requests[fork]!.params.config);
    expect(requests[start]!.params.model).toBe(requests[fork]!.params.model);
    expect(requests[turn]!.params.threadId).toBe('thread-2');

    agent.destroy();
  });

  // Only the empty-thread refusal has a safe fallback. Any other fork error
  // still surfaces — silently restarting a thread that HAS history would
  // discard the conversation the fork exists to preserve.
  it('does not fall back on any other fork error', async () => {
    const { agent, requests } = createHarness({ plan: 'native', rejectFork: 'other' });
    ;(agent as any).runtimeConfigSignature = 'stale-signature';

    // The error propagates out of the turn as a thrown failure, exactly as it
    // did before the fallback existed.
    await expect(drainChat(agent, 'continue')).rejects.toThrow('thread/fork failed for some other reason');
    expect(requests.map(r => r.method)).not.toContain('thread/start');
    expect(requests.map(r => r.method)).not.toContain('turn/start');

    agent.destroy();
  });

  // Never twice. Injected items survive `thread/fork` byte-identically, so a
  // second delivery appends a second copy of the whole span rather than
  // restoring a lost one.
  it('delivers exactly once — a later turn injects nothing', async () => {
    const { agent, requests } = createHarness({ plan: 'native' });

    await drainChat(agent, 'first');
    await drainChat(agent, 'second');

    expect(requests.filter(r => r.method === 'thread/inject_items')).toHaveLength(1);
    expect(turnText(requests, 1)).toContain('second');
    expect(turnText(requests, 1)).not.toContain('opal-lantern-77');

    agent.destroy();
  });

  // The bound P3 owns. With `text` the agent must behave exactly as it did
  // before T1a — this is the assertion that stops the map flip from becoming a
  // blanket uncap.
  it('obeys a `text` plan: no inject, and the trimmed text block rides the message', async () => {
    const { agent, requests, applied } = createHarness({ plan: 'text' });

    await drainChat(agent, 'what was the fixture password?');

    expect(requests.some(r => r.method === 'thread/inject_items')).toBe(false);
    const text = turnText(requests);
    expect(text).toContain('<runtime_handoff_context>');
    expect(text).toContain('opal-lantern-77');
    expect(applied).toEqual(['text']);

    agent.destroy();
  });

  // A payload armed before T1a existed (or by a host with no planner) carries
  // no plan at all. Read as `text`, which is the shipped behaviour.
  it('treats a plan-less payload as text rather than as permission to inject', async () => {
    const { agent, requests } = createHarness({});

    await drainChat(agent, 'continue');

    expect(requests.some(r => r.method === 'thread/inject_items')).toBe(false);
    expect(turnText(requests)).toContain('<runtime_handoff_context>');

    agent.destroy();
  });

  // ── T1b · tool calls and results cross ─────────────────────────────────────
  //
  // The row this plan's opening motivation is about. A `native` payload carries
  // `history` as well as `messages`; a tool row becomes a PAIRED
  // `function_call` + `function_call_output`, and the pairing must be adjacent
  // and in order — an unpaired or reordered call in model-visible history is a
  // hard provider error, not a degraded read.
  it('T1b · injects a tool row as an adjacent, ordered call/output pair', async () => {
    const { agent, requests, applied } = createHarness({ plan: 'native', history: HISTORY });

    await drainChat(agent, 'what was the deploy fingerprint?');

    const inject = requests.find(r => r.method === 'thread/inject_items');
    expect(inject!.params.items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: SPAN[0]!.content }] },
      // The `isIntermediate` assistant row the TEXT projection drops — 61.8% of
      // assistant rows carry it, and they are the connective tissue between
      // tool calls (§P.2(b)).
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'let me check the config' }] },
      {
        type: 'function_call',
        name: 'Read',
        arguments: JSON.stringify({ file_path: './config.json' }),
        call_id: 'nessy_handoff_k3',
      },
      {
        type: 'function_call_output',
        call_id: 'nessy_handoff_k3',
        output: 'DEPLOY_FINGERPRINT=jade-cinder-42',
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: SPAN[1]!.content }] },
    ]);

    // Adjacency and order, asserted as such rather than only as a deep equal —
    // this is the property that breaks the provider when it is wrong.
    const items = inject!.params.items as Array<{ type: string; call_id?: string }>;
    const call = items.findIndex(i => i.type === 'function_call');
    expect(items[call + 1]!.type).toBe('function_call_output');
    expect(items[call + 1]!.call_id).toBe(items[call]!.call_id);
    // …and the history came BEFORE the new user message, which rides the turn.
    const text = turnText(requests);
    expect(text).not.toContain('jade-cinder-42');
    expect(text.endsWith('what was the deploy fingerprint?')).toBe(true);
    expect(applied).toEqual(['native-inject']);

    agent.destroy();
  });

  // The bound, restated for T1b: a `text` plan must behave exactly as it did
  // before this task, even when the payload happens to carry a row projection.
  // This is the assertion that stops the tier from leaking.
  it('T1b · a `text` plan injects nothing, and its text block carries no tool rows', async () => {
    const { agent, requests, applied } = createHarness({ plan: 'text', history: HISTORY });

    await drainChat(agent, 'what was the deploy fingerprint?');

    expect(requests.some(r => r.method === 'thread/inject_items')).toBe(false);
    const text = turnText(requests);
    expect(text).toContain('<runtime_handoff_context>');
    // The prose crosses, exactly as before…
    expect(text).toContain('opal-lantern-77');
    // …and the tool traffic does not: neither the result, nor the input, nor
    // the intermediate commentary the text projection drops.
    expect(text).not.toContain('jade-cinder-42');
    expect(text).not.toContain('config.json');
    expect(text).not.toContain('function_call');
    expect(applied).toEqual(['text']);

    agent.destroy();
  });

  // The fallback stays honest with tools in play: a refused inject still
  // delivers the TEXT projection, which carries no tool traffic. The user is
  // not told otherwise — `markRuntimeHandoffApplied` reports `text`.
  it('T1b · a refused inject falls back to the text projection, tools and all', async () => {
    const { agent, requests, applied } = createHarness({ plan: 'native', history: HISTORY, rejectInject: true });

    await drainChat(agent, 'what was the deploy fingerprint?');

    const text = turnText(requests);
    expect(text).toContain('<runtime_handoff_context>');
    expect(text).toContain('opal-lantern-77');
    expect(text).not.toContain('jade-cinder-42');
    expect(applied).toEqual(['text']);

    agent.destroy();
  });

  it('falls back to the text handoff in the SAME turn when the inject is refused', async () => {
    const { agent, requests, applied, armed } = createHarness({ plan: 'native', rejectInject: true });

    await drainChat(agent, 'what was the fixture password?');

    expect(requests.some(r => r.method === 'thread/inject_items')).toBe(true);
    // The turn still runs, and it carries the history.
    const text = turnText(requests);
    expect(text).toContain('<runtime_handoff_context>');
    expect(text).toContain('opal-lantern-77');
    // Reported as what actually crossed — `handoff`, never the attempt.
    expect(applied).toEqual(['text']);
    expect(armed()).toBe(false);

    agent.destroy();
  });
});
