/**
 * P2.508 — an MCP server that failed to start must reach the operator.
 *
 * ## What the row asked, and the premise that turned out wrong
 *
 * The row frames this as a posture: codex has a `required` key, the key works,
 * so decide whether to write it and accept that a degraded session becomes a
 * hard start failure. Measured, the decision is smaller than that and for a
 * different reason.
 *
 * `required` is a per-`[mcp_servers.<name>]` key, and `writeCodexConfig` emits
 * exactly TWO entries — `session` and `sources`. Every MCP server an operator
 * configured reaches codex aggregated behind `sources`, one loopback HTTP
 * endpoint. So the key could only ever mark OUR two infrastructure servers; an
 * operator's own server, declared essential, failing inside the pool leaves
 * `sources` healthy and codex's mechanism never fires for it. Writing the key
 * would not honour the operator's mark, it would mark something else. The
 * granularity, not the cost, is what settles it — and it is pinned by
 * `config-writer-required-mcp.test.ts` beside the comment that says so.
 *
 * ## The rig
 *
 * Every payload below is verbatim from the shipped `darwin-arm64`
 * `codex-app-server` (SHA-256 byte-identical to `codex-protocol/manifest.json`'s
 * pinned `binarySha256`), driven with one MCP entry that cannot start, on both
 * transports this product emits:
 *
 * | config | `thread/start` | `mcpServer/startupStatus/updated` |
 * | --- | --- | --- |
 * | broken server, no `required` | succeeds | `starting`, then `failed` with `error` |
 * | broken server, `required = true` | fails, naming the server | **never arrives** |
 *
 * The second row is the control for the first, and it is also the finding: the
 * two mechanisms are MUTUALLY EXCLUSIVE. With `required` the thread never
 * starts, so nothing is left to report. There is no codex setting that both
 * refuses to run degraded and explains itself.
 *
 * ## Why the deferral is load-bearing, same as its two siblings
 *
 * The `failed` frame landed ~1 ms after the `thread/start` RESPONSE — the same
 * flush class as `thread/started`, and long before `chatImpl` sets `turnSink`.
 * A surfacing built on `turnSink?.push(...)` would report nothing at all, which
 * is exactly what P2.408 and P3.120 each measured for their own channel. This
 * rides their queue rather than opening a third.
 *
 * ## Why not `mcpServerStatus/list`
 *
 * It is the method that LOOKS like the observability channel. On the same rig
 * it returns the failed server as `serverInfo: null`, `tools: {}`, with no
 * failure reason — and returns byte-identically in both rows of the table
 * above, so it cannot separate "one server is down" from "the session refused
 * to start". This notification is the only channel carrying the reason.
 *
 * ## Per-runtime
 *
 * codex has the mechanism; claude and Pi have no equivalent — a failed connect
 * stays capability-local by construction. Before this file the residual
 * difference was SILENT on all three. It is now HONEST on codex and still
 * silent on the other two, which is a smaller gap and a named one.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import {
  CodexAgent,
  CODEX_MCP_STARTUP_STATUS_METHOD,
  codexMcpStartupFailureNotice,
} from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-codex-mcp-startup';
const SESSION_ID = 'session-codex-mcp-startup';
/** The thread this session owns. A frame naming any other belongs to a child. */
const OUR_THREAD = '01a05b5d-e4b0-7ed3-a270-58509fd66952';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Codex MCP Startup Workspace',
      rootPath: '/tmp/ws-codex-mcp-startup-root',
      workspaceRootPath: '/tmp/ws-codex-mcp-startup-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-mcp-startup',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-codex-mcp-startup-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

interface Event { type: string; message?: string; level?: string }

interface Harness {
  /** Drive the REAL notification dispatch, guard and all. */
  notify: (params: unknown, method?: string) => void;
  openTurn: () => Event[];
  events: Event[];
  pending: string[];
}

function harness(options: { withTurn?: boolean } = {}): Harness {
  const agent = new CodexAgent(createConfig());
  const internals = agent as unknown as {
    threadId: string | null;
    turnSink: { push: (e: Event) => void } | null;
    pendingServerWarningNotices: string[];
    handleNotification: (method: string, params: unknown) => void;
    flushPendingServerWarnings: (queue: { push: (e: Event) => void }) => void;
  };
  const events: Event[] = [];
  const sink = { push: (e: Event) => events.push(e) };
  internals.threadId = OUR_THREAD;
  internals.turnSink = options.withTurn ? sink : null;
  return {
    notify: (params, method = CODEX_MCP_STARTUP_STATUS_METHOD) =>
      internals.handleNotification(method, params),
    openTurn: () => {
      internals.turnSink = sink;
      internals.flushPendingServerWarnings(sink);
      return events;
    },
    events,
    pending: internals.pendingServerWarningNotices,
  };
}

/** Verbatim from the rig: the stdio transport, a command that does not exist. */
const FAILED_STDIO = {
  threadId: OUR_THREAD,
  name: 'p2508broken',
  status: 'failed',
  error: 'MCP client for `p2508broken` failed to start: MCP startup failed: '
    + 'No such file or directory (os error 2)',
  failureReason: null,
};

