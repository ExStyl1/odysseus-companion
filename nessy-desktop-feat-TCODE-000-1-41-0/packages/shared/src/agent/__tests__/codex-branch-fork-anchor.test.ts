/**
 * P6.102 — the codex turn id the host branches on.
 *
 * `thread/fork` takes `lastTurnId` — "Optional last turn id to fork through,
 * inclusive. When specified, turns after `last_turn_id` are omitted from the
 * fork" (`packages/codex-protocol/generated/v2/ThreadForkParams.ts`) — so a
 * branch is only as good as the turn id the host can hand it.
 *
 * `turnId` on the event cannot be that value. It is a per-MESSAGE identity
 * (`<base>__<kind>:<item id>`, P3.9) precisely so two messages in one turn do
 * not overwrite each other in the renderer, and its base falls back to a
 * SYNTHETIC `turn<n>` when nothing real is available. Offering either to the
 * server would be refused, or worse, accepted as a turn that is not the one the
 * user pointed at. So the adapter states codex's own value in `runtimeTurnId`,
 * and this file pins the three cases that separates.
 */
import { describe, it, expect } from 'bun:test';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';

const completion = (adapter: CodexEventAdapter, params: Record<string, unknown>) =>
  adapter.adapt('item/completed', {
    ...params,
    item: { type: 'agentMessage', id: 'am1', text: 'done' },
  })[0] as { type: string; turnId?: string; runtimeTurnId?: string };

describe('P6.102 · the codex turn id a branch forks through', () => {
  it('publishes codex own turn id beside the per-message identity', () => {
    // Production shape: `startTurn()` with no id (`codex-agent.ts:7071` is the
    // only caller), so the notification's own `turnId` is the real thing.
    const adapter = new CodexEventAdapter();
    adapter.startTurn();

    const event = completion(adapter, { threadId: 't', turnId: 'cx-turn-7' });

    expect(event.type).toBe('text_complete');
    expect(event.runtimeTurnId).toBe('cx-turn-7');
    // The two are NOT interchangeable, which is the whole reason for the field.
    expect(event.turnId).toBe('cx-turn-7__msg:am1');
    expect(event.turnId).not.toBe(event.runtimeTurnId);
  });

  it('withholds the anchor when the only turn id available is one we invented', () => {
    // Negative control. With no wire turn id the render identity still needs a
    // unique base and falls back to `turn<n>` — a value no codex thread has
    // ever heard of. A branch anchored on it would name a turn that does not
    // exist, so nothing is published at all and `SessionManager` degrades to
    // codex's own full-history fork.
    const adapter = new CodexEventAdapter();
    adapter.startTurn();

    const event = completion(adapter, { threadId: 't' });

    expect(event.turnId).toMatch(/^turn\d+__msg:am1$/);
    expect(event.runtimeTurnId).toBeUndefined();
    expect('runtimeTurnId' in event).toBe(false);
  });

  it('ignores a host-supplied turn label — only the wire value can anchor a fork', () => {
    // `startTurn(id)` is the base-adapter API a call site MAY pass a label to,
    // and the render identity prefers it. The anchor deliberately does not:
    // that label is ours, not codex's, and the codex call site passes none.
    // Publishing it would hand `thread/fork` an id the server never minted.
    const adapter = new CodexEventAdapter();
    adapter.startTurn('host-label');

    const event = completion(adapter, { threadId: 't', turnId: 'cx-turn-inner' });

    expect(event.runtimeTurnId).toBe('cx-turn-inner');
    expect(event.turnId).toBe('host-label__msg:am1');
  });
});
