/**
 * F1.1150 (origin DN-229) — codex's in-flight auto-review is a PHASE status: "Auto-reviewing this action..." rides
 * `status` with `phase: true` (a label, no transcript row), and the review's completion clears it with an empty phase
 * status ahead of its verdict, so a denial or a timeout (durable `info` lines, no status) no longer leaves the label up
 * until the turn's next status.
 */
import { describe, expect, it } from 'bun:test';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';

describe('F1.1150 — the auto-review label is a phase that clears itself', () => {
  it('started is a phase label; a denied completion clears it before its warning', () => {
    const adapter = new CodexEventAdapter();
    expect(adapter.adapt('item/autoApprovalReview/started', { threadId: 't', turnId: 'u' }))
      .toEqual([{ type: 'status', message: 'Auto-reviewing this action...', phase: true }]);
    const denied = adapter.adapt('item/autoApprovalReview/completed', { review: { status: 'denied' }, action: { type: 'command', command: 'rm -rf /' } });
    expect(denied[0]).toEqual({ type: 'status', message: '', phase: true });
    expect(denied[1]).toMatchObject({ type: 'info', level: 'warning' });
  });

  it('BOUNDARY — a completion with no label up (no started seen) adds no clear', () => {
    const adapter = new CodexEventAdapter();
    expect(adapter.adapt('item/autoApprovalReview/completed', { review: { status: 'approved' } })[0])
      .toMatchObject({ type: 'status', message: 'Auto-review approved this action' });
  });

  it('NEGATIVE — the approved verdict keeps its own plain status row after the clear', () => {
    const adapter = new CodexEventAdapter();
    adapter.adapt('item/autoApprovalReview/started', {});
    const approved = adapter.adapt('item/autoApprovalReview/completed', { review: { status: 'approved' } });
    expect(approved[0]).toEqual({ type: 'status', message: '', phase: true });
    expect(approved[1]).toMatchObject({ type: 'status' });
    expect((approved[1] as { phase?: unknown }).phase).toBeUndefined();
    expect((approved[1] as { message: string }).message).toStartWith('Auto-review approved this action');
  });
});
