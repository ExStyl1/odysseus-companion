/**
 * F1.493 (2) (origin WJ-yy P-WJ-yy-3) — a bridged codex session tool reaches the host AS the codex tool call that
 * made it: codex's `tools/call` `_meta.callId` and `_meta.threadId` cross the loopback bridge, and the host runs
 * the port inside the same async-local scope the claude path uses (`currentSessionToolCall`), so a host card the
 * call raises can be bound to the thread that raised it — a spawned subagent's thread included.
 *
 * ## Measured first, on the shipped binary
 *
 * `codex-app-server` 0.156.1 (sha-verified against `packages/codex-protocol/manifest.json`), the real config
 * writer and Responses adapter, a scripted upstream, and a stdio MCP server recording `_meta`: the parent called
 * the tool, spawned a child with `spawn_agent` and ENDED ITS TURN; the child then called the same tool. The two
 * `_meta`s read `callId: "call_parent_1"` / `"call_child_4"`, `threadId:` the main thread / the child thread (the
 * collab item's `receiverThreadIds[0]`), and `sessionId:` the ROOT thread for both. So `threadId` is the raising
 * identity and `sessionId` is not. (Probe and logs: the lane's untracked `work/wjbp/`.)
 *
 * ## The rig — every hop real but the port
 *
 * The REAL `session-mcp-server` (`src/index.ts`, spawned by the shared child pool) talks MCP over stdio as codex
 * spawns it, and the REAL host bridge serves it; the only fake is the roster port behind the bridge, which records
 * what `currentSessionToolCall` answers while the host code runs.
 *
 * THE DEFECT — a `tools/call` whose `_meta` names a call and a subagent thread reached the host with no scope.
 * CONTROL — a call with no `_meta` still reaches it with none. BOUNDARY — a `threadId` with no `callId` is not
 * half-attributed.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChildPool, type PooledRpcResponse } from './child-pool.ts';
import {
  startCodexSessionCallbackBridge,
  type CodexSessionCallbackBridgeHandle,
} from '@nessy-agent/shared/agent/backend/codex/session-callback-bridge';
import { currentSessionToolCall } from '@nessy-agent/shared/agent/backend/claude/session-tool-call-origin';

// The child's boot is a cold, I/O-bound module graph (28–70 s measured, P6.893); one argv, so one boot.
setDefaultTimeout(240_000);

const SESSION_ID = 'f1493-bridge-session';
type Result = { content?: Array<{ type: string; text: string }>; isError?: boolean };
const pool = createChildPool<Result>();
let bridge: CodexSessionCallbackBridgeHandle;
let workspace: string;
/** What `currentSessionToolCall` answered, per host call, while the port ran. */
const seen: unknown[] = [];

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'smcp-f1493-'));
  bridge = await startCodexSessionCallbackBridge({
    sessionKey: { workspaceId: 'ws-f1493', sessionId: SESSION_ID },
    resolvePorts: () => ({
      listSessionsFn: () => ({ sessions: [] }) as never,
      getSessionInfoFn: (sessionId?: string) => {
        seen.push(currentSessionToolCall(SESSION_ID) ?? 'no-scope');
        return { id: sessionId ?? SESSION_ID, name: 'this codex session', labels: [], status: 'todo', permissionMode: 'default', createdAt: 1, isActive: true } as never;
      },
    }),
  });
});

afterAll(async () => {
  await pool.killAll();
  await bridge?.close();
  rmSync(workspace, { recursive: true, force: true });
});

const args = () => [
  '--session-id', SESSION_ID,
  '--workspace-root', workspace,
  '--plans-folder', join(workspace, 'plans'),
  '--config-root', workspace,
  '--external-standalone-only',
  '--host-callback-port', String(bridge.port),
];

/** One `get_session_info` call with the given `_meta` (or none), answered by caller id 2. */
async function callWith(meta?: Record<string, unknown>): Promise<PooledRpcResponse<Result> | undefined> {
  const responses = await pool.runMcpSession(args(), [
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_session_info', arguments: {}, ...(meta ? { _meta: meta } : {}) } },
  ]);
  return responses.get(2);
}

describe('F1.493 (2) — codex\'s tools/call _meta origin reaches the host code the bridged tool runs', () => {
  test('THE DEFECT — a subagent\'s call (callId + its own threadId) runs host-side as that call and that thread', async () => {
    seen.length = 0;
    const reply = await callWith({
      // The measured shape of a spawned child's `_meta`, trimmed to the keys this row reads plus the one it must NOT.
      callId: 'call_child_4',
      threadId: '01a0d437-8ba3-76b3-a621-403e22a71ffa',
      sessionId: '01a0d437-6061-7311-bcb2-e6d5d734223a',
    });
    expect(reply?.result?.isError).not.toBe(true);
    expect(seen).toEqual([{ sessionId: SESSION_ID, toolUseId: 'call_child_4', threadId: '01a0d437-8ba3-76b3-a621-403e22a71ffa' }]);
  });

  test('CONTROL — a call with no _meta reaches the host with no scope, exactly as before', async () => {
    seen.length = 0;
    const reply = await callWith();
    expect(reply?.result?.isError).not.toBe(true);
    expect(seen).toEqual(['no-scope']);
  });

  test('BOUNDARY — a threadId with no callId is not half-attributed; a callId alone carries no thread', async () => {
    seen.length = 0;
    await callWith({ threadId: 'thread-without-a-call' });
    await callWith({ callId: 'call_main_1' });
    expect(seen).toEqual(['no-scope', { sessionId: SESSION_ID, toolUseId: 'call_main_1' }]);
  });

  test('F1.631 — the measured x-codex-turn-metadata turn_id rides to the host scope; an oversized one is dropped', async () => {
    seen.length = 0;
    // The measured shape of a main-thread call's `_meta` (probe work/bk-17/, binary 0.159.3): the turn id nests
    // under `x-codex-turn-metadata` and EQUALS the `turn/started` `turn.id` the agent keeps as `activeTurnId`.
    await callWith({
      callId: 'call_main_1',
      threadId: '01a0d437-6061-7311-bcb2-e6d5d734223a',
      'x-codex-turn-metadata': {
        session_id: '01a0d437-6061-7311-bcb2-e6d5d734223a',
        thread_id: '01a0d437-6061-7311-bcb2-e6d5d734223a',
        turn_id: '01a12158-b5f4-7bb1-bcf7-674b44676e25',
        turn_started_at_unix_ms: 1791560824311,
      },
    });
    expect(seen[0]).toEqual({
      sessionId: SESSION_ID,
      toolUseId: 'call_main_1',
      threadId: '01a0d437-6061-7311-bcb2-e6d5d734223a',
      turnId: '01a12158-b5f4-7bb1-bcf7-674b44676e25',
    });
    // The same cap every origin id has: anything longer is not codex's and is dropped rather than carried.
    await callWith({ callId: 'call_main_2', 'x-codex-turn-metadata': { turn_id: 'x'.repeat(257) } });
    expect(seen[1]).toEqual({ sessionId: SESSION_ID, toolUseId: 'call_main_2' });
  });
});
