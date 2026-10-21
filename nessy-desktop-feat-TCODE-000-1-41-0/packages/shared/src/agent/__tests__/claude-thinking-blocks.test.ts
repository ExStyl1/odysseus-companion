/**
 * P4.4 · the Claude adapter must surface the reasoning blocks the SDK already
 * sends, and must NEVER surface a redacted one.
 *
 * Why this file exists at all: `@anthropic-ai/sdk`'s `ContentBlock` union
 * (`resources/messages/messages.d.ts:551`) is
 * `TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock | …`, and
 * before this row the adapter read only `block.type === 'text'` and, through
 * `extractToolStarts`, `tool_use`. So the runtime surfaced reasoning and we
 * dropped it — a native mechanism we had never read, not a missing one.
 *
 * The redaction cases are the load-bearing half. `RedactedThinkingBlock` is
 * `{ data: string; type: 'redacted_thinking' }`: `data` is opaque ciphertext
 * with no readable field, so a row painted from it would show base64 and read
 * as corruption. A renderer that shows redacted thinking is worse than one
 * that shows none.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';
import type { AgentEvent } from '@nessy-agent/core/types';

function createCallbacks(): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: {
        code: 'unknown_error',
        title: 'Test Error',
        message: 'unused',
        details: [],
        actions: [],
        canRetry: false,
      },
    }),
  } as ClaudeAdapterCallbacks;
}

/** An `assistant` SDK message carrying the given content blocks. */
function assistantMessage(content: unknown[], parentToolUseId: string | null = null) {
  return {
    type: 'assistant',
    message: { id: 'msg-thinking-1', content, usage: { input_tokens: 10, output_tokens: 5 } },
    parent_tool_use_id: parentToolUseId,
    session_id: 'sess-1',
  } as any;
}

function thinkingEvents(events: AgentEvent[]) {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: 'text_complete' }> =>
      e.type === 'text_complete' && (e as { isThinking?: boolean }).isThinking === true,
  );
}

describe('ClaudeEventAdapter · thinking blocks (P4.4)', () => {
  let adapter: ClaudeEventAdapter;

  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  it('emits a thinking text_complete for a ThinkingBlock', async () => {
    const events = await adapter.adapt(
      assistantMessage([
        { type: 'thinking', thinking: 'The handler is probably in src/auth.', signature: 'sig-abc' },
        { type: 'text', text: 'Let me look.' },
      ]),
    );

    const thinking = thinkingEvents(events);
    expect(thinking).toHaveLength(1);
    // The VALUE, not merely the presence: the reasoning text must arrive intact.
    expect(thinking[0]!.text).toBe('The handler is probably in src/auth.');
    // Always also intermediate, so every reader of the older field is unaffected.
    expect(thinking[0]!.isIntermediate).toBe(true);
  });

  /**
   * P6.481 · this pin was `never carries the block signature anywhere on the
   * event`, and it is REVERSED deliberately rather than deleted.
   *
   * P4.4's reason for dropping it was that the signature had no reader: it was
   * an opaque token beside a row we only rendered, so carrying it was carrying
   * a secret-shaped string for nothing. That reason expired when owner decision
   * Q10 = (b) asked for claude-origin reasoning to REPLAY across a switch —
   * `ThinkingBlockParam` in `@anthropic-ai/sdk` declares `signature: string` as
   * REQUIRED, so the attestation is not an extra, it is the difference between
   * a replayable block and one that cannot be expressed at all.
   *
   * The half of P4.4's caution that still stands is next to it and is not
   * touched: a `redacted_thinking` block still produces NO event, so its opaque
   * `data` still never reaches the wire.
   */
  it('carries the block signature, because a replay is refused without it', async () => {
    const events = await adapter.adapt(
      assistantMessage([
        { type: 'thinking', thinking: 'reasoning body', signature: 'CAISmQIKiAEIEBgC' },
      ]),
    );

    const thinking = thinkingEvents(events);
    expect((thinking[0] as { thinkingSignature?: string }).thinkingSignature).toBe('CAISmQIKiAEIEBgC');
  });

  it('drops a redacted_thinking block entirely — no event, no opaque data on the wire', async () => {
    const events = await adapter.adapt(
      assistantMessage([
        { type: 'redacted_thinking', data: 'EvYBCkYIAxgCKkBOPAQ-OPAQUE-CIPHERTEXT' },
        { type: 'text', text: 'Here is the answer.' },
      ]),
    );

    expect(thinkingEvents(events)).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain('OPAQUE-CIPHERTEXT');
  });

  it('keeps the legible reasoning in a message that also carries a redacted block', async () => {
    // The honest middle case: dropping the redacted block must not suppress the
    // reasoning that WAS sent in clear, or the drop becomes a silent gap.
    const events = await adapter.adapt(
      assistantMessage([
        { type: 'thinking', thinking: 'visible reasoning', signature: 's1' },
        { type: 'redacted_thinking', data: 'OPAQUE' },
      ]),
    );

    const thinking = thinkingEvents(events);
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.text).toBe('visible reasoning');
  });

  it('emits nothing for an empty or whitespace-only thinking block', async () => {
    const events = await adapter.adapt(
      assistantMessage([
        { type: 'thinking', thinking: '   \n  ', signature: 's' },
        { type: 'thinking', thinking: '', signature: 's' },
      ]),
    );

    expect(thinkingEvents(events)).toHaveLength(0);
  });

  it('gives each reasoning block a turnId distinct from the message turn', async () => {
    // Sharing the message's turnId would let the final assistant text overwrite
    // the reasoning row — the renderer resolves a text_complete by turnId across
    // the whole transcript.
    await adapter.adapt({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg-turn-9' } },
      parent_tool_use_id: null,
      session_id: 'sess-1',
    } as any);

    const events = await adapter.adapt(
      assistantMessage([
        { type: 'thinking', thinking: 'first', signature: 's' },
        { type: 'text', text: 'mid' },
        { type: 'thinking', thinking: 'second', signature: 's' },
      ]),
    );

    const thinking = thinkingEvents(events);
    expect(thinking).toHaveLength(2);
    const turnIds = thinking.map(e => e.turnId);
    expect(turnIds).toEqual(['msg-turn-9__thinking0', 'msg-turn-9__thinking2']);
    expect(new Set(turnIds).size).toBe(2);
    expect(turnIds).not.toContain('msg-turn-9');
  });

  it('carries parentToolUseId so subagent reasoning nests', async () => {
    const events = await adapter.adapt(
      assistantMessage([{ type: 'thinking', thinking: 'nested reasoning', signature: 's' }], 'toolu_parent'),
    );

    const thinking = thinkingEvents(events);
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.parentToolUseId).toBe('toolu_parent');
  });

  it('leaves a message with no reasoning untouched (negative control)', async () => {
    const events = await adapter.adapt(assistantMessage([{ type: 'text', text: 'plain answer' }]));
    expect(thinkingEvents(events)).toHaveLength(0);
  });
});

