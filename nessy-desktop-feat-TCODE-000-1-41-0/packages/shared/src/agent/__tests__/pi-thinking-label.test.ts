/**
 * P4.4 · Pi's reasoning must reach the renderer LABELLED as reasoning.
 *
 * NATIVE-FIRST, and the answer here was "already there": Pi's runtime has
 * emitted `thinking_start` / `thinking_delta` / `thinking_end` since long before
 * this row, and `PiEventAdapter` already read all three and forwarded them as
 * `isIntermediate: true` text. Nothing needed enabling. What was missing was the
 * one bit saying WHICH KIND of intermediate text this is — without it reasoning
 * and the model's user-facing asides drew the same renderer row, and reasoning
 * was eligible for promotion into the response bubble.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';

function collect(gen: Generator<any>): any[] {
  return [...gen];
}

describe('PiEventAdapter · reasoning label (P4.4)', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
    collect(adapter.adaptEvent({ type: 'turn_start' } as any));
  });

  function thinking(type: string, extra: Record<string, unknown> = {}) {
    return collect(
      adapter.adaptEvent({ type: 'message_update', assistantMessageEvent: { type, ...extra } } as any),
    );
  }

  it('labels a completed thinking block as reasoning', () => {
    thinking('thinking_start');
    thinking('thinking_delta', { delta: 'weigh the options' });
    const events = thinking('thinking_end', { content: 'weigh the options' });

    const complete = events.filter(e => e.type === 'text_complete');
    expect(complete).toHaveLength(1);
    expect(complete[0].text).toBe('weigh the options');
    expect(complete[0].isThinking).toBe(true);
    // Still intermediate: a reader that only knows the older field is unaffected.
    expect(complete[0].isIntermediate).toBe(true);
  });

  it('does NOT label ordinary assistant commentary as reasoning (negative control)', () => {
    // The same adapter, the same turn, a text_delta instead of a thinking_delta.
    const events = collect(
      adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'here is the answer' },
      } as any),
    );

    for (const event of events) {
      expect(event.isThinking).toBeUndefined();
    }
  });

  it('emits nothing for a thinking block that ends empty', () => {
    thinking('thinking_start');
    const events = thinking('thinking_end', { content: '' });
    expect(events.filter(e => e.type === 'text_complete')).toHaveLength(0);
  });

  it('keeps reasoning on a sub-turn id of its own', () => {
    thinking('thinking_start');
    thinking('thinking_delta', { delta: 'a' });
    const events = thinking('thinking_end', { content: 'a' });
    const complete = events.find(e => e.type === 'text_complete');
    expect(complete.turnId).toContain('__thinking');
  });
});
