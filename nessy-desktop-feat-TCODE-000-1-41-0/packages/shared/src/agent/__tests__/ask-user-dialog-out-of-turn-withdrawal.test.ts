/**
 * F1.369 (b) (origin WJ-hh P-WJ-hh-3; closes F1.275, WJ-z P-WJ-z-4) — a question
 * dialog the shared ask-user bridge withdraws with NO turn in flight still reaches
 * the host, on claude and codex.
 *
 * ## What was wrong
 *
 * F1.220 (`ask-user-dialog-withdrawal.test.ts`) made a withdrawn dialog emit
 * `permission_request_cancelled` on the TURN it was raised in — codex's
 * `turnSink`, claude's `openSlot`. With no turn in flight there is no sink, and
 * `BaseAgent.withdrawElicitationDialog` only wrote a debug line: an MCP server
 * that withdraws its elicitation BETWEEN turns (the session alive), or a teardown
 * that settles the bridges after the turn has ended, left the card on the host's
 * screen and in its `pendingPermissionRequests`, answering nothing.
 *
 * ## The channel
 *
 * `onPermissionRequestWithdrawn` sits beside `onPermissionRequest` on the backend
 * contract (`backend/types.ts`), and the base calls it when no turn sink carried
 * the withdrawal. The host wires it to `processEvent`'s
 * `permission_request_cancelled` arm, the removal the in-turn event already takes
 * (`SessionManager.wireOutOfTurnCardWithdrawal`).
 *
 * ## The rig
 *
 * `ask-user-dialog-withdrawal.test.ts`'s, with the turn sink CLEARED rather than
 * planted — the very state F1.275 names — plus one arm with it planted, which is
 * the control that the out-of-turn channel does not double the in-turn event.
 */