/**
 * P6.481 — the ATTESTATION, which P4.4 surfaced the text of and then dropped.
 */
describe('ClaudeEventAdapter · the thinking signature (P6.481)', () => {
  let adapter: ClaudeEventAdapter;

  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
  });

  it('carries the signature off the block', async () => {
    const events = await adapter.adapt(
      assistantMessage([{ type: 'thinking', thinking: 'the join is quadratic', signature: 'CAISmQIKiAEIEBgC' }]),
    );
    const thinking = thinkingEvents(events);
    expect(thinking).toHaveLength(1);
    // Without this the row is unreplayable, not merely poorer:
    // `ThinkingBlockParam` in `@anthropic-ai/sdk` declares `signature: string`
    // as REQUIRED, so an unsigned block cannot be sent back at all.
    expect((thinking[0] as { thinkingSignature?: string }).thinkingSignature).toBe('CAISmQIKiAEIEBgC');
  });

  it('omits the field rather than inventing one when the block carries none', async () => {
    const events = await adapter.adapt(
      assistantMessage([{ type: 'thinking', thinking: 'unsigned' } as unknown as Record<string, unknown>]),
    );
    const thinking = thinkingEvents(events);
    expect(thinking).toHaveLength(1);
    expect('thinkingSignature' in thinking[0]!).toBe(false);
    // An empty string is not a signature either.
    const empty = await adapter.adapt(assistantMessage([{ type: 'thinking', thinking: 'x', signature: '' }]));
    expect('thinkingSignature' in thinkingEvents(empty)[0]!).toBe(false);
  });
});

