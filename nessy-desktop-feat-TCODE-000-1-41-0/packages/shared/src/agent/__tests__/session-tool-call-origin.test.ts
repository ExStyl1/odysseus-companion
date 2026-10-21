/**
 * F1.475 (1/2) — a claude session tool's host port can read WHICH model tool call it runs for.
 *
 * The vendored binary sends `_meta: { "claudecode/toolUseId": <id> }` on every MCP `tools/call`, and the SDK hands
 * it to the in-process handler as `extra._meta` (measured on 2.1.251: a main-thread call read `toolu_main_whoami`,
 * a background subagent's call `toolu_sub_whoami`, each equal to its PreToolUse hook's `tool_use_id`). Before this
 * row `registryTool` dropped `extra` on the floor — its wrapper was `async (args) => def.handler(ctx, args)` — so
 * the host, which raises the Monitor and `archive_session` cards, saw the session key and nothing else.
 *
 * The rig is the REAL factory (`getSessionScopedTools`) and the REAL registry handler, driven through the handler
 * the MCP server registered, with the `extra` the SDK passes; the port is a stand-in for the host service, which
 * reads the scope the way the host's raise sites do (`currentSessionToolCall`).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { SessionMonitorPort } from '@nessy-agent/session-tools-core';
import { getSessionScopedTools, invalidateAllSessionToolsCaches } from '../session-scoped-tools.ts';
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tool-callback-registry.ts';
import {
  currentSessionToolCall,
  runInSessionToolCall,
  sessionToolCallOriginOf,
} from '../backend/claude/session-tool-call-origin.ts';
import type { SessionKey } from '../../sessions/session-key.ts';

const key: SessionKey = { workspaceId: 'ws-f1-475', sessionId: 'session-f1-475' };
const other: SessionKey = { workspaceId: 'ws-f1-475', sessionId: 'session-f1-475-other' };

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

function registeredHandler(name: string, at: SessionKey = key): Handler {
  invalidateAllSessionToolsCaches();
  const server = getSessionScopedTools(at.sessionId, '/tmp/f1-475-workspace', at.workspaceId, '/tmp/f1-475-workspace') as unknown as {
    instance: { _registeredTools: Record<string, { handler: Handler }> }
  };
  const entry = server.instance._registeredTools[name];
  if (!entry) throw new Error(`no registered ${name}`);
  return entry.handler;
}

/** The host service's stand-in: what the Monitor port saw in scope, for the session it serves AND for another. */
function recordingMonitorPort(at: SessionKey = key) {
  const seen: Array<{ own: unknown; other: unknown }> = [];
  const port: SessionMonitorPort = {
    start: async input => {
      await Promise.resolve(); // the host's authorize awaits before it raises; the scope must survive it
      seen.push({ own: currentSessionToolCall(at.sessionId), other: currentSessionToolCall(other.sessionId) });
      return { taskId: 'task-f1-475', timeoutMs: input.timeoutMs, persistent: false };
    },
    stop: async () => false,
  };
  return { port, seen };
}

const monitorArgs = { ws: { url: 'wss://example.test/feed' }, description: 'watch the feed' };
const sdkExtra = (toolUseId: string) => ({ _meta: { 'claudecode/toolUseId': toolUseId, progressToken: 3 }, requestId: 3 });

afterEach(() => {
  unregisterSessionScopedToolCallbacks(key);
  unregisterSessionScopedToolCallbacks(other);
  invalidateAllSessionToolsCaches();
});

describe('F1.475 — the in-process session tool puts the call\'s tool-use id in scope for the host port', () => {
  it('a Monitor call carrying the SDK\'s _meta reaches the port with { sessionId, toolUseId } in scope', async () => {
    const { port, seen } = recordingMonitorPort();
    mergeSessionScopedToolCallbacks(key, { monitorPort: port });

    await registeredHandler('Monitor')(monitorArgs, sdkExtra('toolu_sub_whoami'));

    expect(seen).toEqual([{ own: { sessionId: key.sessionId, toolUseId: 'toolu_sub_whoami' }, other: undefined }]);
  });

  it('CONTROL — a call whose extra names no tool-use id leaves nothing in scope (today\'s behaviour)', async () => {
    const { port, seen } = recordingMonitorPort();
    mergeSessionScopedToolCallbacks(key, { monitorPort: port });

    await registeredHandler('Monitor')(monitorArgs, { requestId: 4 });
    await registeredHandler('Monitor')(monitorArgs, undefined);

    expect(seen).toEqual([{ own: undefined, other: undefined }, { own: undefined, other: undefined }]);
  });

  it('BOUNDARY — a call with no id does not borrow the id of the tool call its async context descends from', async () => {
    const { port, seen } = recordingMonitorPort();
    mergeSessionScopedToolCallbacks(key, { monitorPort: port });
    const handler = registeredHandler('Monitor');

    await runInSessionToolCall({ sessionId: key.sessionId, toolUseId: 'toolu_outer' }, () => handler(monitorArgs, { requestId: 5 }));

    expect(seen).toEqual([{ own: undefined, other: undefined }]);
  });

  it('BOUNDARY — the scope names its session: another session\'s read of it answers undefined', () => {
    const inScope = runInSessionToolCall({ sessionId: key.sessionId, toolUseId: 'toolu_x' }, () => ({
      own: currentSessionToolCall(key.sessionId),
      other: currentSessionToolCall(other.sessionId),
    }));
    expect(inScope).toEqual({ own: { sessionId: key.sessionId, toolUseId: 'toolu_x' }, other: undefined });
    expect(currentSessionToolCall(key.sessionId)).toBeUndefined();
  });

  it('reads only a non-empty string under the binary\'s own key', () => {
    expect(sessionToolCallOriginOf('s', sdkExtra('toolu_1'))).toEqual({ sessionId: 's', toolUseId: 'toolu_1' });
    expect(sessionToolCallOriginOf('s', { _meta: { 'claudecode/toolUseId': '' } })).toBeUndefined();
    expect(sessionToolCallOriginOf('s', { _meta: { 'claudecode/toolUseId': 7 } })).toBeUndefined();
    expect(sessionToolCallOriginOf('s', { _meta: { toolUseId: 'toolu_1' } })).toBeUndefined();
    expect(sessionToolCallOriginOf('s', null)).toBeUndefined();
  });
});
