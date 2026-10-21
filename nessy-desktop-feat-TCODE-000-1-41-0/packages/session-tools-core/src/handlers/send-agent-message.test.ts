/**
 * `send_agent_message` is TEXT between two models.
 *
 * `cross-session-messaging.md`: "A message is a piece of text one Claude writes
 * to another, never conversation history or files." The two halves of that
 * sentence are pinned here — the `attachments` field is gone from the wire
 * schema, and the delivered payload is one string whose head names the sender so
 * the receiver can answer without a second structured field.
 */
import { describe, expect, test } from 'bun:test';

import { handleSendAgentMessage, CROSS_SESSION_MESSAGE_CHAR_LIMIT } from './send-agent-message.ts';
import { SendAgentMessageSchema, TOOL_DESCRIPTIONS } from '../tool-defs.ts';
import type { AgentMessageDeliveryVerdict, SessionToolContext } from '../context.ts';

function contextWith(
  sessionId = 'parent',
  name = 'Parent',
  verdict: AgentMessageDeliveryVerdict = { status: 'delivered' },
) {
  const sent: unknown[][] = [];
  const ctx = {
    sessionId,
    getSessionInfo: () => ({ name }),
    sendAgentMessage: async (...args: unknown[]) => { sent.push(args); return verdict; },
  } as unknown as SessionToolContext;
  return { ctx, sent };
}

describe('the wire schema carries text only', () => {
  test('a plain sessionId + message pair validates', () => {
    expect(SendAgentMessageSchema.safeParse({ sessionId: 'child', message: 'hello' }).success).toBe(true);
  });

  test('attachments are rejected rather than silently dropped', () => {
    const parsed = SendAgentMessageSchema.safeParse({
      sessionId: 'child',
      message: 'hello',
      attachments: [{ path: '/etc/passwd' }],
    });
    expect(parsed.success).toBe(false);
  });

  test('the description states how the message is delivered — and claims no more', () => {
    const description = TOOL_DESCRIPTIONS.send_agent_message;
    expect(description).toContain('task notification');
    expect(description).toContain('anti-injection envelope');
    expect(description).toContain('never as unlabelled human input');
    expect(description.toLowerCase()).toContain('no files');
    // The envelope rides INSIDE a transport-level `role:'user'` entry, exactly
    // as every other task-notification producer does, so the description must
    // not promise the message is not a user message at all.
    expect(description).not.toContain('never as a user message');
  });

  test('the description names the machine boundary the schema cannot express', () => {
    // P6.526 — `SendAgentMessageArgs` is `{ sessionId, message }` and carries no
    // machine or account dimension, so a model reading the description alone had
    // no way to learn that cross-machine addressing is absent; it met the
    // resolution failure instead. Delegated decision Q-den 63 chose option (a)
    // (same-machine only, said plainly) over a relay, so this sentence IS the
    // remedy — there is nothing to fall back to.
    const description = TOOL_DESCRIPTIONS.send_agent_message;
    expect(description).toContain('Only a session on this machine can be addressed');
    expect(description).toContain('no machine or account dimension');
    // The claim is about all three runtimes, not about Pi: the chokepoint is
    // `SessionManager`'s workspace resolution, which every runtime shares.
    expect(description).toContain('on any runtime');
  });

  test('the description promises no cross-machine or relay route', () => {
    // The negative half. The vendor page advertises a cross-machine leg that
    // travels through Anthropic servers and excludes our configuration by name;
    // a description hinting at one would send a model looking for a route this
    // product does not have. NOT asserted: the absence of the word "relay" —
    // the second paragraph legitimately says "relay information between
    // sessions" about the same-machine case, and a guard on the bare word would
    // have fired on copy that is correct.
    const description = TOOL_DESCRIPTIONS.send_agent_message.toLowerCase();
    expect(description).not.toContain('remote control');
    expect(description).not.toContain('another machine can be reached');
    expect(description).not.toContain('relay to another machine');
  });
});

describe('the delivered payload', () => {
  test('is exactly two arguments — the target and one string', async () => {
    const { ctx, sent } = contextWith();
    const result = await handleSendAgentMessage(ctx, { sessionId: 'child', message: 'hello' });

    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    expect(sent[0]![0]).toBe('child');
  });

  test('leads with the sender identity and the reply address', async () => {
    const { ctx, sent } = contextWith('parent', 'Parent');
    await handleSendAgentMessage(ctx, { sessionId: 'child', message: 'hello' });

    const text = String(sent[0]![1]);
    expect(text.startsWith('[Message from session "parent" (Parent)]')).toBe(true);
    expect(text).toContain('Use send_agent_message with sessionId "parent" to reply.');
    expect(text.endsWith('hello')).toBe(true);
  });
});