/**
 * C3.348 — reasoning STREAMS, instead of landing as one finished row when the
 * whole assistant message does.
 *
 * The frames were always on the wire: the vendored `@anthropic-ai/sdk` declares
 * `RawContentBlockDelta = TextDelta | InputJSONDelta | CitationsDelta |
 * ThinkingDelta | SignatureDelta` with `ThinkingDelta` as
 * `{ thinking: string; type: 'thinking_delta' }`, and `claude-agent.ts` has set
 * `includePartialMessages: true` all along — the adapter branched two of the
 * five and dropped this one. C3.173 measured the arrival against the packaged
 * app's own vendored SDK (2 `thinking_delta` + 1 `signature_delta`, with a
 * `text_delta` in the same run as the positive control).
 *
 * The load-bearing case is the FIRST one, and it is not "a delta was emitted".
 * It is that the streamed row and the finished row carry the SAME turnId: a
 * stream frame's `event.index` is the content-block index `extractThinkingEvents`
 * counts with, so the two sites agree without either keeping state. Get that
 * wrong and every reasoning block draws twice — which is exactly what a test
 * asserting only "deltas arrive" would let through.
 */
describe('ClaudeEventAdapter · reasoning arrives live (C3.348)', () => {
  let adapter: ClaudeEventAdapter;

  beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

  const streamEvent = (event: unknown) => ({
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    session_id: 'sess-1',
  } as any);

  const textDeltas = (events: AgentEvent[]) =>
    events.filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta');

  it('streams the reasoning under the SAME turnId the finished row lands on', async () => {
    await adapter.adapt(streamEvent({ type: 'message_start', message: { id: 'msg-turn-9' } }));

    const first = textDeltas(await adapter.adapt(streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'The handler' },
    })));
    const second = textDeltas(await adapter.adapt(streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: ' is in src/auth.' },
    })));

    // Read the values into locals BEFORE asserting a shape: an asymmetric
    // matcher handed to `toMatchObject` overwrites the field it matches
    // (AGENTS.md §Traps, 2026-09-07), and these same events are read again below.
    expect([first.length, second.length]).toEqual([1, 1]);
    expect([first[0]!.text, second[0]!.text]).toEqual(['The handler', ' is in src/auth.']);
    const streamedTurnId = first[0]!.turnId;
    expect(streamedTurnId).toBe('msg-turn-9__thinking0');
    expect(second[0]!.turnId).toBe(streamedTurnId);

    // THE DISCRIMINATING ASSERTION. The assistant message closes the very block
    // that was streamed; if the two sites ever spell the id differently the
    // user sees the reasoning twice, and nothing else in this file would fail.
    const finished = thinkingEvents(await adapter.adapt(
      assistantMessage([
        { type: 'thinking', thinking: 'The handler is in src/auth.', signature: 'sig-abc' },
        { type: 'text', text: 'Let me look.' },
      ]),
    ));
    expect(finished).toHaveLength(1);
    expect(finished[0]!.turnId).toBe(streamedTurnId);
    expect(finished[0]!.text).toBe('The handler is in src/auth.');
  });

  it('reads the thinking channel ONLY, and never streams into the answer row', async () => {
    await adapter.adapt(streamEvent({ type: 'message_start', message: { id: 'msg-turn-9' } }));

    // The attestation is read off the FINAL block (P6.481), where it is whole; a
    // half-streamed signature is not expressible as `ThinkingBlockParam`.
    const signature = textDeltas(await adapter.adapt(streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'CAISmQIKiAEIEBgC' },
    })));
    // An empty fragment draws nothing, the same guard Pi applies.
    const empty = textDeltas(await adapter.adapt(streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '' },
    })));
    expect([signature.length, empty.length]).toEqual([0, 0]);

    // The positive control in the same run, which is what proves the two
    // assertions above are an absence and not a dead harness: ordinary text
    // still streams, and still under the MESSAGE's own turnId.
    const answer = textDeltas(await adapter.adapt(streamEvent({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Looking now.' },
    })));
    expect(answer).toHaveLength(1);
    expect([answer[0]!.text, answer[0]!.turnId]).toEqual(['Looking now.', 'msg-turn-9']);
  });

  it('falls silent with no turn id rather than merging reasoning into the reply', async () => {
    // No `message_start`, so there is no reasoning row to stream into. A bare
    // `undefined` turnId would put these fragments in the assistant's ANSWER
    // row; falling silent leaves exactly the pre-C3.348 behaviour, because the
    // block still lands whole through `extractThinkingEvents`.
    const events = await adapter.adapt(streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'orphaned reasoning' },
    }));
    expect(textDeltas(events)).toHaveLength(0);

    const finished = thinkingEvents(await adapter.adapt(
      assistantMessage([{ type: 'thinking', thinking: 'orphaned reasoning', signature: 's' }]),
    ));
    expect(finished).toHaveLength(1);
    expect(finished[0]!.text).toBe('orphaned reasoning');
  });
});
