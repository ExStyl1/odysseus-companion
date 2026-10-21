import { describe, expect, it } from 'bun:test';
import type { SessionEvent } from '@nessy-agent/shared/protocol';
import { handleStatus } from '../session';
import type { SessionState, StatusEvent } from '../../types';

/**
 * The renderer's `StatusEvent` must not be NARROWER than the wire's — the
 * values arrive whatever the type says, and a narrower union only mis-narrows
 * the first exhaustive switch someone writes over it. `'retrying'` (the gateway
 * 429 backoff status) was missing here while `dto.ts` had carried it all along.
 * A compile-time assignment, so `bun run typecheck:electron` is the gate.
 */
type WireStatusType = Extract<SessionEvent, { type: 'status' }>['statusType'];
const _statusTypeIsAtLeastTheWireUnion: StatusEvent['statusType'] = undefined as WireStatusType;

function stateWith(messages: unknown[] = []): SessionState {
  return { session: { id: 's1', messages }, streaming: null } as unknown as SessionState;
}

describe('handleStatus with a hook status message', () => {
  it('drives the spinner without writing the transcript, and clears on an empty message', () => {
    // hooks.md § Common fields: a hook's `statusMessage` is "displayed while
    // the hook runs". A PreToolUse hook fires on every tool call, so appending
    // one persisted status message per call would bury the transcript.
    const shown = handleStatus(stateWith(), {
      type: 'status',
      sessionId: 's1',
      message: 'Scanning for secrets…',
      statusType: 'hook',
    } satisfies StatusEvent);
    expect(shown.state.session.currentStatus).toEqual({ message: 'Scanning for secrets…', statusType: 'hook' });
    expect(shown.state.session.messages).toHaveLength(0);

    const cleared = handleStatus(shown.state, {
      type: 'status',
      sessionId: 's1',
      message: '',
      statusType: 'hook',
    } satisfies StatusEvent);
    expect(cleared.state.session.currentStatus).toBeUndefined();
    expect(cleared.state.session.messages).toHaveLength(0);
  });

  it('still appends a transcript entry for every other status', () => {
    // The compaction status is a turn-level activity entry and must keep its
    // message; only the hook spinner is transient.
    const result = handleStatus(stateWith(), {
      type: 'status',
      sessionId: 's1',
      message: 'Compacting conversation',
      statusType: 'compacting',
    } satisfies StatusEvent);
    expect(result.state.session.currentStatus).toEqual({ message: 'Compacting conversation', statusType: 'compacting' });
    expect(result.state.session.messages).toHaveLength(1);
  });

  it('carries the gateway retry status', () => {
    const result = handleStatus(stateWith(), {
      type: 'status',
      sessionId: 's1',
      message: 'Gateway is throttling — retrying in 15s (1/5)',
      statusType: 'retrying',
    } satisfies StatusEvent);
    expect(result.state.session.currentStatus).toEqual({
      message: 'Gateway is throttling — retrying in 15s (1/5)',
      statusType: 'retrying',
    });
  });
});
