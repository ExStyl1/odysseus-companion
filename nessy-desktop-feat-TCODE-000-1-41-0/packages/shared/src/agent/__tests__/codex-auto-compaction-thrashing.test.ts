/**
 * P6.55 · the compaction-thrashing guard's SECOND producer.
 *
 * Contract under test, from `how-claude-code-works.md#when-context-fills-up`
 * ("If a single file or tool output is so large that context refills immediately
 * after each summary, Claude Code stops auto-compacting after a few attempts and
 * shows an error instead of looping") and
 * `troubleshooting.md#auto-compaction-stops-with-a-thrashing-error` ("automatic
 * compaction succeeded but a file or tool output immediately refilled the
 * context window several times in a row").
 *
 * The trap this suite is arranged against: a threshold read against ZERO. A turn
 * that compacts once is the HEALTHY path — the resting state of "compactions in
 * a turn" is not zero — so the first two cases below pin that a normal turn and
 * a merely-long one produce no notice and no terminal reason. A guard that fired
 * there would manufacture its own failure and look correct doing it.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  CodexEventAdapter,
  CODEX_AUTO_COMPACTION_THRASHING_NOTICE_PREFIX,
} from '../backend/codex/event-adapter.ts';
import {
  AUTO_COMPACTION_THRASHING_REFILL_LIMIT,
  CodexAutoCompactionThrashGuard,
} from '../backend/codex/auto-compaction-thrash-guard.ts';
import { AUTO_COMPACTION_THRASHING_REFILL_LIMIT as SHARED_LIMIT } from '../../config/auto-compaction-settings.ts';
import type { AgentEvent } from '@nessy-agent/core/types';

const compactionItem = (id: string) => ({
  threadId: 't',
  turnId: 'cx-1',
  item: { type: 'contextCompaction', id },
});

function noticeIn(events: AgentEvent[]): string | undefined {
  const notice = events.find(
    (event): event is Extract<AgentEvent, { type: 'info' }> =>
      event.type === 'info' && event.message.startsWith(CODEX_AUTO_COMPACTION_THRASHING_NOTICE_PREFIX),
  );
  return notice?.message;
}

function completeOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'complete' }> {
  const complete = events.find(
    (event): event is Extract<AgentEvent, { type: 'complete' }> => event.type === 'complete',
  );
  if (!complete) throw new Error('turn/completed produced no complete event');
  return complete;
}

describe('CodexAutoCompactionThrashGuard', () => {
  it('counts REFILLS, not compactions — the first compaction of a turn is the healthy one', () => {
    const guard = new CodexAutoCompactionThrashGuard();
    guard.recordCompaction();
    expect(guard.refills).toBe(0);
    expect(guard.isTripped).toBe(false);
  });

  it('trips exactly once, on the compaction that reaches the shared refill limit', () => {
    const guard = new CodexAutoCompactionThrashGuard();
    const trips: boolean[] = [];
    // limit + 1 compactions == limit refills.
    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) {
      trips.push(guard.recordCompaction());
    }
    expect(trips.filter(Boolean).length).toBe(1);
    expect(trips[AUTO_COMPACTION_THRASHING_REFILL_LIMIT]).toBe(true);
    expect(guard.refills).toBe(AUTO_COMPACTION_THRASHING_REFILL_LIMIT);
    // A further compaction advances the count and does NOT re-announce.
    expect(guard.recordCompaction()).toBe(false);
    expect(guard.refills).toBe(AUTO_COMPACTION_THRASHING_REFILL_LIMIT + 1);
  });

  it('reads the SHARED limit, so the two producers cannot drift', () => {
    expect(AUTO_COMPACTION_THRASHING_REFILL_LIMIT).toBe(SHARED_LIMIT);
    // The floor, pinned: a limit at or below one refill would trip on a turn
    // that compacted twice, which is legitimate on a small window.
    expect(SHARED_LIMIT).toBeGreaterThan(1);
  });

  it('a user message clears the run — "in a row" ends at the turn boundary', () => {
    const guard = new CodexAutoCompactionThrashGuard();
    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) guard.recordCompaction();
    expect(guard.isTripped).toBe(true);
    guard.resetTurn();
    expect(guard.isTripped).toBe(false);
    expect(guard.refills).toBe(0);
  });
});

describe('CodexEventAdapter · compaction thrashing', () => {
  let adapter: CodexEventAdapter;
  beforeEach(() => {
    adapter = new CodexEventAdapter();
    adapter.startTurn('turn-1');
  });

  it('leaves a healthy single compaction exactly as it was', () => {
    const events = adapter.adapt('item/completed', compactionItem('c1'));
    expect(events).toEqual([
      { type: 'status', message: 'Compacting context...' },
      { type: 'info', message: 'Compacted context to fit within limits' },
    ]);
    expect(noticeIn(events)).toBeUndefined();
  });

  it('says nothing on a long turn that compacts more than once but below the limit', () => {
    // The resting-state control: two compactions in one turn is a real shape on
    // a small window, and it must stay silent.
    for (let i = 0; i < AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) {
      expect(noticeIn(adapter.adapt('item/completed', compactionItem(`c${i}`)))).toBeUndefined();
    }
    const completed = adapter.adapt('turn/completed', { threadId: 't', turnId: 'cx-1' });
    expect(completeOf(completed).terminalReason).toBeUndefined();
  });

  it('names the loop once and ends the turn with auto_compaction_thrashing', () => {
    let notice: string | undefined;
    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) {
      const seen = noticeIn(adapter.adapt('item/completed', compactionItem(`c${i}`)));
      if (seen) {
        expect(notice).toBeUndefined();
        notice = seen;
      }
    }
    expect(notice).toContain(`last ${AUTO_COMPACTION_THRASHING_REFILL_LIMIT} compactions`);
    // The notice must NOT be re-read as a compaction lifecycle row: the session
    // layer routes the pair above on the words "Compacting" / "Compacted".
    expect(notice?.startsWith('Compacted')).toBe(false);
    expect(notice).not.toContain('Compacting');

    const completed = adapter.adapt('turn/completed', { threadId: 't', turnId: 'cx-1' });
    expect(completeOf(completed).terminalReason).toBe('auto_compaction_thrashing');
  });

  it('counts the deprecated thread/compacted notification the bundled server still sends', () => {
    let notice: string | undefined;
    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) {
      notice = noticeIn(adapter.adapt('thread/compacted', { threadId: 't', turnId: 'cx-1' })) ?? notice;
    }
    expect(notice).toBeDefined();
    expect(completeOf(adapter.adapt('turn/completed', { threadId: 't', turnId: 'cx-1' })).terminalReason)
      .toBe('auto_compaction_thrashing');
  });

  it('a new turn starts clean — the next turn is not condemned by the last one', () => {
    for (let i = 0; i <= AUTO_COMPACTION_THRASHING_REFILL_LIMIT; i += 1) {
      adapter.adapt('item/completed', compactionItem(`c${i}`));
    }
    expect(completeOf(adapter.adapt('turn/completed', { threadId: 't', turnId: 'cx-1' })).terminalReason)
      .toBe('auto_compaction_thrashing');

    adapter.startTurn('turn-2');
    expect(noticeIn(adapter.adapt('item/completed', compactionItem('c-next')))).toBeUndefined();
    expect(completeOf(adapter.adapt('turn/completed', { threadId: 't', turnId: 'cx-2' })).terminalReason)
      .toBeUndefined();
  });
});
