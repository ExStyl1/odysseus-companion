/**
 * P3.5 — R18 turn-level structured output on the codex backend.
 *
 * Before this, `turn/start` carried `{threadId, input}` and nothing else, so a
 * `sendMessage({outputSchema})` reached codex as an ordinary prose turn and the
 * caller got prose back while every other runtime honoured the schema. Codex
 * has the wire for it: `TurnStartParams.outputSchema` is "Optional JSON Schema
 * used to constrain the final assistant message for this turn"
 * (`codex-protocol/schema/v2/TurnStartParams.json`, bindings
 * `generated/v2/TurnStartParams.ts:45`, both from the rust-v0.148.0 tag
 * `codex-protocol/manifest.json` pins the bundled binary to).
 *
 * The two things worth pinning are therefore the SEND — the host's schema
 * really rides that request — and the MAP-BACK, which is not codex's contract
 * but the HOST's: `structuredOutputSubtype` / `structuredOutput` /
 * `structuredOutputErrors` on the `complete` event, the same three fields the
 * Claude adapter fills from the SDK's result message
 * (`backend/claude/event-adapter.ts:898`) and Pi's subprocess enriches onto
 * `agent_end`, read by exactly one consumer (`apps/cli/src/index.ts:792`).
 *
 * The violation row is the one that has to exist even though codex does the
 * constraining itself: `TurnStartParams` declares no
 * `additionalProperties: false`, so an app-server older than the field accepts
 * the request and IGNORES it — the schema is then unenforced and NOTHING says
 * so. Validating the final message host-side (with the shared R18 validator, the
 * same `packages/shared/src/structured-output` Pi's loop uses) is what turns
 * that silence into the documented violation arm.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig, ChatOptions } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent, itemBelongsToTurn, readCodexAgentMessageText } from '../codex-agent.ts';
import { createMockCapabilityTurnRuntime } from './test-utils.ts';

const WORKSPACE_ID = 'ws-codex-structured';
const SESSION_ID = 'session-codex-structured';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };
const THREAD = 'thread-1';

/** The caller's schema. `additionalProperties: false` gives the violation row a second way to fail. */
const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['verdict', 'confidence'],
  additionalProperties: false,
} as const;

interface Recorded { method: string; params: any }

interface Harness {
  agent: CodexAgent;
  requests: Recorded[];
  /** Text of the assistant message the fake app-server answers a turn with; null = no message at all. */
  setReply: (text: string | null) => void;
  /**
   * Send a SECOND `turn/completed` on the same sink, the way a server-side
   * auto-compaction turn on this thread does. The sink buffers past `finish()`,
   * so both completions really are delivered to the turn.
   */
  setDoubleCompletion: (on: boolean) => void;
  /**
   * Emit an `agentMessage` belonging to a DIFFERENT turn on this same thread,
   * after our own — the shape a server-side auto-compaction turn has. Not a
   * foreign THREAD: `isForeignThreadNotification` already stops those.
   */
  setForeignTurnReply: (text: string | null) => void;
  /** Press Stop between the assistant message and `turn/completed`. */
  setAbortBeforeCompletion: (on: boolean) => void;
}

/**
 * The fake app-server: `turn/start` answers with one `item/completed` carrying
 * an `agentMessage`, then `turn/completed`. Both are thread-attributed, because
 * `isForeignThreadNotification` drops anything that is not this session's
 * thread and a mis-tagged fixture would silently test nothing.
 */
