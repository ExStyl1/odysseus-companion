/**
 * Tests for CodexEventAdapter — app-server (v2) notifications → AgentEvent.
 *
 * The canned input objects use field names copied verbatim from
 * `@nessy-agent/codex-protocol` `generated/v2` (rust-v0.147.0): the notification
 * method strings, `item.type` discriminants, and the `commandExecution` /
 * `agentMessage` item fields (`command`, `aggregatedOutput`, `exitCode`, `text`,
 * `delta`, `itemId`, `tokenUsage`).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { CodexEventAdapter, readCodexMessageUsage, readCodexTokenCount } from '../backend/codex/event-adapter.ts';
import type { AgentEvent } from '@nessy-agent/core/types';

describe('CodexEventAdapter', () => {
  let adapter: CodexEventAdapter;
  beforeEach(() => {
    adapter = new CodexEventAdapter();
    adapter.startTurn('turn-1');
  });

  // P3.9 · text events travel under a PER-MESSAGE identity, `<turn
  // base>__<kind>:<item key>`, not under one id per turn. The base is the turn
  // id this suite starts each turn with; in production no call site passes one
  // and the notification's own `turnId` takes that slot.
  const msgId = (itemId: string, base = 'turn-1') => `${base}__msg:${itemId}`;
  const imgId = (type: string, id: string, base = 'turn-1') => `${base}__img:${type}:${id}`;

  it('maps item/agentMessage/delta → text_delta', () => {
    const events = adapter.adapt('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hello' });
    expect(events).toEqual([{ type: 'text_delta', text: 'hello', turnId: msgId('i') }]);
  });

  it('gives every non-stream completion in a turn its own identity', () => {
    // The collision P3.9 closes: two completions in one turn used to share the
    // turn's id (in production, no id at all), and the renderer — which looks
    // the assistant bubble up by that id — could not tell them apart.
    const image = adapter.adapt('item/completed', {
      threadId: 't', turnId: 'cx-1',
      item: { type: 'imageGeneration', id: 'ig9', status: 'completed', revisedPrompt: null, result: 'ok', failure: null, savedPath: '/tmp/a.png' },
    });
    const message = adapter.adapt('item/completed', {
      threadId: 't', turnId: 'cx-1', item: { type: 'agentMessage', id: 'am9', text: 'and here it is' },
    });
    const idOf = (events: AgentEvent[]) => (events[0] as { turnId?: string }).turnId;
    expect(idOf(image)).toBe(imgId('imageGeneration', 'ig9'));
    expect(idOf(message)).toBe(msgId('am9'));
    expect(idOf(image)).not.toBe(idOf(message));
  });

  it('gives a message the SAME identity on its deltas and its completion', () => {
    // `AgentMessageDeltaNotification.itemId` is the completed `ThreadItem.id`,
    // so the renderer finalizes the bubble it streamed — no state kept here.
    const streamed = adapter.adapt('item/agentMessage/delta', { threadId: 't', turnId: 'cx-1', itemId: 'am10', delta: 'half ' });
    const done = adapter.adapt('item/completed', { threadId: 't', turnId: 'cx-1', item: { type: 'agentMessage', id: 'am10', text: 'half a sentence' } });
    expect((streamed[0] as { turnId?: string }).turnId).toBe(msgId('am10'));
    expect((done[0] as { turnId?: string }).turnId).toBe(msgId('am10'));
  });

  it('keeps the identity turn-unique when no call site passes a turn id', () => {
    // Production shape: `startTurn()` with no id, so codex's OWN turn id from
    // the notification is the base. The renderer's lookup scans the whole
    // transcript, so a base that repeated across turns would let a new message
    // update an old one.
    const bare = new CodexEventAdapter();
    bare.startTurn();
    const first = bare.adapt('item/completed', { threadId: 't', turnId: 'cx-1', item: { type: 'agentMessage', id: 'am1', text: 'one' } });
    bare.startTurn();
    const second = bare.adapt('item/completed', { threadId: 't', turnId: 'cx-2', item: { type: 'agentMessage', id: 'am1', text: 'two' } });
    expect((first[0] as { turnId?: string }).turnId).toBe(msgId('am1', 'cx-1'));
    expect((second[0] as { turnId?: string }).turnId).toBe(msgId('am1', 'cx-2'));

    // And with neither id available it still moves — the inherited turn index.
    const idless = new CodexEventAdapter();
    idless.startTurn();
    const a = idless.adapt('item/completed', { item: { type: 'agentMessage', id: 'am1', text: 'one' } });
    idless.startTurn();
    const b = idless.adapt('item/completed', { item: { type: 'agentMessage', id: 'am1', text: 'two' } });
    expect((a[0] as { turnId?: string }).turnId).not.toBe((b[0] as { turnId?: string }).turnId);
  });

  it('maps a command item lifecycle → tool_start then tool_result with accumulated output', () => {
    const start = adapter.adapt('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'ls -la' } });
    expect(start[0]).toMatchObject({ type: 'tool_start', toolName: 'Bash', toolUseId: 'c1', input: { command: 'ls -la' } });

    // streaming output delta accumulates, emits nothing
    expect(adapter.adapt('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'file1\n' })).toEqual([]);
    expect(adapter.adapt('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'file2\n' })).toEqual([]);

    const done = adapter.adapt('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls -la', exitCode: 0 } });
    expect(done[0]).toMatchObject({ type: 'tool_result', toolUseId: 'c1', toolName: 'Bash', result: 'file1\nfile2\n', isError: false });
  });

  it('falls back to aggregatedOutput and flags non-zero exit as error', () => {
    adapter.adapt('item/started', { item: { type: 'commandExecution', id: 'c2', command: 'false' } });
    const done = adapter.adapt('item/completed', { item: { type: 'commandExecution', id: 'c2', command: 'false', aggregatedOutput: 'boom', exitCode: 1 } });
    expect(done[0]).toMatchObject({ type: 'tool_result', toolUseId: 'c2', result: 'boom', isError: true });
  });

  it('maps an agentMessage completed → text_complete', () => {
    const events = adapter.adapt('item/completed', { item: { type: 'agentMessage', id: 'a1', text: 'done thinking' } });
    expect(events).toEqual([{ type: 'text_complete', text: 'done thinking', turnId: msgId('a1') }]);
  });

  it('maps a fileChange item → Edit tool_start/tool_result', () => {
    const start = adapter.adapt('item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }], status: 'inProgress' } });
    expect(start[0]).toMatchObject({ type: 'tool_start', toolName: 'Edit', toolUseId: 'f1' });
    const done = adapter.adapt('item/completed', { item: { type: 'fileChange', id: 'f1', changes: [], status: 'completed' } });
    expect(done[0]).toMatchObject({ type: 'tool_result', toolUseId: 'f1', toolName: 'Edit', isError: false });
  });

  describe('mcpToolCall items', () => {
    // Field names + values copied from generated/v2: ThreadItem's `mcpToolCall`
    // variant (`server`, `tool`, `status`, `arguments`, `result`, `error`),
    // McpToolCallStatus ("inProgress" | "completed" | "failed"), McpToolCallResult
    // ({ content, structuredContent, _meta }) and McpToolCallError ({ message }).
    // The server/tool pair is the real one from the MCP-W2 live run. F1.217: the
    // row is codex's raw pair (the host's spelling), NOT the name the model was
    // handed — `plugin_cdp_echo_probe_echo__whoami` in `mcp__sources` (F1.155).
    const POOL_TOOL = 'plugin_cdp-echo-probe_echo__whoami';
    const HOST_ROW_NAME = `mcp__sources__${POOL_TOOL}`;

    it('maps a successful call → tool_start with the host row name, then tool_result with the text content', () => {
      const start = adapter.adapt('item/started', {
        item: {
          type: 'mcpToolCall',
          id: 'm1',
          server: 'sources',
          tool: POOL_TOOL,
          status: 'inProgress',
          arguments: { probe: 'G6PLUGIN' },
          appContext: null,
          pluginId: null,
          result: null,
          error: null,
        },
      });
      expect(start[0]).toMatchObject({
        type: 'tool_start',
        toolName: HOST_ROW_NAME,
        toolUseId: 'm1',
        input: { probe: 'G6PLUGIN' },
        turnId: 'turn-1',
      });

      const done = adapter.adapt('item/completed', {
        item: {
          type: 'mcpToolCall',
          id: 'm1',
          server: 'sources',
          tool: POOL_TOOL,
          status: 'completed',
          arguments: { probe: 'G6PLUGIN' },
          appContext: null,
          pluginId: null,
          result: {
            content: [
              { type: 'text', text: 'plugin-echo G6PLUGIN-A23DA053D3F4' },
              { type: 'text', text: 'nonce=da1f7dff16f7' },
            ],
            structuredContent: { nonce: 'da1f7dff16f7' },
            _meta: null,
          },
          error: null,
        },
      });
      expect(done[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'm1',
        toolName: HOST_ROW_NAME,
        result: 'plugin-echo G6PLUGIN-A23DA053D3F4\nnonce=da1f7dff16f7',
        isError: false,
        structuredContent: { nonce: 'da1f7dff16f7' },
      });
    });

    it('builds the name verbatim from server+tool, so a non-pool server keeps its own segment', () => {
      // The bundled session server's key is `session` (config-writer's
      // `[mcp_servers.session]`), so this row reads `mcp__session__call_llm` —
      // byte-identical to what Pi and the Claude SDK put on the wire for the
      // same tool. It read `mcp__nessy_session__call_llm` before the wire-name
      // unification, and that was the whole of Codex's divergence.
      const start = adapter.adapt('item/started', {
        item: {
          type: 'mcpToolCall',
          id: 'm2',
          server: 'session',
          tool: 'call_llm',
          status: 'inProgress',
          arguments: {},
          appContext: null,
          pluginId: null,
          result: null,
          error: null,
        },
      });
      expect(start[0]).toMatchObject({ type: 'tool_start', toolName: 'mcp__session__call_llm' });
    });

    it('flags a failed call as an error and surfaces the error message', () => {
      const done = adapter.adapt('item/completed', {
        item: {
          type: 'mcpToolCall',
          id: 'm3',
          server: 'sources',
          tool: POOL_TOOL,
          status: 'failed',
          arguments: {},
          appContext: null,
          pluginId: null,
          result: null,
          error: { message: 'tool not found' },
        },
      });
      expect(done[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'm3',
        toolName: HOST_ROW_NAME,
        result: 'tool not found',
        isError: true,
      });
    });

    it('treats a failed status without an error object as an error, and non-object arguments as no input', () => {
      const start = adapter.adapt('item/started', {
        item: {
          type: 'mcpToolCall',
          id: 'm4',
          server: 'sources',
          tool: POOL_TOOL,
          status: 'inProgress',
          arguments: 'not-an-object',
          appContext: null,
          pluginId: null,
          result: null,
          error: null,
        },
      });
      expect(start[0]).toMatchObject({ type: 'tool_start', toolUseId: 'm4', input: {} });

      const done = adapter.adapt('item/completed', {
        item: {
          type: 'mcpToolCall',
          id: 'm4',
          server: 'sources',
          tool: POOL_TOOL,
          status: 'failed',
          arguments: {},
          appContext: null,
          pluginId: null,
          result: null,
          error: null,
        },
      });
      expect(done[0]).toMatchObject({ type: 'tool_result', toolUseId: 'm4', isError: true });
      expect((done[0] as { result: string }).result).toBeTruthy();
    });

    it('falls back to serialized content when the result carries no text block', () => {
      const done = adapter.adapt('item/completed', {
        item: {
          type: 'mcpToolCall',
          id: 'm5',
          server: 'sources',
          tool: POOL_TOOL,
          status: 'completed',
          arguments: {},
          appContext: null,
          pluginId: null,
          result: {
            content: [{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }],
            structuredContent: null,
            _meta: null,
          },
          error: null,
        },
      });
      expect(done[0]).toMatchObject({ type: 'tool_result', toolUseId: 'm5', isError: false });
      expect((done[0] as { result: string }).result).toContain('image');
      expect(done[0]).not.toHaveProperty('structuredContent');
    });
  });

  it('leaves item types the adapter does not map alone', () => {
    expect(adapter.adapt('item/started', { item: { type: 'dynamicToolCall', id: 'd1' } })).toEqual([]);
    expect(adapter.adapt('item/completed', { item: { type: 'dynamicToolCall', id: 'd1' } })).toEqual([]);
  });

  it('maps turn/completed → complete; ignores tokenUsage + unknown methods', () => {
    expect(adapter.adapt('turn/completed', { threadId: 't', turn: {} })).toEqual([{ type: 'complete' }]);
    expect(adapter.adapt('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 5 } } })).toEqual([]);
    expect(adapter.adapt('thread/started', { thread: {} })).toEqual([]);
  });

  it('readTokenUsage extracts the tokenUsage payload', () => {
    // camelCase, per the generated contract and the shipped app-server binary.
    // These fixtures were snake_case, which is why the reader's snake_case bug
    // had a green test over it for its whole life.
    const usage = CodexEventAdapter.readTokenUsage({ threadId: 't', turnId: 'u', tokenUsage: { total: { inputTokens: 10, outputTokens: 20 }, modelContextWindow: 32000 } });
    expect(usage?.total?.inputTokens).toBe(10);
    expect(usage?.modelContextWindow).toBe(32000);
  });

  describe('readCodexTokenCount', () => {
    it('reads the contract casing', () => {
      expect(readCodexTokenCount({ inputTokens: 42, outputTokens: 7 }, 'input')).toBe(42);
      expect(readCodexTokenCount({ inputTokens: 42, outputTokens: 7 }, 'output')).toBe(7);
    });

    it('still reads an older app-server that speaks snake_case', () => {
      expect(readCodexTokenCount({ input_tokens: 3 }, 'input')).toBe(3);
      expect(readCodexTokenCount({ output_tokens: 4 }, 'output')).toBe(4);
    });

    it('prefers the contract casing when a payload carries both', () => {
      expect(readCodexTokenCount({ inputTokens: 1, input_tokens: 999 }, 'input')).toBe(1);
    });

    it('reports zero rather than NaN for a missing or unusable figure', () => {
      // The previous reader's `?? 0` produced this for EVERY turn, silently.
      expect(readCodexTokenCount(undefined, 'input')).toBe(0);
      expect(readCodexTokenCount({}, 'output')).toBe(0);
      expect(readCodexTokenCount({ inputTokens: Number.NaN }, 'input')).toBe(0);
      expect(readCodexTokenCount({ inputTokens: -5 }, 'input')).toBe(0);
    });
  });

  describe('compaction is visible on codex', () => {
    // Both shapes, because the contract deprecates one in favour of the other
    // ("Use `ContextCompaction` item type instead") while the app-server we
    // bundle still emits it — handling only the documented replacement would
    // have been silent on today's binary.
    const pair: AgentEvent[] = [
      { type: 'status', message: 'Compacting context...' },
      { type: 'info', message: 'Compacted context to fit within limits' },
    ];

    it('maps the deprecated thread/compacted notification', () => {
      expect(adapter.adapt('thread/compacted', { threadId: 't', turnId: 'u' })).toEqual(pair);
    });

    it('maps the contextCompaction item', () => {
      expect(adapter.adapt('item/completed', { item: { type: 'contextCompaction', id: 'c1' } })).toEqual(pair);
    });

    it('uses the exact words the session layer routes on', () => {
      // Not cosmetic: SessionManager stamps `statusType: 'compacting'` from
      // `message.includes('Compacting')` and `compaction_complete` from
      // `message.startsWith('Compacted')` — the second is what persists the
      // transcript row and refreshes the context badge. Reworded, both vanish.
      const [status, info] = adapter.adapt('thread/compacted', {}) as Array<{ message: string }>;
      expect(status!.message).toContain('Compacting');
      expect(info!.message.startsWith('Compacted')).toBe(true);
    });
  });

  it('produces a full ordered sequence for a text+command turn', () => {
    const seq: AgentEvent[] = [
      ...adapter.adapt('item/agentMessage/delta', { delta: 'let me look' }),
      ...adapter.adapt('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'ls' } }),
      ...adapter.adapt('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls', aggregatedOutput: 'x', exitCode: 0 } }),
      ...adapter.adapt('turn/completed', {}),
    ];
    expect(seq.map((e) => e.type)).toEqual(['text_delta', 'tool_start', 'tool_result', 'complete']);
  });

  // `collabAgentToolCall` — the subagent calls an agent role invites. Until
  // this mapping the whole exchange was invisible in the chat, unlike Pi
  // (agent panel + subtask pair) and Claude (Agent tool row). Field names per
  // generated/v2 ThreadItem; the WIRE spellings (spawn_agent, wait_agent) are
  // pinned by the bundled binary's own rollout records, observed live on the
  // CDX-ROLES gate 2026-08-13.
  it('maps a spawnAgent collab call → spawn_agent tool_start/tool_result', () => {
    const start = adapter.adapt('item/started', {
      item: {
        type: 'collabAgentToolCall', id: 'cl1', tool: 'spawnAgent', status: 'inProgress',
        senderThreadId: 'parent', receiverThreadIds: ['child-1'],
        prompt: 'Reply with your codeword and nothing else.', model: null,
      },
    });
    expect(start[0]).toMatchObject({
      type: 'tool_start', toolUseId: 'cl1', toolName: 'spawn_agent',
      input: { prompt: 'Reply with your codeword and nothing else.', agents: ['child-1'] },
    });

    const done = adapter.adapt('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'cl1', tool: 'spawnAgent', status: 'completed',
        senderThreadId: 'parent', receiverThreadIds: ['child-1'],
        agents: { 'child-1': { status: 'running', message: null } },
      },
    });
    expect(done[0]).toMatchObject({
      type: 'tool_result', toolUseId: 'cl1', toolName: 'spawn_agent', isError: false, result: 'child-1: running',
    });
  });

  it('maps a wait collab call → wait_agent carrying each target agent\'s state, and failed → isError', () => {
    const done = adapter.adapt('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'cl2', tool: 'wait', status: 'completed',
        senderThreadId: 'parent', receiverThreadIds: ['child-1'],
        agents: { 'child-1': { status: 'completed', message: 'ZEPHYR-abc' } },
      },
    });
    expect(done[0]).toMatchObject({
      type: 'tool_result', toolUseId: 'cl2', toolName: 'wait_agent', isError: false,
      result: 'child-1: completed — ZEPHYR-abc',
    });

    const failed = adapter.adapt('item/completed', {
      item: { type: 'collabAgentToolCall', id: 'cl3', tool: 'spawnAgent', status: 'failed', senderThreadId: 'parent' },
    });
    expect(failed[0]).toMatchObject({ type: 'tool_result', toolUseId: 'cl3', toolName: 'spawn_agent', isError: true });
  });

  it('closes a collab call the runtime never completed — a refused spawn must not spin forever', () => {
    // Measured live (CDX-ROLES): `unknown agent_type` spawns get item/started
    // and no item/completed, so the row stayed "executing" until this close-out.
    adapter.adapt('item/started', {
      item: { type: 'collabAgentToolCall', id: 'cl-ok', tool: 'spawnAgent', status: 'inProgress', senderThreadId: 'p' },
    });
    adapter.adapt('item/completed', {
      item: { type: 'collabAgentToolCall', id: 'cl-ok', tool: 'spawnAgent', status: 'completed', senderThreadId: 'p' },
    });
    adapter.adapt('item/started', {
      item: { type: 'collabAgentToolCall', id: 'cl-refused', tool: 'spawnAgent', status: 'inProgress', senderThreadId: 'p' },
    });

    const end = adapter.adapt('turn/completed', {});
    expect(end.map(e => e.type)).toEqual(['tool_result', 'complete']);
    expect(end[0]).toMatchObject({ toolUseId: 'cl-refused', toolName: 'spawn_agent', isError: true });

    // And a clean turn closes with nothing but `complete`.
    adapter.startTurn('turn-2');
    expect(adapter.adapt('turn/completed', {}).map(e => e.type)).toEqual(['complete']);
  });

  describe('image items', () => {
    // Field names copied verbatim from the pinned generated contract:
    // `generated/v2/ThreadItem.ts` — `{ "type": "imageView", id, path }` and
    // `{ "type": "imageGeneration" } & ImageGenerationItem` — plus
    // `generated/ImageGenerationItem.ts` (`id, status, revisedPrompt, result,
    // transparentBackground?, failure, savedPath?`) and
    // `generated/ImageGenerationFailure.ts`
    // (`{ "type": "usageLimitExceeded", limitId, resetsAt }`).
    //
    // The rendered shape is the renderer's OWN inline-image block, not a new
    // one: a fenced ```image-preview whose JSON carries an on-disk `src`
    // (`packages/ui/src/components/markdown/MarkdownImageBlock.tsx`), the same
    // block the Pi side emits for a browser screenshot (`pi-agent.ts:6069`).
    const previewBlock = (src: string) => ['```image-preview', JSON.stringify({ src }, null, 2), '```'].join('\n');

    // A space in the path proves the path rides through JSON encoding intact.
    const VIEWED = '/Users/tester/Pictures/pasted image.png';
    const GENERATED = '/Users/tester/.codex/images/generated image.png';

    it('renders an imageView item instead of dropping it, carrying the path verbatim', () => {
      const events = adapter.adapt('item/completed', {
        item: { type: 'imageView', id: 'iv1', path: VIEWED },
      });
      expect(events).toEqual([{ type: 'text_complete', text: previewBlock(VIEWED), turnId: imgId('imageView', 'iv1') }]);
      expect((events[0] as { text: string }).text).toContain(VIEWED);
    });

    it('renders an imageView exactly once when the runtime sends both started and completed', () => {
      // The contract puts a `ThreadItem` on BOTH notifications and never says
      // which types get a `started`, so the render fires on the first one that
      // carries a path and the second is suppressed.
      const started = adapter.adapt('item/started', { item: { type: 'imageView', id: 'iv2', path: VIEWED } });
      expect(started).toEqual([{ type: 'text_complete', text: previewBlock(VIEWED), turnId: imgId('imageView', 'iv2') }]);
      expect(adapter.adapt('item/completed', { item: { type: 'imageView', id: 'iv2', path: VIEWED } })).toEqual([]);

      // A new turn forgets the id — a later image is not swallowed by history.
      adapter.startTurn('turn-2');
      expect(adapter.adapt('item/completed', { item: { type: 'imageView', id: 'iv2', path: VIEWED } }))
        .toEqual([{ type: 'text_complete', text: previewBlock(VIEWED), turnId: imgId('imageView', 'iv2', 'turn-2') }]);
    });

    it('keys the once-per-turn guard by item type as well as id', () => {
      // Ids are only documented unique WITHIN an item type, so a bare-id guard
      // would let the view silence a same-id generation in the same turn.
      expect(adapter.adapt('item/completed', { item: { type: 'imageView', id: 'dup', path: VIEWED } }))
        .toEqual([{ type: 'text_complete', text: previewBlock(VIEWED), turnId: imgId('imageView', 'dup') }]);
      expect(adapter.adapt('item/completed', {
        item: {
          type: 'imageGeneration', id: 'dup', status: 'completed', revisedPrompt: null,
          result: 'ok', failure: null, savedPath: GENERATED,
        },
      })).toEqual([{ type: 'text_complete', text: previewBlock(GENERATED), turnId: imgId('imageGeneration', 'dup') }]);
    });

    it('reports an imageView whose path is blank instead of dropping it silently', () => {
      // Same dead-end treatment as a generation that completes with no saved
      // path: a durable `level: 'warning'` info, never an empty event list.
      expect(adapter.adapt('item/completed', { item: { type: 'imageView', id: 'iv3', path: '   ' } }))
        .toEqual([{ type: 'info', message: 'Image view arrived without a path', level: 'warning' }]);

      // And it closes the item — the notice is not repeated on a second
      // notification for the same id.
      expect(adapter.adapt('item/started', { item: { type: 'imageView', id: 'iv3', path: '' } })).toEqual([]);
    });

    it('waits for the completed notification before calling a blank path a dead end', () => {
      // P3.9 · warning at `started` CLOSED the item (any event marks it
      // rendered), so the `completed` notification that carried the real path
      // was dropped and the image never rendered. The notice is a `completed`
      // verdict now — the same phase gate the generation arm already had.
      expect(adapter.adapt('item/started', { item: { type: 'imageView', id: 'iv4', path: '' } })).toEqual([]);
      expect(adapter.adapt('item/completed', { item: { type: 'imageView', id: 'iv4', path: VIEWED } }))
        .toEqual([{ type: 'text_complete', text: previewBlock(VIEWED), turnId: imgId('imageView', 'iv4') }]);

      // A path that never arrives is still reported, not swallowed.
      expect(adapter.adapt('item/started', { item: { type: 'imageView', id: 'iv5', path: '  ' } })).toEqual([]);
      expect(adapter.adapt('item/completed', { item: { type: 'imageView', id: 'iv5', path: '' } }))
        .toEqual([{ type: 'info', message: 'Image view arrived without a path', level: 'warning' }]);
    });

    it('renders a generated image with its revised prompt as text above the block', () => {
      // In progress: nothing renderable yet, and nothing is marked as rendered.
      expect(adapter.adapt('item/started', {
        item: { type: 'imageGeneration', id: 'ig1', status: 'inProgress', revisedPrompt: null, result: '', failure: null },
      })).toEqual([]);

      const events = adapter.adapt('item/completed', {
        item: {
          type: 'imageGeneration', id: 'ig1', status: 'completed',
          revisedPrompt: 'a red bicycle on a wet street, cinematic light',
          result: 'ok', transparentBackground: false, failure: null, savedPath: GENERATED,
        },
      });
      expect(events).toEqual([{
        type: 'text_complete',
        text: `a red bicycle on a wet street, cinematic light\n\n${previewBlock(GENERATED)}`,
        turnId: imgId('imageGeneration', 'ig1'),
      }]);
    });

    it('renders a generated image with no revised prompt as the block alone', () => {
      const events = adapter.adapt('item/completed', {
        item: {
          type: 'imageGeneration', id: 'ig2', status: 'completed', revisedPrompt: null,
          result: 'ok', failure: null, savedPath: GENERATED,
        },
      });
      expect(events).toEqual([{ type: 'text_complete', text: previewBlock(GENERATED), turnId: imgId('imageGeneration', 'ig2') }]);
    });

    it('surfaces an image-generation failure as a persisted info row, not an image', () => {
      // `level: 'warning'` is not a severity judgement — it is the only info
      // level SessionManager appends to the transcript (`case 'info'`), so it is
      // the only one that survives a reload. `type: 'error'` is disqualified
      // separately: the renderer's `handleError` ends the visible turn.
      const events = adapter.adapt('item/completed', {
        item: {
          type: 'imageGeneration', id: 'ig3', status: 'failed', revisedPrompt: null, result: '',
          failure: { type: 'usageLimitExceeded', limitId: 'image_gen_daily', resetsAt: 1755800000 },
        },
      });
      expect(events).toEqual([{
        type: 'info',
        message: 'Image generation failed: usageLimitExceeded, limit image_gen_daily, resetsAt 1755800000',
        level: 'warning',
      }]);
      expect(JSON.stringify(events)).not.toContain('image-preview');
    });

    it('waits for the completed notification before calling a generation failed', () => {
      // P3.14 · the last un-gated arm in this function. `renderImageItem` closes
      // an item on the FIRST notification that produces any event, so a
      // `started` notification already carrying `failure` (or `status:
      // 'failed'`) emitted the verdict and retired the item — and the
      // `completed` notification carrying the real `savedPath` was then dropped,
      // so a generation that recovered rendered no image at all. Same shape,
      // same gate, as the blank-path arm above.
      expect(adapter.adapt('item/started', {
        item: {
          type: 'imageGeneration', id: 'ig5', status: 'failed', revisedPrompt: null, result: '',
          failure: { type: 'usageLimitExceeded', limitId: 'image_gen_daily', resetsAt: 1755800000 },
        },
      })).toEqual([]);
      expect(adapter.adapt('item/completed', {
        item: {
          type: 'imageGeneration', id: 'ig5', status: 'completed', revisedPrompt: null,
          result: 'ok', failure: null, savedPath: GENERATED,
        },
      })).toEqual([{ type: 'text_complete', text: previewBlock(GENERATED), turnId: imgId('imageGeneration', 'ig5') }]);

      // A failure that is still a failure at `completed` is reported as before.
      expect(adapter.adapt('item/started', {
        item: { type: 'imageGeneration', id: 'ig6', status: 'failed', revisedPrompt: null, result: '', failure: null },
      })).toEqual([]);
      expect(adapter.adapt('item/completed', {
        item: {
          type: 'imageGeneration', id: 'ig6', status: 'failed', revisedPrompt: null, result: '',
          failure: { type: 'usageLimitExceeded', limitId: 'image_gen_daily', resetsAt: 1755800000 },
        },
      })).toEqual([{
        type: 'info',
        message: 'Image generation failed: usageLimitExceeded, limit image_gen_daily, resetsAt 1755800000',
        level: 'warning',
      }]);
    });

    it('still says something when a generation completes with neither a path nor a failure', () => {
      const events = adapter.adapt('item/completed', {
        item: { type: 'imageGeneration', id: 'ig4', status: 'completed', revisedPrompt: null, result: '', failure: null },
      });
      expect(events).toEqual([{
        type: 'info',
        message: 'Image generation completed without a saved image path',
        level: 'warning',
      }]);
    });

    it('leaves every other unmapped item and method on the silent default arm', () => {
      // The regression guard: adding the two image arms (and F1.623's
      // webSearch arm) must not turn an unknown item type or an unknown method
      // into an event.
      expect(adapter.adapt('item/started', { item: { type: 'sleep', id: 's1' } })).toEqual([]);
      expect(adapter.adapt('item/completed', { item: { type: 'sleep', id: 's1' } })).toEqual([]);
      expect(adapter.adapt('item/completed', { item: { type: 'enteredReviewMode', id: 'r1', review: 'x' } })).toEqual([]);
      expect(adapter.adapt('item/completed', {})).toEqual([]);
      expect(adapter.adapt('thread/somethingNewUpstream', { item: { type: 'imageView', id: 'iv9', path: VIEWED } }))
        .toEqual([]);
    });
  });

  // F1.623 · codex's OWN hosted web search. Item shape verbatim from
  // generated/WebSearchItem.ts + generated/v2/WebSearchAction.ts, and the
  // lifecycle from openai/codex rust-v0.156.1: the item starts at
  // `response.output_item.added` with `query: ""` and no action detail
  // (`core/src/event_mapping.rs`, `None => (WebSearchAction::Other, String::new())`),
  // and completes with `query` = codex's own `web_search_action_detail`.
  describe('webSearch items (F1.623)', () => {
    const started = { type: 'webSearch', id: 'ws_1', query: '', action: { type: 'other' }, results: null };

    it('opens a WebSearch row at start and fills it with the query at completion', () => {
      expect(adapter.adapt('item/started', { item: started })).toEqual([
        expect.objectContaining({ type: 'tool_start', toolName: 'WebSearch', toolUseId: 'ws_1', input: {} }),
      ]);
      const done = adapter.adapt('item/completed', {
        item: {
          type: 'webSearch', id: 'ws_1', query: 'bun test name filter',
          action: { type: 'search', query: 'bun test name filter', queries: null }, results: null,
        },
      });
      expect(done).toHaveLength(2);
      const reStart = done[0] as Extract<AgentEvent, { type: 'tool_start' }>;
      expect(reStart.type).toBe('tool_start');
      expect(reStart.toolUseId).toBe('ws_1');
      expect(reStart.toolName).toBe('WebSearch');
      expect(reStart.input).toEqual({ query: 'bun test name filter' });
      const result = done[1] as Extract<AgentEvent, { type: 'tool_result' }>;
      expect(result.type).toBe('tool_result');
      expect(result.toolUseId).toBe('ws_1');
      expect(result.toolName).toBe('WebSearch');
      expect(result.isError).toBe(false);
      expect(result.result).toContain('bun test name filter');
      expect(result.result).toContain('not reported to this app');
    });

    it('carries every query of a multi-query search, and a page action as its own detail', () => {
      const multi = adapter.adapt('item/completed', {
        item: {
          type: 'webSearch', id: 'ws_2', query: 'first ...',
          action: { type: 'search', query: null, queries: ['first', 'second'] }, results: null,
        },
      });
      expect((multi[0] as Extract<AgentEvent, { type: 'tool_start' }>).input)
        .toEqual({ query: 'first ...', queries: ['first', 'second'] });
      const page = adapter.adapt('item/completed', {
        item: {
          type: 'webSearch', id: 'ws_3', query: 'https://bun.sh/docs',
          action: { type: 'openPage', url: 'https://bun.sh/docs' }, results: null,
        },
      });
      expect((page[0] as Extract<AgentEvent, { type: 'tool_start' }>).input).toEqual({ query: 'https://bun.sh/docs' });
      expect((page[1] as Extract<AgentEvent, { type: 'tool_result' }>).result).toContain('Opened: https://bun.sh/docs');
    });

    it('passes codex\'s out-of-band results through when a standalone search reports them', () => {
      const done = adapter.adapt('item/completed', {
        item: {
          type: 'webSearch', id: 'ws_4', query: 'q',
          action: { type: 'search', query: 'q', queries: null },
          results: [{ title: 'Bun', url: 'https://bun.sh' }],
        },
      });
      const text = (done[1] as Extract<AgentEvent, { type: 'tool_result' }>).result;
      expect(text).toContain('https://bun.sh');
      expect(text).not.toContain('not reported to this app');
    });
  });
});

describe('CodexEventAdapter — auto-review guardian (P3.2)', () => {
  let adapter: CodexEventAdapter;
  beforeEach(() => {
    adapter = new CodexEventAdapter();
    adapter.startTurn('turn-1');
  });

  // Wire method names + payload fields are verbatim from generated/v2:
  // ItemGuardianApprovalReviewStartedNotification (item/autoApprovalReview/started),
  // ItemGuardianApprovalReviewCompletedNotification (item/autoApprovalReview/completed),
  // GuardianWarningNotification (guardianWarning).
  const completed = (status: string, extra: Record<string, unknown> = {}) => ({
    threadId: 't', turnId: 'u', startedAtMs: 1, completedAtMs: 2, reviewId: 'r1',
    targetItemId: 'i1', decisionSource: 'agent',
    review: { status, riskLevel: null, userAuthorization: null, rationale: null, ...extra },
    action: { type: 'command', source: 'shell', command: 'rm -rf /', cwd: '/repo' },
  });

  it('surfaces item/autoApprovalReview/started as a momentary status (not default-dropped)', () => {
    const events = adapter.adapt('item/autoApprovalReview/started', {
      threadId: 't', turnId: 'u', startedAtMs: 1, reviewId: 'r1', targetItemId: 'i1',
      review: { status: 'inProgress', riskLevel: null, userAuthorization: null, rationale: null },
      action: { type: 'command', source: 'shell', command: 'ls', cwd: '/repo' },
    });
    expect(events).toEqual([{ type: 'status', message: 'Auto-reviewing this action...', phase: true }]); // F1.1150 — a phase label
  });

  it('surfaces an approved review as a momentary status carrying the risk level', () => {
    const events = adapter.adapt('item/autoApprovalReview/completed', completed('approved', { riskLevel: 'low' }));
    expect(events).toEqual([{ type: 'status', message: 'Auto-review approved this action [risk: low]' }]);
  });

  it('surfaces a denied review as a DURABLE info+warning with rationale and risk', () => {
    const events = adapter.adapt('item/autoApprovalReview/completed',
      completed('denied', { riskLevel: 'high', rationale: 'writes outside workspace' }));
    expect(events).toEqual([{
      type: 'info',
      message: 'Auto-review denied the request to run `rm -rf /` in /repo: writes outside workspace [risk: high]',
      level: 'warning',
    }]);
  });

  it('surfaces timedOut/aborted as a durable info+warning', () => {
    expect(adapter.adapt('item/autoApprovalReview/completed', completed('timedOut'))).toEqual([
      { type: 'info', message: 'Auto-review timedOut for the request to run `rm -rf /` in /repo', level: 'warning' },
    ]);
  });

  it('surfaces guardianWarning as a durable info+warning, and drops an empty one', () => {
    expect(adapter.adapt('guardianWarning', { threadId: 't', message: 'network egress blocked' })).toEqual([
      { type: 'info', message: 'Guardian: network egress blocked', level: 'warning' },
    ]);
    expect(adapter.adapt('guardianWarning', { threadId: 't', message: '   ' })).toEqual([]);
  });

  /**
   * P6.1065 — the fourth family, and the one that was still dying in `default:`.
   *
   * The frame is verbatim `StrictReviewRequiredNotification`
   * (`generated/v2/`, ts-rs output from `rust-v0.150.1`): `threadId`, `turnId`
   * and `startedAtMs`, and NOTHING else — no reason, no action. So the sentence
   * asserted here says that strict review was demanded and when the review
   * started, and deliberately does not name a cause the wire never carries.
   */
  it('surfaces autoApprovalReview/strictReviewRequired as a DURABLE info+warning', () => {
    expect(adapter.adapt('autoApprovalReview/strictReviewRequired', {
      threadId: 't', turnId: 'u', startedAtMs: 0,
    })).toEqual([{
      type: 'info',
      message: 'Auto-review requires a strict review of this turn'
        + ' (review started 1970-01-01T00:00:00.000Z).'
        + " The runtime's own reviewer could not approve from its cached assessment.",
      level: 'warning',
    }]);
  });

  /**
   * The NEGATIVE arm, and it is two propositions in one case, because a single
   * `[]` proves neither alone: a frame this handler cannot stand behind produces
   * nothing, and a DIFFERENT notification does not reach this sentence at all.
   * Without the second half a handler that answered every method with the
   * strict-review line would pass the positive test above.
   */
  it('drops a strict-review frame naming no turn, and leaves an unrelated notification untouched', () => {
    // No `turnId`: the sentence would be about nothing.
    expect(adapter.adapt('autoApprovalReview/strictReviewRequired', {
      threadId: 't', startedAtMs: 5,
    })).toEqual([]);
    // A neighbouring family in the same union is not this one.
    expect(adapter.adapt('thread/queue/changed', { threadId: 't', turnId: 'u', startedAtMs: 5 }))
      .toEqual([]);
  });

  it('trips the denial breaker on the 3rd consecutive denied review, once', () => {
    const first = adapter.adapt('item/autoApprovalReview/completed', completed('denied'));
    const second = adapter.adapt('item/autoApprovalReview/completed', completed('denied'));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const third = adapter.adapt('item/autoApprovalReview/completed', completed('denied'));
    expect(third).toHaveLength(2); // deny notice + the one-shot interruption notice (F1.388)
    expect(third[1]).toEqual({
      type: 'info',
      message: 'Auto-review has denied 3 actions, so Codex is interrupting the turn.',
      level: 'warning',
    });
    // A 4th denial does NOT re-announce — the circuit is already open.
    expect(adapter.adapt('item/autoApprovalReview/completed', completed('denied'))).toHaveLength(1);
  });

  /**
   * P2.417 · ALL SIX variants of `GuardianApprovalReviewAction` (rust-v0.148.0),
   * rendered through the REAL notification path rather than through the
   * describer alone — the row's whole point is that a describer producing a good
   * sentence for the one variant that motivated it and a bare object for the
   * other five is the same defect wearing a fix. A fresh adapter per case so the
   * denial breaker never adds its one-shot notice mid-table.
   *
   * KILLS: reading `action` for `networkAccess` only; dropping the "the request
   * to" fronting so the sentence stops parsing; and a seventh variant from a
   * future binary rendering as nothing.
   */
  it('names every variant of the reviewed action on the durable denial line', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'command', source: 'shell', command: 'rm -rf build', cwd: '/repo' },
        'Auto-review denied the request to run `rm -rf build` in /repo'],
      [{ type: 'execve', source: 'shell', program: '/bin/sh', argv: ['-c', 'echo hi'], cwd: '/repo' },
        'Auto-review denied the request to execute `/bin/sh -c echo hi` in /repo'],
      [{ type: 'applyPatch', cwd: '/repo', files: ['/repo/a.ts', '/repo/b.ts'] },
        'Auto-review denied the request to patch /repo/a.ts, /repo/b.ts'], // F1.724 — the files, not the turn's folder
      [{ type: 'networkAccess', target: 'api', host: 'api.example.com', protocol: 'https', port: 443 },
        'Auto-review denied the request to reach api.example.com:443 over https'],
      [{ type: 'mcpToolCall', server: 'github', toolName: 'create_issue',
        connectorId: null, connectorName: null, toolTitle: null },
        'Auto-review denied the request to call MCP tool github/create_issue'],
      [{ type: 'requestPermissions', reason: 'install deps', permissions: { network: { enabled: true } } },
        "Auto-review denied the request to widen this turn's permissions (network access) — install deps"],
      // Not a variant of the union — a seventh the binary could grow. It must
      // still NAME something; that is the silence this row closes.
      [{ type: 'somethingNew', detail: 'x' },
        'Auto-review denied the request to somethingNew'],
    ];
    for (const [action, message] of cases) {
      const fresh = new CodexEventAdapter();
      fresh.startTurn('turn-variants');
      expect(fresh.adapt('item/autoApprovalReview/completed', { ...completed('denied'), action }))
        .toEqual([{ type: 'info', message, level: 'warning' }]);
    }
  });

  /**
   * KILLS: a payload with no readable action throwing, or rendering an empty
   * subject. The sentence must degrade to exactly the one it has always carried.
   */
  it('falls back to the frozen "this action" when no action is readable', () => {
    for (const action of [undefined, null, {}, 'nope', 42]) {
      const fresh = new CodexEventAdapter();
      fresh.startTurn('turn-fallback');
      expect(fresh.adapt('item/autoApprovalReview/completed', { ...completed('denied'), action }))
        .toEqual([{ type: 'info', message: 'Auto-review denied this action', level: 'warning' }]);
    }
  });

  /**
   * P2.417 · `/approve` names WHAT it overruled. `CodexAgent` calls
   * `notifyGuardianOverride()` with no argument from both of its arms, so the
   * name can only come from the adapter's own memory of the latest denial —
   * deliberately the same "latest denial" `relayGuardianOverride` replays.
   *
   * KILLS: an override notice that names nobody once a denial has been seen, and
   * a fabricated name when none has.
   */
  it('/approve names the denial it overrules, and stays frozen when there is none', () => {
    const fresh = new CodexEventAdapter();
    fresh.startTurn('turn-approve');
    expect(fresh.notifyGuardianOverride()).toEqual([{
      type: 'info',
      message: 'You approved a guardian-denied action; auto-review will resume for the rest of this turn.',
      level: 'warning',
    }]);
    fresh.adapt('item/autoApprovalReview/completed', {
      ...completed('denied'),
      action: { type: 'networkAccess', target: 'api', host: 'api.example.com', protocol: 'https', port: 443 },
    });
    expect(fresh.notifyGuardianOverride()).toEqual([{
      type: 'info',
      message: 'You approved a guardian-denied request to reach api.example.com:443 over https; '
        + 'auto-review will resume for the rest of this turn.',
      level: 'warning',
    }]);
  });

  it('/approve override resets the breaker so surfacing resumes and re-trips only after a fresh 3', () => {
    for (let i = 0; i < 3; i++) adapter.adapt('item/autoApprovalReview/completed', completed('denied'));
    const override = adapter.notifyGuardianOverride();
    expect(override).toEqual([{
      type: 'info',
      message: 'You approved a guardian-denied request to run `rm -rf /` in /repo; auto-review will resume for the rest of this turn.',
      level: 'warning',
    }]);
    // After the override, two denials do not re-trip; the third does.
    expect(adapter.adapt('item/autoApprovalReview/completed', completed('denied'))).toHaveLength(1);
    expect(adapter.adapt('item/autoApprovalReview/completed', completed('denied'))).toHaveLength(1);
    expect(adapter.adapt('item/autoApprovalReview/completed', completed('denied'))).toHaveLength(2);
  });

  it('an approval between denials keeps the breaker closed (resets the run)', () => {
    adapter.adapt('item/autoApprovalReview/completed', completed('denied'));
    adapter.adapt('item/autoApprovalReview/completed', completed('denied'));
    adapter.adapt('item/autoApprovalReview/completed', completed('approved'));
    // Two more denials → only 2 consecutive, no trip.
    adapter.adapt('item/autoApprovalReview/completed', completed('denied'));
    expect(adapter.adapt('item/autoApprovalReview/completed', completed('denied'))).toHaveLength(1);
  });

  it('resets the breaker at the turn boundary', () => {
    adapter.adapt('item/autoApprovalReview/completed', completed('denied'));
    adapter.adapt('item/autoApprovalReview/completed', completed('denied'));
    adapter.startTurn('turn-2'); // new turn → onTurnStart resets the breaker
    // A single denial in the new turn must not read as the 3rd of the old turn.
    expect(adapter.adapt('item/autoApprovalReview/completed', completed('denied'))).toHaveLength(1);
  });

  it('positive control: an unknown method still falls through to the silent default', () => {
    expect(adapter.adapt('item/somethingNewUpstream', { threadId: 't' })).toEqual([]);
  });
});

