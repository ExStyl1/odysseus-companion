/**
 * F1.1150 (origin DN-229) — a runtime PHASE status (codex's thread re-fork label, codex's "Auto-reviewing this
 * action...") is a label, not a transcript row, and it clears itself when the phase ends.
 *
 * Before, a phase rode a plain `status`: a row with a spinner and the chip's label, kept until the turn's next status
 * or its end. `AgentEvent.status` now carries `phase: true` (an empty message is the end-of-phase clear), the host
 * forwards it as `statusType: 'phase'`, and the renderer treats it as it treats a hook's `statusMessage`.
 */
import { describe, expect, it } from 'bun:test';
import { handleStatus } from '../session';
import type { SessionState, StatusEvent } from '../../types';

function stateWith(messages: unknown[] = []): SessionState {
  return { session: { id: 's1', messages }, streaming: null } as unknown as SessionState;
}

describe('handleStatus with a runtime phase status (F1.1150)', () => {
  it('shows the label without a transcript row, and the phase end (empty message) clears it', () => {
    const shown = handleStatus(stateWith(), {
      type: 'status',
      sessionId: 's1',
      message: 'Re-opening the Codex thread for the changed settings (this can take up to 120 s)...',
      statusType: 'phase',
    } satisfies StatusEvent);
    expect(shown.state.session.currentStatus?.message).toContain('Re-opening the Codex thread');
    expect(shown.state.session.messages).toHaveLength(0);

    const ended = handleStatus(shown.state, { type: 'status', sessionId: 's1', message: '', statusType: 'phase' } satisfies StatusEvent);
    expect(ended.state.session.currentStatus).toBeUndefined();
    expect(ended.state.session.messages).toHaveLength(0);
  });

  it('NEGATIVE — a plain status still writes its row and keeps the label', () => {
    const plain = handleStatus(stateWith(), { type: 'status', sessionId: 's1', message: 'Auto-review approved this action' } satisfies StatusEvent);
    expect(plain.state.session.messages).toHaveLength(1);
    expect(plain.state.session.currentStatus?.message).toBe('Auto-review approved this action');
  });
});