function createHarness(): Harness {
  cleanupModeState(SESSION_KEY);
  const requests: Recorded[] = [];
  let reply: string | null = '';
  let foreignTurnReply: string | null = null;
  let abortBeforeCompletion = false;
  let doubleCompletion = false;
  let itemSeq = 0;

  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Codex Structured Workspace',
      rootPath: '/tmp/ws-codex-structured-root',
      workspaceRootPath: '/tmp/ws-codex-structured-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-structured',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-codex-structured-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };

  const agent = new CodexAgent(config);
  const client = {
    request(method: string, params: any) {
      requests.push({ method, params });
      if (method === 'turn/start') {
        itemSeq += 1;
        const turnId = `turn-${itemSeq}`;
        queueMicrotask(() => {
          // The app-server announces the turn it just opened; this is what the
          // structured obligation pins itself to.
          (agent as any).handleNotification('turn/started', {
            threadId: THREAD,
            turn: { id: turnId, items: [], itemsView: 'complete', status: 'inProgress', error: null },
          });
          if (reply !== null) {
            (agent as any).handleNotification('item/completed', {
              threadId: THREAD,
              turnId,
              completedAtMs: Date.now(),
              item: { type: 'agentMessage', id: `msg-${itemSeq}`, text: reply, phase: null, memoryCitation: null },
            });
          }
          if (foreignTurnReply !== null) {
            (agent as any).handleNotification('item/completed', {
              threadId: THREAD,
              turnId: `${turnId}-compaction`,
              completedAtMs: Date.now(),
              item: { type: 'agentMessage', id: `msg-${itemSeq}-compaction`, text: foreignTurnReply, phase: null, memoryCitation: null },
            });
          }
          if (abortBeforeCompletion) agent.forceAbort('user_stop' as never);
          const completed = {
            threadId: THREAD,
            turn: { id: turnId, items: [], itemsView: 'complete', status: 'completed', error: null },
          };
          (agent as any).handleNotification('turn/completed', completed);
          if (doubleCompletion) (agent as any).handleNotification('turn/completed', completed);
        });
      }
      return Promise.resolve({ thread: { id: THREAD } });
    },
    notify() {},
    close() {},
  };
  (agent as any).ensureRuntime = async () => {
    (agent as any).client = client;
    (agent as any).threadId = THREAD;
  };
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    provider: 'codex-runtime',
  }));

  return {
    agent,
    requests,
    setReply: text => { reply = text; },
    setDoubleCompletion: on => { doubleCompletion = on; },
    setForeignTurnReply: text => { foreignTurnReply = text; },
    setAbortBeforeCompletion: on => { abortBeforeCompletion = on; },
  };
}

async function drainChat(agent: CodexAgent, prompt: string, options?: ChatOptions): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.chat(prompt, undefined, options)) events.push(event);
  return events;
}

function completeOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'complete' }> {
  const complete = events.find(e => e.type === 'complete');
  if (!complete) throw new Error(`no complete event in [${events.map(e => e.type).join(', ')}]`);
  return complete as Extract<AgentEvent, { type: 'complete' }>;
}

function turnStarts(requests: Recorded[]): Recorded[] {
  return requests.filter(entry => entry.method === 'turn/start');
}

afterEach(() => cleanupModeState(SESSION_KEY));