import { describe, expect, it } from 'bun:test';
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpElicitationHandler } from '../../mcp/client.ts';
import type { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { CodexAgent } from '../codex-agent.ts';

type SinkEvent = { type: string; requestId?: string };

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function config(kind: 'codex' | 'claude', pool: McpClientPool): BackendConfig {
  return {
    provider: kind === 'codex' ? 'codex-runtime' : 'anthropic',
    model: kind === 'codex' ? 'codex/test-model' : 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    mcpPool: pool,
    mcpLeaserId: `session:f1369:${kind}`,
    workspace: {
      id: 'ws-f1369',
      name: 'F1.369 Workspace',
      rootPath: '/tmp/ws-f1369',
      workspaceRootPath: '/tmp/ws-f1369',
      sessionRootPath: '/tmp/ws-f1369/sessions',
    } as never,
    session: {
      id: `session-f1369-${kind}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-f1369',
    } as never,
  } as BackendConfig;
}

function formRequest(): ElicitRequest {
  return {
    method: 'elicitation/create',
    params: {
      message: 'Which workspace should I connect?',
      requestedSchema: {
        type: 'object',
        properties: { workspace: { type: 'string', enum: ['personal', 'team'] } },
        required: ['workspace'],
      },
    },
  } as ElicitRequest;
}

/** One agent BETWEEN turns (no sink), its pool handler, the cards it surfaced and what reached the host out of turn. */
function session(kind: 'codex' | 'claude', options: { turnInFlight?: boolean } = {}) {
  let handler: McpElicitationHandler | undefined;
  const pool = {
    registerElicitationHandler(_leaserId: string, fn: McpElicitationHandler) { handler = fn; return () => {}; },
    setElicitationHandler(fn: McpElicitationHandler) { handler = fn; },
  } as unknown as McpClientPool;
  const agent = kind === 'codex' ? new CodexAgent(config(kind, pool)) : new ClaudeAgent(config(kind, pool) as never);
  const debug: string[] = [];
  agent.onDebug = line => { debug.push(line); };
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onPermissionRequest = request => { surfaced.push(request); };
  const outOfTurn: string[] = [];
  agent.onPermissionRequestWithdrawn = requestId => { outOfTurn.push(requestId); };
  const turnEvents: SinkEvent[] = [];
  if (options.turnInFlight) {
    const sink = { push: (event: SinkEvent) => { turnEvents.push(event); } };
    if (kind === 'codex') {
      (agent as unknown as { turnSink: unknown }).turnSink = { ...sink, finish: () => {} };
    } else {
      (agent as unknown as { openSlot: unknown }).openSlot = { ...sink, settled: false, close: () => {}, fail: () => {} };
    }
  }
  expect(handler).toBeDefined();
  return { agent, handler: handler!, surfaced, outOfTurn, turnEvents, debug };
}

describe.each(['codex', 'claude'] as const)('F1.369 (b) — %s tells the host about a dialog withdrawn between turns', kind => {
  it('the MCP server withdrawing its elicitation with no turn in flight reaches onPermissionRequestWithdrawn, by id', async () => {
    const { handler, surfaced, outOfTurn } = session(kind);
    const controller = new AbortController();
    const result = handler(formRequest(), controller.signal, { server: 'acme' });
    await settle();
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.type).toBe('ask_user');

    controller.abort();

    expect((await result).action).toBe('cancel');
    expect(outOfTurn).toEqual([surfaced[0]!.requestId]);
  });

  it('a teardown that settles the bridges after the turn ended reaches it too', async () => {
    const { agent, handler, surfaced, outOfTurn } = session(kind);
    const result = handler(formRequest(), new AbortController().signal, { server: 'acme' });
    await settle();
    expect(surfaced).toHaveLength(1);

    (agent as unknown as { releaseElicitationSurface(reason: string): void })
      .releaseElicitationSurface('The session runtime restarted before the question was answered.');

    expect((await result).action).toBe('cancel');
    expect(outOfTurn).toEqual([surfaced[0]!.requestId]);
  });

  /**
   * CONTROL. With a turn in flight the TURN carries the withdrawal, as F1.220
   * built it, and the out-of-turn channel stays silent — without this arm "the
   * callback fires" is equally satisfied by a base that calls it every time and
   * so sends the host two cancellations for one card.
   */
  it('CONTROL: with a turn in flight the turn carries it and the out-of-turn channel is not called', async () => {
    const { handler, surfaced, outOfTurn, turnEvents } = session(kind, { turnInFlight: true });
    const controller = new AbortController();
    const result = handler(formRequest(), controller.signal, { server: 'acme' });
    await settle();
    controller.abort();
    expect((await result).action).toBe('cancel');
    expect(turnEvents).toEqual([{ type: 'permission_request_cancelled', requestId: surfaced[0]!.requestId }]);
    expect(outOfTurn).toEqual([]);
  });

  /** NEGATIVE. An ANSWERED dialog is not withdrawn by the abort that follows it. */
  it('an answered elicitation is NOT withdrawn out of turn either', async () => {
    const { agent, handler, surfaced, outOfTurn } = session(kind);
    const controller = new AbortController();
    const result = handler(formRequest(), controller.signal, { server: 'acme' });
    await settle();
    agent.respondToPermission(surfaced[0]!.requestId, true, false, {
      askUserAnswer: { type: 'option', optionIndex: 1, value: 'team' } as never,
    });
    expect(await result).toEqual({ action: 'accept', content: { workspace: 'team' } });

    controller.abort();
    (agent as unknown as { releaseElicitationSurface(reason: string): void }).releaseElicitationSurface('teardown');

    expect(outOfTurn).toEqual([]);
  });
});

describe('F1.369 (b) — with no host wired, the base still only says so', () => {
  it('no callback set: the withdrawal settles the dialog, throws nothing, and leaves the debug line', async () => {
    const { agent, handler, surfaced, debug } = session('codex');
    agent.onPermissionRequestWithdrawn = null;
    const controller = new AbortController();
    const result = handler(formRequest(), controller.signal, { server: 'acme' });
    await settle();
    controller.abort();
    expect((await result).action).toBe('cancel');
    expect(debug.some(line => line.includes(`question dialog ${surfaced[0]!.requestId} withdrawn with no host event`))).toBe(true);
  });
});
