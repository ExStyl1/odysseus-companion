/**
 * P6.561 · claude forwards a subagent's whole conversation on request, and we
 * never asked. Native-first step 1: the option is the vendor's own.
 *
 * `cli-reference.md` states the behaviour verbatim: *"Emit subagent text and
 * thinking blocks in the output stream as `assistant` and `user` messages with
 * `parent_tool_use_id` set, so you can reconstruct each subagent's transcript.
 * Without this flag, Claude Code emits only subagent `tool_use` and
 * `tool_result` blocks."* The SDK declares the same option as
 * `Options.forwardSubagentText`.
 *
 * The suite pins three things and nothing more: that the key we set is the
 * SDK's own (not an invented spelling), that we set it, and that the frames it
 * unlocks reach the host attributed to their parent tool call — with a
 * main-line message as the negative control, because an unattributed message
 * must stay the turn's own text.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';

const AGENT_SRC = new URL('../claude-agent.ts', import.meta.url).pathname;
const SDK_TYPES = new URL(
  '../../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts',
  import.meta.url,
).pathname;

function callbacks(): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: {
        code: 'unknown_error', title: 't', message: 'm', details: [], actions: [], canRetry: false,
      },
    }),
  } as ClaudeAdapterCallbacks;
}

/**
 * One subagent (or main-line) message as the SDK delivers it with
 * `includePartialMessages` on: the assistant frame carries the text, the
 * trailing `message_delta` carries the stop reason that settles it.
 */
async function textCompleteFor(parentToolUseId: string | null, stopReason: string) {
  const adapter = new ClaudeEventAdapter(callbacks());
  await adapter.adapt({
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: { id: 'msg_1', content: [{ type: 'text', text: 'found the file' }] },
  } as never);
  const events = await adapter.adapt({
    type: 'stream_event',
    parent_tool_use_id: parentToolUseId,
    event: { type: 'message_delta', delta: { stop_reason: stopReason } },
  } as never);
  return events.find(e => e.type === 'text_complete') as
    | { type: 'text_complete'; text: string; isIntermediate?: boolean; parentToolUseId?: string }
    | undefined;
}

describe('P6.561 · forwardSubagentText is asked for, and the frames land attributed', () => {
  it('sets the SDK\'s own option name — the key exists in the vendored sdk.d.ts', () => {
    // Read, do not invent: the spelling is pinned against the SDK that ships,
    // so a rename upstream fails here instead of silently doing nothing.
    expect(readFileSync(SDK_TYPES, 'utf8')).toContain('forwardSubagentText?: boolean;');
    expect(readFileSync(AGENT_SRC, 'utf8')).toContain('forwardSubagentText: true,');
  });

  it('positive — a subagent\'s final text is attributed to its parent tool call', async () => {
    // `end_turn`: the SUBAGENT ended its own turn. It is still not the parent
    // turn's response, which is why `parentToolUseId` has to survive.
    const event = await textCompleteFor('toolu_parent_1', 'end_turn');
    expect(event?.text).toBe('found the file');
    expect(event?.parentToolUseId).toBe('toolu_parent_1');
  });

  it('negative — a main-line message carries no parent, so nothing nests', async () => {
    const event = await textCompleteFor(null, 'end_turn');
    expect(event?.text).toBe('found the file');
    expect(event?.parentToolUseId).toBeUndefined();
  });
});