describe('CodexAgent structured outputs — the schema on the wire', () => {
  it('threads the host schema onto turn/start and maps a conforming final message back', async () => {
    const h = createHarness();
    try {
      h.setReply('{"verdict":"ship it","confidence":0.9}');

      const events = await drainChat(h.agent, 'grade this diff', { outputSchema: SCHEMA as unknown as Record<string, unknown> });

      // THE SEND: the caller's schema object, unaltered, under the protocol's
      // own field name — not stringified and not re-shaped.
      const starts = turnStarts(h.requests);
      expect(starts).toHaveLength(1);
      expect(starts[0]!.params.outputSchema).toEqual(SCHEMA);

      // THE MAP-BACK: the host contract's success arm — the PARSED value, not
      // the text, because that is what `apps/cli/src/index.ts:792` prints.
      const complete = completeOf(events);
      expect(complete.structuredOutputSubtype).toBe('success');
      expect(complete.structuredOutput).toEqual({ verdict: 'ship it', confidence: 0.9 });
      expect('structuredOutputErrors' in complete).toBe(false);
      expect(complete.terminalReason).toBeUndefined();
    } finally {
      h.agent.destroy();
    }
  });

  it('reports the documented violation arm when the final message does not match the schema', async () => {
    // What an app-server that ignored `outputSchema` produces: a reply that is
    // JSON but not the caller's JSON. Without the host-side check this arrived
    // as a plain `complete` and the caller could not tell it apart from success.
    const h = createHarness();
    try {
      h.setReply('{"verdict":"ship it"}');

      const events = await drainChat(h.agent, 'grade this diff', { outputSchema: SCHEMA as unknown as Record<string, unknown> });

      const complete = completeOf(events);
      expect(complete.structuredOutputSubtype).toBe('error_max_structured_output_retries');
      expect(complete.structuredOutput).toBeUndefined();
      expect(complete.structuredOutputErrors).toEqual(["$ must have required property 'confidence'"]);
      // The terminal reason the Claude adapter maps its own exhaustion subtype
      // to (`backend/claude/event-adapter.ts:100`), so the session layer
      // classifies a codex violation the same way.
      expect(complete.terminalReason).toBe('structured_output_retry_exhausted');
    } finally {
      h.agent.destroy();
    }
  });

  it('reports free prose as a violation too, rather than passing it off as an answer', async () => {
    // The OTHER shape an unenforced schema produces, and the more likely one:
    // the model simply talks. `validateStructuredOutputText` fails at the parse
    // step, which is why the errors list names JSON and not a schema keyword.
    const h = createHarness();
    try {
      h.setReply('Looks good to me — ship it.');

      const events = await drainChat(h.agent, 'grade this diff', { outputSchema: SCHEMA as unknown as Record<string, unknown> });

      const complete = completeOf(events);
      expect(complete.structuredOutputSubtype).toBe('error_max_structured_output_retries');
      expect(complete.structuredOutputErrors?.[0]).toContain('result is not valid JSON');
    } finally {
      h.agent.destroy();
    }
  });

  it('a turn that produced no assistant message takes the success-without-output arm', async () => {
    // Pi's documented third case, word for word
    // (`pi-agent-server/src/index.ts`'s `runTurnStructuredOutputValidation`),
    // because the CLI's `else` branch is what tells these apart from a violation.
    const h = createHarness();
    try {
      h.setReply(null);

      const events = await drainChat(h.agent, 'grade this diff', { outputSchema: SCHEMA as unknown as Record<string, unknown> });

      const complete = completeOf(events);
      expect(complete.structuredOutputSubtype).toBe('success');
      expect(complete.structuredOutput).toBeUndefined();
      expect(complete.structuredOutputErrors).toEqual(['run completed without a structured output']);
    } finally {
      h.agent.destroy();
    }
  });

  it('refuses an invalid schema before starting a turn, instead of running it unconstrained', async () => {
    // A schema-less turn that the caller believes is constrained is the one
    // failure a structured caller cannot detect, so the named gate error ends
    // the turn. `$schema` naming a newer draft is the documented rejection
    // (`structured-output/validator.ts`).
    const h = createHarness();
    try {
      const events = await drainChat(h.agent, 'grade this diff', {
        outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' } as unknown as Record<string, unknown>,
      });

      expect(turnStarts(h.requests)).toHaveLength(0);
      const error = events.find(e => e.type === 'error') as { message: string } | undefined;
      expect(error?.message).toContain('invalid structured-output schema: ');
      // …and the turn still ENDS, or `sendMessage` finalizes as `interrupted`.
      expect(events.at(-1)?.type).toBe('complete');
    } finally {
      h.agent.destroy();
    }
  });

  it('leaves a schema-less turn byte-identical, before AND after a schema-bearing one', async () => {
    // The field is absent (not `undefined`) on both the wire and the event when
    // nobody asked for a schema, and a schema-bearing turn in between changes
    // neither. The "after" half is the one worth running: a `compiled` that
    // outlived its turn would validate the NEXT turn's prose and fail it for a
    // schema its caller never sent.
    const h = createHarness();
    try {
      h.setReply('plain prose, no schema in sight');
      const before = await drainChat(h.agent, 'just talk to me');
      expect('outputSchema' in turnStarts(h.requests)[0]!.params).toBe(false);
      expect(completeOf(before)).toEqual({ type: 'complete' });

      h.setReply('{"verdict":"ship it","confidence":0.9}');
      const schemaTurn = await drainChat(h.agent, 'grade this diff', { outputSchema: SCHEMA as unknown as Record<string, unknown> });
      expect(completeOf(schemaTurn).structuredOutputSubtype).toBe('success');

      h.setReply('back to prose');
      const after = await drainChat(h.agent, 'just talk to me again');
      expect('outputSchema' in turnStarts(h.requests)[2]!.params).toBe(false);
      expect(completeOf(after)).toEqual({ type: 'complete' });
    } finally {
      h.agent.destroy();
    }
  });

  it('still reports the result when a SECOND turn/completed reaches the same sink', async () => {
    // A `turn/completed` this client did not start — a server-side compaction
    // turn on this thread — lands on the still-open sink, and the sink buffers
    // past `finish()`. The caller nonetheless sees ONE `complete`, because
    // `BaseAgent.chat`'s pass loop holds back every reason-free `complete` and
    // yields only the LAST one (`base-agent.ts:3982`) — which is why the
    // structured mapping must NOT be one-shot. It was, and this exact fixture
    // is what measured it: the held second completion arrived bare and the
    // caller's turn carried no structured result at all.
    const h = createHarness();
    try {
      h.setReply('{"verdict":"ship it","confidence":0.9}');
      h.setDoubleCompletion(true);

      const events = await drainChat(h.agent, 'grade this diff', { outputSchema: SCHEMA as unknown as Record<string, unknown> });

      const completes = events.filter(e => e.type === 'complete');
      expect(completes).toHaveLength(1);
      expect((completes[0] as any).structuredOutputSubtype).toBe('success');
      expect((completes[0] as any).structuredOutput).toEqual({ verdict: 'ship it', confidence: 0.9 });
    } finally {
      h.agent.destroy();
    }
  });

  it('a stopped turn is reported as stopped, not as a structured-output failure', async () => {
    // Pi's loop forwards its held `agent_end` UNENRICHED on abort
    // (`pi-agent-server/src/index.ts:4043`); this arm was missing. `abort()`
    // sets the flag, AWAITS `turn/interrupt`, and only then finishes the sink,
    // so a `turn/completed` inside that await reaches the mapper with the
    // turn's text truncated — here, never valid JSON at all. Without the arm a
    // user's Stop is reported back to them as "could not produce valid
    // structured output", which is a statement about their schema and is false.
    const h = createHarness();
    try {
      h.setReply('I was halfway through when');
      h.setAbortBeforeCompletion(true);

      const events = await drainChat(h.agent, 'grade this diff', { outputSchema: SCHEMA as unknown as Record<string, unknown> });

      const complete = completeOf(events);
      expect('structuredOutputSubtype' in complete).toBe(false);
      expect('structuredOutputErrors' in complete).toBe(false);
      expect(complete.terminalReason).toBeUndefined();
    } finally {
      h.agent.destroy();
    }
  });

  it('ignores an agentMessage from ANOTHER turn on the same thread', async () => {
    // `isForeignThreadNotification` separates THREADS; a server-side
    // auto-compaction turn runs on OURS, so its `agentMessage` is not foreign
    // by that test and would otherwise overwrite the answer being validated —
    // and because the mapping is deliberately not one-shot, the last complete
    // the caller sees would carry the wrong turn's text.
    const h = createHarness();
    try {
      h.setReply('{"verdict":"ship it","confidence":0.9}');
      h.setForeignTurnReply('Compacted the conversation.');

      const events = await drainChat(h.agent, 'grade this diff', { outputSchema: SCHEMA as unknown as Record<string, unknown> });

      const complete = completeOf(events);
      expect(complete.structuredOutputSubtype).toBe('success');
      expect(complete.structuredOutput).toEqual({ verdict: 'ship it', confidence: 0.9 });
    } finally {
      h.agent.destroy();
    }
  });
});