describe('the pre-flight refusals are unchanged', () => {
  test('a session cannot message itself', async () => {
    const { ctx, sent } = contextWith('parent');
    const result = await handleSendAgentMessage(ctx, { sessionId: 'parent', message: 'hello' });
    expect(result.isError).toBe(true);
    expect(sent).toEqual([]);
  });

  test('an empty message is refused', async () => {
    const { ctx, sent } = contextWith();
    const result = await handleSendAgentMessage(ctx, { sessionId: 'child', message: '   ' });
    expect(result.isError).toBe(true);
    expect(sent).toEqual([]);
  });
});

/**
 * P6.45 — the sender learns what the receiver did with the message.
 *
 * `cross-session-messaging.md` §Limitations: "When the rate limit, repeat check,
 * or queue cap drops a message from an interactive session on this machine,
 * Claude Code tells that session which one dropped it and tells its Claude not
 * to resend right away." The same page names the shape this replaces: "Before
 * v2.1.236, Claude Code reported those sends as sent while the receiving session
 * dropped them."
 */
describe('a message the receiver did not take is not reported as sent', () => {
  test('a drop reports as an error carrying the guard that did it', async () => {
    const { ctx } = contextWith('parent', 'Parent', {
      status: 'dropped',
      note: 'The repeat check dropped it. Do not resend right away.',
    });
    const result = await handleSendAgentMessage(ctx, { sessionId: 'child', message: 'ping' });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('repeat check');
    expect(JSON.stringify(result)).toContain('not resend');
  });

  test('a hold and a refusal are distinguishable, and neither reads as delivered', async () => {
    for (const status of ['held', 'refused'] as const) {
      const { ctx } = contextWith('parent', 'Parent', { status, note: `it was ${status}` });
      const result = await handleSendAgentMessage(ctx, { sessionId: 'child', message: 'ping' });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(status);
    }
  });

  test('the delivered case still reports success — the guard has not swallowed the happy path', async () => {
    const { ctx, sent } = contextWith();
    const result = await handleSendAgentMessage(ctx, { sessionId: 'child', message: 'ping' });
    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

/**
 * P6.465 (N8) · the size cap, which is the one of the page's three caps that
 * cannot live on the receiving side: "Claude Code refuses a message to a session
 * on this machine once its serialized form passes about a million characters"
 * — "in the sending session, before it leaves" — and the failure it replaces is
 * silent loss: "Before v2.1.235, Claude Code reported an oversized message as
 * sent. The receiving session dropped it unread."
 */
describe('an over-sized message is refused before it leaves', () => {
  test('names both sizes and never reaches the host', async () => {
    const { ctx, sent } = contextWith();
    const result = await handleSendAgentMessage(ctx, {
      sessionId: 'child',
      message: 'x'.repeat(CROSS_SESSION_MESSAGE_CHAR_LIMIT + 1),
    });
    expect(result.isError).toBe(true);
    const text = String(result.content?.[0]?.text ?? '');
    expect(text).toContain('Message too large for cross-session delivery');
    expect(text).toContain('1,048,576');
    // The ACTUAL size, not just the limit — the documented refusal names both so
    // the model can tell how much to cut.
    expect(text).toMatch(/is 1,048,[0-9]{3} characters/);
    // "Nothing reaches the receiving session."
    expect(sent).toEqual([]);
  });

  // The boundary in the other direction: a message that fits is dispatched. The
  // envelope is measured, not the caller's text, so this sits just under.
  test('a message just under the cap is dispatched', async () => {
    const { ctx, sent } = contextWith();
    const result = await handleSendAgentMessage(ctx, {
      sessionId: 'child',
      message: 'x'.repeat(CROSS_SESSION_MESSAGE_CHAR_LIMIT - 1_000),
    });
    expect(result.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
  });
});

/**
 * P6.465 (N6) · `notify_when_idle` on the tool's own surface.
 *
 * "Claude subscribes with the `SendMessage` tool's `notify_when_idle` input,
 * either attached to a message it's sending anyway or on its own."
 */
describe('notify_when_idle', () => {
  test('the schema accepts it, alone or attached, and still rejects a stray key', () => {
    expect(SendAgentMessageSchema.safeParse({ sessionId: 'child', notify_when_idle: true }).success).toBe(true);
    expect(SendAgentMessageSchema.safeParse({ sessionId: 'child', message: 'hi', notify_when_idle: true }).success).toBe(true);
    // `.strict()` still holds: relaxing `message` must not open the object up.
    expect(SendAgentMessageSchema.safeParse({ sessionId: 'child', notify_when_idle: true, attachments: [] }).success).toBe(false);
  });

  test('subscribing on its own sends no message and reports the subscription', async () => {
    const { ctx, sent } = contextWith('parent', 'Parent', {
      status: 'delivered',
      subscription: { status: 'subscribed', note: 'Session child will send one notice when it next goes idle or exits.' },
    });
    const result = await handleSendAgentMessage(ctx, { sessionId: 'child', notify_when_idle: true });
    expect(result.isError).toBeFalsy();
    expect(String(result.content?.[0]?.text ?? '')).toContain('one notice');
    // The host is still called — it owns the subscription — but with an EMPTY
    // body, which is what "without starting a turn or spending tokens in the
    // watched session" means one layer down.
    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toBe('');
    expect(sent[0]![2]).toEqual({ notifyWhenIdle: true });
  });

  test('a message with no subscription request still passes no options', async () => {
    const { ctx, sent } = contextWith();
    await handleSendAgentMessage(ctx, { sessionId: 'child', message: 'hello' });
    expect(sent[0]![2]).toBeUndefined();
  });

  /**
   * The asymmetry the page states and the reason `subscription` is a field of
   * its own: "When a subagent or an agent team teammate sets `notify_when_idle`,
   * Claude Code makes no subscription and tells it so" — the message it rode on
   * is unaffected, so a refused subscription must NOT be reported as a failed
   * send.
   */
  test('a refused subscription does not turn a delivered message into a failure', async () => {
    const { ctx } = contextWith('parent', 'Parent', {
      status: 'delivered',
      subscription: { status: 'refused', note: 'No idle notice was set up: only the main conversation can subscribe.' },
    });
    const result = await handleSendAgentMessage(ctx, { sessionId: 'child', message: 'hello', notify_when_idle: true });
    expect(result.isError).toBeFalsy();
    const text = String(result.content?.[0]?.text ?? '');
    expect(text).toContain('Message sent to session child');
    expect(text).toContain('No idle notice was set up');
  });

  test('a refusal of the WHOLE call is reported as a failure, message included', async () => {
    const { ctx } = contextWith('parent', 'Parent', {
      status: 'refused',
      note: 'Session child is an agent running inside another session.',
      subscription: { status: 'refused', note: 'Nothing was sent — resend without notify_when_idle.' },
    });
    const result = await handleSendAgentMessage(ctx, { sessionId: 'child', message: 'hello', notify_when_idle: true });
    expect(result.isError).toBe(true);
    expect(String(result.content?.[0]?.text ?? '')).toContain('was not delivered');
  });

  test('message stays required for an ordinary send', async () => {
    const { ctx, sent } = contextWith();
    const result = await handleSendAgentMessage(ctx, { sessionId: 'child' });
    expect(result.isError).toBe(true);
    expect(String(result.content?.[0]?.text ?? '')).toContain('message is required');
    expect(sent).toEqual([]);
  });
});

/**
 * C3.224 (= row D1.80 of the integrations plan, carried from P6.464) — address a
 * session by NAME.
 *
 * `cross-session-messaging.md#message-another-session`, verbatim (the anchor this
 * citation used to carry was minted from the paragraph lead-in *"To name the
 * target yourself"*, which is not a heading and gets no id — the page publishes
 * the sentence inside this section instead; re-measured 2026-09-12 by W18-e, and
 * the dead spelling is named in words here on purpose, because writing it as a
 * page name followed by a hash and the anchor would keep the guard firing on its
 * own repair -- and so is THIS sentence, because the placeholder that named that
 * form was itself read as a citation to a page called `page` and re-created the
 * finding one line further on): *"Claude Code
 * inserts the mention, such as `@api-worker`, and tells Claude which session it
 * names, so Claude can message that session without listing your sessions
 * first."* And `#see-which-sessions-claude-can-reach`: *"One session answers to
 * the name: Claude Code delivers the message on the name alone."*
 */
function contextWithRoster(rows: { id: string; name: string; status?: string }[], total?: number) {
  const sent: unknown[][] = [];
  const listed: unknown[] = [];
  const ctx = {
    sessionId: 'parent',
    getSessionInfo: (id?: string) =>
      (id === undefined || rows.some(row => row.id === id) ? { name: 'Parent' } : null),
    listSessions: (options?: unknown) => {
      listed.push(options);
      return {
        total: total ?? rows.length,
        returned: rows.length,
        sessions: rows.map(row => ({
          id: row.id,
          name: row.name,
          labels: [],
          status: row.status ?? 'active',
          createdAt: 0,
        })),
      };
    },
    sendAgentMessage: async (...args: unknown[]) => { sent.push(args); return { status: 'delivered' as const }; },
  } as unknown as SessionToolContext;
  return { ctx, sent, listed };
}

describe('addressing a session by name (C3.224)', () => {
  test('one unambiguous live match sends, with no confirmation step', async () => {
    const { ctx, sent } = contextWithRoster([
      { id: 'sess-1', name: 'api-worker' },
      { id: 'sess-2', name: 'payments' },
    ]);

    const result = await handleSendAgentMessage(ctx, { sessionId: 'api-worker', message: 'schema done' });

    expect(result.isError).toBeFalsy();
    // Delivered to the ID the name resolved to, not to the name.
    expect(sent[0]?.[0]).toBe('sess-1');
    expect(String(sent[0]?.[1])).toContain('schema done');
  });

  test('an ID still wins over the name lookup, and costs no listing at all', async () => {
    const { ctx, sent, listed } = contextWithRoster([
      { id: 'sess-1', name: 'api-worker' },
    ]);

    await handleSendAgentMessage(ctx, { sessionId: 'sess-1', message: 'by id' });

    expect(sent[0]?.[0]).toBe('sess-1');
    // The ID question is asked first, so the roster is never read. This is also
    // the control for the two cases below, where `listed` is non-empty.
    expect(listed).toEqual([]);
  });

  test('an ambiguous name refuses BY NAME and sends nothing', async () => {
    const { ctx, sent } = contextWithRoster([
      { id: 'sess-1', name: 'api-worker', status: 'active' },
      { id: 'sess-2', name: 'api-worker', status: 'idle' },
    ]);

    const result = await handleSendAgentMessage(ctx, { sessionId: 'api-worker', message: 'schema done' });

    expect(result.isError).toBe(true);
    const text = String(result.content?.[0]?.text ?? '');
    expect(text).toContain('"api-worker" is not one session');
    // Both candidates are named, so the model can re-address without a listing.
    expect(text).toContain('sess-1');
    expect(text).toContain('sess-2');
    expect(sent).toEqual([]);
  });

  test('C3.316 — the ambiguous refusal tells the model to ASK, not to choose', async () => {
    // The page assigns this decision to nobody else: "When more than one live
    // session answers to the mentioned name, Claude asks you which one you mean
    // before sending." The sentence used to end "Send again with the sessionId
    // of the one you mean", which the model cannot follow — it does not know
    // which one the user meant, so it picks, and delivering to the wrong session
    // is what the whole name-addressing half exists to prevent.
    const { ctx, sent } = contextWithRoster([
      { id: 'sess-1', name: 'api-worker', status: 'active' },
      { id: 'sess-2', name: 'api-worker', status: 'idle' },
    ]);

    const result = await handleSendAgentMessage(ctx, { sessionId: 'api-worker', message: 'schema done' });
    const text = String(result.content?.[0]?.text ?? '');

    expect(text).toContain('Ask the user which one they mean before sending');
    expect(text).toContain('do not choose one yourself');
    // NEGATIVE: the instruction that used to stand alone must not still stand
    // alone — it is the one a model follows by guessing.
    expect(text).not.toContain('Send again with the sessionId of the one you mean');
    // The candidates and their ids survive: a model told to ask needs something
    // to ask WITH, and this is the assertion that keeps the two halves together.
    expect(text).toContain('sess-1');
    expect(text).toContain('sess-2');
    expect(sent).toEqual([]);
  });

  test('a dead name refuses BY NAME rather than reaching the host with it', async () => {
    const { ctx, sent } = contextWithRoster([{ id: 'sess-1', name: 'api-worker' }]);

    const result = await handleSendAgentMessage(ctx, { sessionId: 'retired-worker', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(String(result.content?.[0]?.text ?? '')).toContain('named "retired-worker"');
    expect(sent).toEqual([]);
  });

  /**
   * `#see-which-sessions-claude-can-reach` puts truncation and ambiguity in ONE
   * arm — *"Several sessions share the name, or Claude Code couldn't check
   * everywhere your sessions run"* — because both mean the same thing to a
   * sender: the name alone does not identify one session. A lookup that answered
   * from a page it did not finish reading would be the silent wrong answer.
   */
  test('a single match from a TRUNCATED roster refuses and says the page was short', async () => {
    const { ctx, sent } = contextWithRoster([{ id: 'sess-1', name: 'api-worker' }], 900);

    const result = await handleSendAgentMessage(ctx, { sessionId: 'api-worker', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(String(result.content?.[0]?.text ?? '')).toContain('of 900 sessions were checked');
    expect(sent).toEqual([]);
  });

  test('a host that cannot answer "is this an ID" passes the string through unchanged', async () => {
    // The pre-C3.224 behaviour, and every existing caller: no roster port, so no
    // name refusal is invented on the host's behalf.
    const { ctx, sent } = contextWith('parent', 'Parent');

    await handleSendAgentMessage(ctx, { sessionId: 'whatever-this-is', message: 'hello' });

    expect(sent[0]?.[0]).toBe('whatever-this-is');
  });

  test('the description tells the model the name form exists', () => {
    const description = TOOL_DESCRIPTIONS.send_agent_message;
    expect(description).toContain('sessionId takes a session NAME as well as an ID');
    expect(SendAgentMessageSchema.shape.sessionId.description).toContain('NAME of a live session');
  });
});