/** Verbatim from the rig: the `url` transport, i.e. the shape `sources` has. */
const FAILED_URL = {
  threadId: OUR_THREAD,
  name: 'sources',
  status: 'failed',
  error: 'MCP client for `sources` failed to start: MCP startup failed: '
    + 'handshaking with MCP server failed: Send message error',
  failureReason: null,
};

/** Verbatim from the rig: the frame that precedes every failure. */
const STARTING = { ...FAILED_STDIO, status: 'starting', error: null };

describe('a codex MCP server that failed to start reaches the operator', () => {
  /**
   * THE ROW'S CENTRAL CASE.
   *
   * KILLS: not subscribing at all (today's state — the notification reaches
   * nothing on any product path), and any surfacing built on a straight
   * `turnSink?.push(...)`, which for a frame measured 1 ms after the
   * `thread/start` response fires exactly never.
   */
  it('holds a failure that arrives before any turn, and delivers it when one opens', () => {
    const h = harness();
    h.notify(FAILED_STDIO);

    expect(h.events).toEqual([]);
    expect(h.pending).toHaveLength(1);

    const delivered = h.openTurn();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.type).toBe('info');
    // Durable + warning is the one family the session layer persists, so a
    // session that lost its tools says so after a reload too.
    expect(delivered[0]!.level).toBe('warning');
    expect(delivered[0]!.message).toContain('p2508broken');
    // The fail-soft posture, said to the person affected rather than to a
    // developer reading a type — the half the row exists to close.
    expect(delivered[0]!.message).toContain('running without its tools');
    // The reason, which is the thing `mcpServerStatus/list` does not carry.
    expect(delivered[0]!.message).toContain('No such file or directory (os error 2)');
    expect(h.pending).toHaveLength(0);
  });

  /** KILLS: a deferral so unconditional a mid-session failure waits for the next turn. */
  it('pushes straight onto a turn that is already open', () => {
    const h = harness({ withTurn: true });
    h.notify(FAILED_URL);
    expect(h.pending).toHaveLength(0);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.level).toBe('warning');
    expect(h.events[0]!.message).toContain('sources');
    expect(h.events[0]!.message).toContain('handshaking with MCP server failed');
  });

  /**
   * KILLS: surfacing on `status` alone. The binary sends `starting` for EVERY
   * server on every thread start — measured, one per server — so a branch that
   * reacted to the method rather than to `failed` would warn a user about
   * healthy servers, every single session.
   */
  it('says nothing for the lifecycle states that are not failures', () => {
    const h = harness({ withTurn: true });
    for (const status of ['starting', 'ready', 'cancelled']) {
      h.notify({ ...STARTING, status });
    }
    expect(h.events).toEqual([]);
    expect(h.pending).toEqual([]);
    // Positive control on the same harness: the instrument does fire.
    h.notify(FAILED_STDIO);
    expect(h.events).toHaveLength(1);
  });

  /**
   * KILLS: reading this notification ahead of the foreign-thread guard. A codex
   * agent role spawns real subagent threads over the SAME connection, so a
   * child's broken MCP server would otherwise post a durable warning into the
   * parent's transcript.
   */
  it('ignores a failure belonging to another thread on the same connection', () => {
    const h = harness({ withTurn: true });
    h.notify({ ...FAILED_STDIO, threadId: '01a05b60-a635-7f00-9244-9be7efcee9f5' });
    expect(h.events).toEqual([]);
    expect(h.pending).toEqual([]);
    // Positive control: the identical frame on OUR thread is surfaced, so the
    // absence above is about attribution and not about the payload.
    h.notify(FAILED_STDIO);
    expect(h.events).toHaveLength(1);
  });
});

describe('codexMcpStartupFailureNotice', () => {
  /**
   * `McpServerStartupFailureReason` has exactly one variant today
   * (`generated/v2/McpServerStartupFailureReason.ts`), and it is the one an
   * operator can act on, so it gets its own sentence.
   *
   * KILLS: dropping `failureReason`, which would tell a user with an expired
   * OAuth token only that the server "failed to start".
   */
  it('names re-authentication when that is why the server did not come up', () => {
    const notice = codexMcpStartupFailureNotice({
      ...FAILED_URL,
      failureReason: 'reauthenticationRequired',
    });
    expect(notice).toContain('signed in again');
    // Control: the same frame without the reason does not claim it.
    expect(codexMcpStartupFailureNotice(FAILED_URL)).not.toContain('signed in again');
  });

  /**
   * The caller runs inside the transport's synchronous notification dispatch,
   * where a throw takes the rest of the dispatch — including every other
   * notification in the flush — with it.
   *
   * KILLS: any classifier that indexes into the payload without checking it.
   */
  it('is total on payloads the wire should never produce', () => {
    for (const bad of [null, undefined, 'failed', 42, [], {}, { status: 'failed' }]) {
      expect(() => codexMcpStartupFailureNotice(bad)).not.toThrow();
    }
    // A `failed` frame with no readable name still reports, because the failure
    // is the news and the name is the detail.
    expect(codexMcpStartupFailureNotice({ status: 'failed' })).toContain('An MCP server');
    // Everything that is not a failure stays null rather than becoming a notice
    // with an empty subject.
    expect(codexMcpStartupFailureNotice({ status: 'ready', name: 'sources' })).toBeNull();
  });
});