describe('itemBelongsToTurn', () => {
  it('degrades to a match on every shape that carries no evidence of another turn', () => {
    // An UNPINNED obligation and an UNREADABLE `turnId` both mean "no evidence
    // this is someone else's turn". Refusing on no evidence would report
    // "run completed without a structured output" for a turn that answered.
    expect(itemBelongsToTurn({ turnId: 'turn-1' }, 'turn-1')).toBe(true);
    expect(itemBelongsToTurn({ turnId: 'turn-2' }, 'turn-1')).toBe(false);
    expect(itemBelongsToTurn({ turnId: 'turn-2' }, null)).toBe(true);
    expect(itemBelongsToTurn({ turnId: '' }, 'turn-1')).toBe(true);
    expect(itemBelongsToTurn({}, 'turn-1')).toBe(true);
    expect(itemBelongsToTurn(undefined, 'turn-1')).toBe(true);
  });
});

describe('readCodexAgentMessageText', () => {
  it('reads the assistant arm of ThreadItem and nothing else', () => {
    // `ThreadItem`'s `plan` and `reasoning` arms carry text too
    // (`codex-protocol/generated/v2/ThreadItem.ts:30`). Validating a reasoning
    // summary against the caller's schema would fail a turn whose real answer
    // was fine, so every other arm must read as absent.
    expect(readCodexAgentMessageText({ item: { type: 'agentMessage', id: 'm1', text: '{"a":1}' } })).toBe('{"a":1}');
    expect(readCodexAgentMessageText({ item: { type: 'agentMessage', id: 'm1', text: '' } })).toBe('');
    expect(readCodexAgentMessageText({ item: { type: 'plan', id: 'p1', text: 'step one' } })).toBeNull();
    expect(readCodexAgentMessageText({ item: { type: 'reasoning', id: 'r1', summary: ['why'], content: [] } })).toBeNull();
    expect(readCodexAgentMessageText({ item: { type: 'agentMessage', id: 'm1' } })).toBeNull();
    expect(readCodexAgentMessageText({})).toBeNull();
    expect(readCodexAgentMessageText(undefined)).toBeNull();
  });
});