/**
 * P6.574 — the codex arm of the host secret scan.
 *
 * Until this arm landed, a codex tool result reached the model unscanned while
 * a Pi one did not: the same repository, the same credential, two different
 * answers depending on which runtime the user had picked — a manufactured
 * divergence, which is what the row calls it.
 *
 * The fixtures are credential-SHAPED and deliberately not credentials: a
 * `glpat-` prefix followed by an obvious sentence. No file in this tree may
 * carry a real token, and the rules match on prefix + charset, so a fake of the
 * right shape exercises exactly what a real one would.
 */
describe('CodexEventAdapter — tool results are scanned for secrets (P6.574)', () => {
  const FAKE_GITLAB_PAT = 'glpat-notARealTokenJustShaped1';

  function bashResult(output: string): { result: string } {
    const adapter = new CodexEventAdapter();
    adapter.startTurn('turn-scan');
    adapter.adapt('item/started', { item: { type: 'commandExecution', id: 's1', command: 'cat .env' } });
    const done = adapter.adapt('item/completed', {
      item: { type: 'commandExecution', id: 's1', command: 'cat .env', aggregatedOutput: output, exitCode: 0 },
    });
    return done[0] as unknown as { result: string };
  }

  it('redacts a credential-shaped value and says so, count-only', () => {
    const { result } = bashResult(`TOKEN=${FAKE_GITLAB_PAT}\n`);

    expect(result).not.toContain(FAKE_GITLAB_PAT);
    expect(result).toContain('[REDACTED:gitlab-pat]');
    // The notice names the rule and the count and NEVER the bytes.
    expect(result).toContain('gitlab-pat×1');
    expect(result).toContain('1 credential-shaped value redacted');
  });

  it('leaves an ordinary result byte-identical — no notice, no marker', () => {
    const clean = 'file1\nfile2\nglpat-tooshort\n';

    expect(bashResult(clean).result).toBe(clean);
  });

  it('covers the collab path too, not just Bash — the override is the seam', () => {
    const adapter = new CodexEventAdapter();
    adapter.startTurn('turn-scan-2');
    const done = adapter.adapt('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'cb1', tool: 'wait', status: 'completed',
        senderThreadId: 'parent', receiverThreadIds: ['child-1'],
        agents: { 'child-1': { status: 'completed', message: `codeword ${FAKE_GITLAB_PAT}` } },
      },
    });

    const { result } = done[0] as unknown as { result: string };
    expect(result).not.toContain(FAKE_GITLAB_PAT);
    expect(result).toContain('[REDACTED:gitlab-pat]');
  });

  /**
   * P6.753 — the MACHINE payload, which P6.574 had stated as a known exclusion.
   *
   * `item.result.structuredContent` is an MCP tool's own record, it rides the
   * same `tool_result` event, and the event is persisted with the session — so a
   * credential arriving only there was carried in full while the text beside it
   * was scrubbed.
   */
  function mcpResult(
    result: Record<string, unknown>,
  ): { result: string; structuredContent?: Record<string, unknown> } {
    const adapter = new CodexEventAdapter();
    adapter.startTurn('turn-scan-3');
    const done = adapter.adapt('item/completed', {
      item: {
        type: 'mcpToolCall', id: 'm-scan', server: 'sources', tool: 'whoami',
        status: 'completed', arguments: {}, appContext: null, pluginId: null,
        result, error: null,
      },
    });
    return done[0] as unknown as { result: string; structuredContent?: Record<string, unknown> };
  }

  it('redacts a credential that arrives ONLY in structuredContent', () => {
    const event = mcpResult({
      content: [{ type: 'text', text: 'identity resolved' }],
      structuredContent: { session: { header: `Bearer ${FAKE_GITLAB_PAT}` }, user: 'nobody' },
    });

    const session = (event.structuredContent as { session: { header: string } }).session;
    expect(session.header).toBe('Bearer [REDACTED:gitlab-pat]');
    // The shape the record had is the shape it keeps.
    expect((event.structuredContent as { user: string }).user).toBe('nobody');
    // The notice lands on the text, count-only, even though the text was clean.
    expect(event.result).toContain('gitlab-pat×1');
    expect(event.result).not.toContain(FAKE_GITLAB_PAT);
  });

  it('leaves a clean structuredContent byte-identical — no notice, no marker', () => {
    const event = mcpResult({
      content: [{ type: 'text', text: 'identity resolved' }],
      structuredContent: { user: 'nobody', attempts: 1 },
    });

    expect(event.result).toBe('identity resolved');
    expect(event.structuredContent).toEqual({ user: 'nobody', attempts: 1 });
  });
});

