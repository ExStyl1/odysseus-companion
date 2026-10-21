/**
 * P3.294 + P3.295 — the two things codex publishes that Pi and claude both show
 * and codex showed neither of.
 *
 * Every canned payload below is VERBATIM off the wire, not copied from a type:
 * shipped `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server` →
 * the real `codex-responses-adapter` → a stub upstream, 2026-09-03. The two
 * shapes that decide these tests, and that a docblock got wrong before:
 *
 * ```
 * item/started   {"item":{"type":"reasoning","id":"reasoning_resp_…","summary":[],"content":[]}}
 * item/completed {"item":{"type":"reasoning","id":"reasoning_resp_…","summary":[],
 *                 "content":["weighing the options and deciding."]}}
 * turn/plan/updated {"threadId":"…","turnId":"…","explanation":"probe plan",
 *   "plan":[{"step":"read the file","status":"completed"},
 *           {"step":"write the fix","status":"inProgress"},
 *           {"step":"run the tests","status":"pending"}]}
 * ```
 *
 * WHAT EACH TEST KILLS:
 *  - "renders reasoning through the thinking surface" dies if the
 *    `item/completed` reasoning branch is removed — the shipped defect, where
 *    both branches fell through to `return []`.
 *  - "marks it thinking, not plain commentary" dies if `isThinking` is dropped:
 *    the row would still appear, as ordinary intermediate text, eligible for the
 *    collapsed turn preview that reasoning is deliberately kept out of.
 *  - "keeps the reasoning identity off the message identity" dies if the two
 *    share a turnId, which lets the final answer overwrite the reasoning row.
 *  - "prefers content over summary" dies if both arrays are emitted, which
 *    prints the same reasoning twice on a provider that fills both.
 *  - "maps the notification's camelCase status" dies if `inProgress` is passed
 *    through: the host card drops a step whose status it cannot read, so the
 *    plan would render MISSING its in-progress step and look complete.
 *  - "keeps an unreadable status as pending" dies if an unknown member is
 *    dropped instead of degraded — a silently shorter plan.
 *  - "gives each plan update its own row" dies if the synthesized id stops
 *    varying, which makes the second plan overwrite the first.
 *  - "declines an empty plan" dies if a stepless update paints a card, telling
 *    the user the model cleared its plan when it did not.
 *  - the classification test dies if either family is left in the UNREAD list,
 *    which is where they were and is what "silently dropped" meant here.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';
import {
  CODEX_HANDLED_NOTIFICATION_METHODS,
  CODEX_UNREAD_NOTIFICATION_METHODS,
} from '../codex-notification-families.ts';
import { CODEX_PLAN_TOOL_NAME } from '../../utils/toolNames.ts';

const REASONING_COMPLETED = {
  threadId: 't', turnId: 'cx-1',
  item: {
    type: 'reasoning',
    id: 'reasoning_resp_108bdcd5',
    summary: [] as string[],
    content: ['weighing the options and deciding.'],
  },
};

const PLAN_UPDATED = {
  threadId: 't', turnId: 'cx-1',
  explanation: 'probe plan',
  plan: [
    { step: 'read the file', status: 'completed' },
    { step: 'write the fix', status: 'inProgress' },
    { step: 'run the tests', status: 'pending' },
  ],
};

describe('P3.294 · codex reasoning reaches the thinking surface', () => {
  let adapter: CodexEventAdapter;
  beforeEach(() => {
    adapter = new CodexEventAdapter();
    adapter.startTurn('turn-1');
  });

  it('renders reasoning through the thinking surface', () => {
    expect(adapter.adapt('item/completed', REASONING_COMPLETED)).toEqual([{
      type: 'text_complete',
      text: 'weighing the options and deciding.',
      isIntermediate: true,
      isThinking: true,
      turnId: 'turn-1__thinking:reasoning_resp_108bdcd5#0',
    }]);
  });

  it('marks it thinking, not plain commentary', () => {
    const events = adapter.adapt('item/completed', REASONING_COMPLETED) as Array<{ isThinking?: boolean; isIntermediate?: boolean }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.isThinking).toBe(true);
    expect(events[0]!.isIntermediate).toBe(true);
  });

  it('keeps the reasoning identity off the message identity', () => {
    const reasoning = adapter.adapt('item/completed', REASONING_COMPLETED);
    const message = adapter.adapt('item/completed', {
      threadId: 't', turnId: 'cx-1', item: { type: 'agentMessage', id: 'msg_resp_1', text: 'OK' },
    });
    const idOf = (events: unknown[]) => (events[0] as { turnId?: string }).turnId;
    expect(idOf(reasoning)).not.toBe(idOf(message));
  });

  it('emits nothing at item/started, where both arrays are empty on the wire', () => {
    expect(adapter.adapt('item/started', {
      threadId: 't', turnId: 'cx-1',
      item: { type: 'reasoning', id: 'reasoning_resp_1', summary: [], content: [] },
    })).toEqual([]);
  });

  it('prefers content over summary and never emits both', () => {
    const events = adapter.adapt('item/completed', {
      threadId: 't', turnId: 'cx-1',
      item: { type: 'reasoning', id: 'r2', summary: ['the summarized form'], content: ['the raw form'] },
    }) as Array<{ text: string }>;
    expect(events.map(e => e.text)).toEqual(['the raw form']);
  });

  it('falls back to summary when the provider withheld the raw reasoning', () => {
    const events = adapter.adapt('item/completed', {
      threadId: 't', turnId: 'cx-1',
      item: { type: 'reasoning', id: 'r3', summary: ['the summarized form'], content: [] },
    }) as Array<{ text: string }>;
    expect(events.map(e => e.text)).toEqual(['the summarized form']);
  });

  it('emits one row per entry and drops blank ones', () => {
    const events = adapter.adapt('item/completed', {
      threadId: 't', turnId: 'cx-1',
      item: { type: 'reasoning', id: 'r4', summary: [], content: ['first', '   ', 'second'] },
    }) as Array<{ text: string; turnId?: string }>;
    expect(events.map(e => e.text)).toEqual(['first', 'second']);
    expect(new Set(events.map(e => e.turnId)).size).toBe(2);
  });
});

describe('P3.295 · codex plan reaches the plan/todo surface', () => {
  let adapter: CodexEventAdapter;
  beforeEach(() => {
    adapter = new CodexEventAdapter();
    adapter.startTurn('turn-1');
  });

  it("maps the notification's camelCase status onto the host's snake_case one", () => {
    const start = (adapter.adapt('turn/plan/updated', PLAN_UPDATED) as Array<{ input?: { todos?: unknown } }>)[0]!;
    expect(start.input?.todos).toEqual([
      { content: 'read the file', status: 'completed' },
      { content: 'write the fix', status: 'in_progress' },
      { content: 'run the tests', status: 'pending' },
    ]);
  });

  it("stamps codex's own tool name, and carries the steps on the result too", () => {
    const events = adapter.adapt('turn/plan/updated', PLAN_UPDATED) as Array<{
      type: string; toolName?: string; toolUseId?: string; result?: string; input?: Record<string, unknown>;
    }>;
    expect(events.map(e => e.type)).toEqual(['tool_start', 'tool_result']);
    expect(events.every(e => e.toolName === CODEX_PLAN_TOOL_NAME)).toBe(true);
    expect(events[0]!.toolUseId).toBe(events[1]!.toolUseId);
    expect(events[0]!.input?.explanation).toBe('probe plan');
    expect(JSON.parse(events[1]!.result!).todos).toEqual(events[0]!.input?.todos);
  });

  it('keeps an unreadable status as pending rather than dropping the step', () => {
    const start = (adapter.adapt('turn/plan/updated', {
      threadId: 't', turnId: 'cx-1', explanation: null,
      plan: [{ step: 'a step from a newer binary', status: 'blockedOnSomethingNew' }],
    }) as Array<{ input?: { todos?: unknown } }>)[0]!;
    expect(start.input?.todos).toEqual([{ content: 'a step from a newer binary', status: 'pending' }]);
  });

  it('gives each plan update in a turn its own row', () => {
    const first = adapter.adapt('turn/plan/updated', PLAN_UPDATED) as Array<{ toolUseId?: string }>;
    const second = adapter.adapt('turn/plan/updated', PLAN_UPDATED) as Array<{ toolUseId?: string }>;
    expect(first[0]!.toolUseId).not.toBe(second[0]!.toolUseId);
  });

  it('declines an update with no readable step', () => {
    expect(adapter.adapt('turn/plan/updated', { threadId: 't', turnId: 'cx-1', explanation: null, plan: [] })).toEqual([]);
    expect(adapter.adapt('turn/plan/updated', { threadId: 't', turnId: 'cx-1', explanation: null, plan: [{ step: '  ', status: 'pending' }] })).toEqual([]);
  });

  it('streams the EXPERIMENTAL plan item and lets the completed item replace it', () => {
    const delta = adapter.adapt('item/plan/delta', { threadId: 't', turnId: 'cx-1', itemId: 'p1', delta: 'first I will ' });
    const done = adapter.adapt('item/completed', { threadId: 't', turnId: 'cx-1', item: { type: 'plan', id: 'p1', text: 'first I will read the file' } });
    expect(delta).toEqual([{ type: 'text_delta', text: 'first I will ', turnId: 'turn-1__planitem:p1' }]);
    expect(done).toEqual([{
      type: 'text_complete',
      text: 'first I will read the file',
      isIntermediate: true,
      turnId: 'turn-1__planitem:p1',
    }]);
  });
});

describe('P3.294/P3.295 · both families are classified HANDLED', () => {
  it('moves the two plan families out of the unread list', () => {
    for (const method of ['turn/plan/updated', 'item/plan/delta']) {
      expect(CODEX_HANDLED_NOTIFICATION_METHODS as readonly string[]).toContain(method);
      expect(CODEX_UNREAD_NOTIFICATION_METHODS as readonly string[]).not.toContain(method);
    }
  });

  it('leaves the three reasoning DELTA families unread, because this binary emits none of them', () => {
    for (const method of ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded']) {
      expect(CODEX_UNREAD_NOTIFICATION_METHODS as readonly string[]).toContain(method);
    }
  });
});