/**
 * P6.446 — the codex arm of the cache counters.
 *
 * codex has reported `cachedInputTokens` and `cacheWriteInputTokens` all along
 * — both are non-optional in the generated v2 contract — and our reader
 * declared neither, so every codex turn recorded a cache reading of zero. That
 * is indistinguishable from a provider that does no caching, on the runtime this
 * product ships by default, which is why the tracker answers `unknown` rather
 * than `cold` for it.
 *
 * The conversion is the row's own trap, and it is asserted against a real
 * `UsageTracker` rather than by arithmetic: codex's `inputTokens` is the WHOLE
 * input (`non_cached_input()` = `input_tokens - cached_input()`,
 * `codex-rs/protocol/src/protocol.rs` at `rust-v0.150.1`) while the tracker sums
 * the three, so a naive carry-across would bill the cached half twice.
 */
describe('readCodexMessageUsage — the cache counters and the convention (P6.446)', () => {
  /** codex's own numbers for one warm turn. Total input, as codex reports it: 1000. */
  const CODEX_TURN = {
    inputTokens: 1000,
    cachedInputTokens: 700,
    cacheWriteInputTokens: 100,
    outputTokens: 50,
    totalTokens: 1050,
  };

  it('reads both counters and reduces the input by their sum', () => {
    expect(readCodexMessageUsage(CODEX_TURN)).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 700,
      cacheCreationTokens: 100,
    });
  });

  it('leaves the tracker\'s total input exactly the figure codex reported', async () => {
    const { createUsageTracker } = await import('../core/usage-tracker.ts');
    const tracker = createUsageTracker();
    tracker.recordMessageUsage(readCodexMessageUsage(CODEX_TURN));
    // 200 + 700 + 100. The naive carry (1000 + 700 + 100) would read 1800.
    expect(tracker.getLastMessageUsage()?.inputTokens).toBe(1000);

    const naive = createUsageTracker();
    naive.recordMessageUsage({
      inputTokens: CODEX_TURN.inputTokens,
      outputTokens: CODEX_TURN.outputTokens,
      cacheReadTokens: CODEX_TURN.cachedInputTokens,
      cacheCreationTokens: CODEX_TURN.cacheWriteInputTokens,
    });
    expect(naive.getLastMessageUsage()?.inputTokens).toBe(1800);
  });

  it('a breakdown with no cache counters is unchanged — the pre-fix control', () => {
    // The shape every codex turn produced before this row: the input is carried
    // whole and both cache counters are zero, so nothing that was right becomes
    // wrong.
    expect(readCodexMessageUsage({ inputTokens: 1000, outputTokens: 50 })).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(readCodexMessageUsage(undefined)).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    });
  });

  it('reads the legacy snake_case shape too, and never returns a negative input', () => {
    expect(readCodexTokenCount({ cached_input_tokens: 42 }, 'cacheRead')).toBe(42);
    expect(readCodexTokenCount({ cache_write_input_tokens: 7 }, 'cacheWrite')).toBe(7);
    // A release that counted the write half outside `input_tokens` would drive
    // the subtraction below zero; the clamp keeps a corrupt total out of every
    // downstream sum instead of propagating it.
    expect(readCodexMessageUsage({ inputTokens: 10, cachedInputTokens: 900 }).inputTokens).toBe(0);
  });
});
