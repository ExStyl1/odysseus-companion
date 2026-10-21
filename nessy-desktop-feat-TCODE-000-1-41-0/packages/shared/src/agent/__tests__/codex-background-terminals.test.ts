/**
 * P3.3 — codex background terminals appear as background tasks.
 *
 * The feature has two halves and this file pins both:
 *
 * 1. SYNTHESIS (pure, in `CodexEventAdapter.syncBackgroundTerminals`): the
 *    app-server's `thread/backgroundTerminals/list` result is reconciled against
 *    what we have already announced into the EXISTING chip events — the same
 *    `shell_backgrounded` / `task_completed` shapes Pi and Claude produce from a
 *    backgrounded Bash tool (`tool-matching.ts`), never a codex-specific event.
 *    `task_completed.taskId === shell_backgrounded.shellId`, which is the id the
 *    renderer's chip row filters on to drop the row (`App.tsx`).
 *
 * 2. WIRING + STOP (agent): `CodexAgent` polls that method at the turn boundary
 *    and pushes the chip events onto the turn sink BEFORE `turn/start`, and
 *    `stopBackgroundTask` terminates a terminal via
 *    `thread/backgroundTerminals/terminate`.
 *
 * PROTOCOL-DRIFT is central and MEASURED — and the first version of this file
 * measured it WRONG. The methods DO ship: the binary's own method table reads
 * `thread/backgroundTerminals/clean|list|terminate`, and only the pinned TS
 * bindings lag it. (The earlier "absent from the binary too" claim came from a
 * rig with no positive control — `grep`ping repo source, never the binary.)
 *
 * That correction changes what these tests must pin. Because the methods are
 * really there, a blanket "latch unsupported on any error" is a bug: one poll
 * during startup would disable chips for the whole session. So the `(d)` pair
 * below pins the TAXONOMY, measured off the shipped binary — this app-server has
 * no "Method not found" string at all, an unknown method fails as a serde
 * `unknown variant`, and a wrong shape as `missing field` — while a transient
 * failure (`thread not found`, a pending turn) must RETRY at the next boundary.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { CodexEventAdapter, CODEX_BACKGROUND_TERMINAL_ID_KEYS } from '../backend/codex/event-adapter.ts';
import { CodexAgent, CODEX_BACKGROUND_TERMINALS_TIMEOUT_MS } from '../codex-agent.ts';
import { cleanupModeState } from '../mode-manager.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';

// ============================================================
// 1. Synthesis — CodexEventAdapter.syncBackgroundTerminals (a, b)
// ============================================================

describe('CodexEventAdapter.syncBackgroundTerminals', () => {
  it('(a) synthesizes shell_backgrounded on first sight of a terminal', () => {
    const adapter = new CodexEventAdapter();
    const events = adapter.syncBackgroundTerminals({
      terminals: [{ id: 'term-1', command: 'python3 -m http.server' }],
    });
    expect(events).toEqual([
      {
        type: 'shell_backgrounded',
        toolUseId: 'codex-bgterm:term-1',
        shellId: 'term-1',
        command: 'python3 -m http.server',
        intent: 'python3 -m http.server',
      },
    ]);
  });

  it('does not re-announce a terminal seen on a prior poll', () => {
    const adapter = new CodexEventAdapter();
    adapter.syncBackgroundTerminals({ terminals: [{ id: 'term-1', command: 'srv' }] });
    const again = adapter.syncBackgroundTerminals({ terminals: [{ id: 'term-1', command: 'srv' }] });
    expect(again).toEqual([]);
  });

  it('(b) synthesizes task_completed keyed by shellId when a terminal disappears', () => {
    const adapter = new CodexEventAdapter();
    adapter.syncBackgroundTerminals({ terminals: [{ id: 'term-1', command: 'srv' }] });
    const exit = adapter.syncBackgroundTerminals({ terminals: [] });
    // taskId === the shellId announced, so the chip row's `t.id !== taskId`
    // removal filter (App.tsx) matches and the row disappears.
    expect(exit).toEqual([{ type: 'task_completed', taskId: 'term-1', status: 'completed' }]);
  });

  it('(b) maps a present-but-exited terminal to task_completed with the exit status', () => {
    const adapter = new CodexEventAdapter();
    adapter.syncBackgroundTerminals({ terminals: [{ id: 'term-9' }] });
    const exit = adapter.syncBackgroundTerminals({ terminals: [{ id: 'term-9', exitCode: 1 }] });
    expect(exit).toEqual([{ type: 'task_completed', taskId: 'term-9', status: 'failed' }]);
  });

  it('forgets a completed terminal so it is never re-announced', () => {
    const adapter = new CodexEventAdapter();
    adapter.syncBackgroundTerminals({ terminals: [{ id: 'term-1' }] });
    adapter.syncBackgroundTerminals({ terminals: [] });
    expect(adapter.isKnownBackgroundTerminal('term-1')).toBe(false);
    // A terminal reusing the id later is a fresh announcement, not a duplicate.
    const reborn = adapter.syncBackgroundTerminals({ terminals: [{ id: 'term-1' }] });
    expect(reborn).toEqual([{ type: 'shell_backgrounded', toolUseId: 'codex-bgterm:term-1', shellId: 'term-1' }]);
  });

  it('tolerates a bare-array result and an entry that carries no command', () => {
    const adapter = new CodexEventAdapter();
    // `processId` — a spelling that actually occurs in the shipped binary (14x).
    const events = adapter.syncBackgroundTerminals([{ processId: 'p2' }]);
    expect(events).toEqual([{ type: 'shell_backgrounded', toolUseId: 'codex-bgterm:p2', shellId: 'p2' }]);
  });

  it('rejects `terminalId` — a name that occurs ZERO times in the shipped binary', () => {
    // Pins the corrected measurement: the original guess `terminalId` is not a
    // field this app-server uses, so an entry carrying only that is not a
    // terminal we can address, and inventing an id from it would produce a chip
    // whose Stop could never work.
    const adapter = new CodexEventAdapter();
    expect(adapter.syncBackgroundTerminals([{ terminalId: 'nope' }])).toEqual([]);
  });

  it('remembers WHICH key the id arrived under, so terminate can echo it back', () => {
    const adapter = new CodexEventAdapter();
    adapter.syncBackgroundTerminals({ terminals: [{ processHandle: 'h7' }] });
    expect(adapter.backgroundTerminalIdKey('h7')).toBe('processHandle');
    adapter.syncBackgroundTerminals({ terminals: [{ processHandle: 'h7' }, { id: 'i8' }] });
    expect(adapter.backgroundTerminalIdKey('i8')).toBe('id');
    expect(adapter.backgroundTerminalIdKey('absent')).toBeUndefined();
  });

  it('parses an unexpected shape as no terminals (degrade, never throws)', () => {
    const adapter = new CodexEventAdapter();
    expect(adapter.syncBackgroundTerminals(null)).toEqual([]);
    expect(adapter.syncBackgroundTerminals({ nope: true })).toEqual([]);
    expect(adapter.syncBackgroundTerminals({ terminals: [{ noId: true }] })).toEqual([]);
  });

  it('resetBackgroundTerminals forgets everything (runtime teardown)', () => {
    const adapter = new CodexEventAdapter();
    adapter.syncBackgroundTerminals({ terminals: [{ id: 'term-1' }] });
    expect(adapter.isKnownBackgroundTerminal('term-1')).toBe(true);
    adapter.resetBackgroundTerminals();
    expect(adapter.isKnownBackgroundTerminal('term-1')).toBe(false);
  });
});

// ============================================================
// 2. Wiring + stop — CodexAgent (c, d) with a fake app-server
// ============================================================

const WS = 'ws-bgterm';
const SESS = 'session-bgterm';
const KEY: SessionKey = { workspaceId: WS, sessionId: SESS };

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WS,
      name: 'BG Terminals',
      rootPath: '/tmp/ws-bgterm',
      workspaceRootPath: '/tmp/ws-bgterm',
      sessionRootPath: '/tmp/ws-bgterm/sessions',
    } as never,
    session: {
      id: SESS,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-bgterm',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

interface FakeAgent {
  agent: CodexAgent;
  requests: Array<{ method: string; params: unknown }>;
  debugLines: string[];
}

/** Construct a CodexAgent with an injected fake app-server client. */
function makeAgent(handle: (method: string, params: unknown) => Promise<unknown>): FakeAgent {
  const agent = new CodexAgent(createConfig());
  const requests: Array<{ method: string; params: unknown }> = [];
  const debugLines: string[] = [];
  agent.onDebug = (m) => debugLines.push(m);
  const client = {
    request(method: string, params: unknown) {
      requests.push({ method, params });
      return handle(method, params);
    },
    notify() {},
    close() {},
  };
  (agent as unknown as { client: unknown; threadId: string | null }).client = client;
  (agent as unknown as { client: unknown; threadId: string | null }).threadId = 'thread-bg';
  return { agent, requests, debugLines };
}

/**
 * THE SECOND DOUBLE, AND THE WHOLE REASON THERE ARE TWO.
 *
 * {@link makeAgent}'s `request` takes TWO arguments and drops the options object,
 * which pins one real property — the deadline must belong to this caller, not to
 * whichever channel sits on `this.client`. But it pins ONLY that, and P2.245
 * shipped with nothing else: the tree was green whether or not the production
 * channel honoured `timeoutMs`, so a sentinel that never won on a real
 * `AppServerClient` looked fully covered. A suite that is green with the
 * behaviour and without it is not a suite.
 *
 * This double is FAITHFUL to `AppServerClient.request`
 * (`packages/codex-agent-server/src/app-server-client.ts`): it arms its own timer
 * from `options.timeoutMs`, rejects with that class's exact message, and clears
 * the timer on either settlement. Which of the two timers wins — and therefore
 * which BRANCH the caller takes and which line an operator reads — can only be
 * pinned here.
 */
function makeTimeoutHonouringAgent(
  handle: (method: string, params: unknown) => Promise<unknown>,
): FakeAgent & { channelTimeouts: Array<number | undefined> } {
  const agent = new CodexAgent(createConfig());
  const requests: Array<{ method: string; params: unknown }> = [];
  const debugLines: string[] = [];
  const channelTimeouts: Array<number | undefined> = [];
  agent.onDebug = (m) => debugLines.push(m);
  const client = {
    request(method: string, params: unknown, options?: { timeoutMs?: number }) {
      requests.push({ method, params });
      channelTimeouts.push(options?.timeoutMs);
      const answer = handle(method, params);
      const timeoutMs = options?.timeoutMs;
      if (timeoutMs === undefined || timeoutMs <= 0) return answer;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`app-server request ${method} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        answer.then(
          (value) => { clearTimeout(timer); resolve(value); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
    },
    notify() {},
    close() {},
  };
  (agent as unknown as { client: unknown; threadId: string | null }).client = client;
  (agent as unknown as { client: unknown; threadId: string | null }).threadId = 'thread-bg';
  return { agent, requests, debugLines, channelTimeouts };
}

/** A collector matching the sink shape syncBackgroundTerminalsIntoSink expects. */
function collector(): { events: AgentEvent[]; push: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, push: (e) => events.push(e) };
}

type PrivatePoll = {
  syncBackgroundTerminalsIntoSink: (sink: { push: (e: AgentEvent) => void }, timeoutMs?: number) => Promise<void>;
};

describe('CodexAgent background-terminal poll + terminate', () => {
  afterEach(() => cleanupModeState(KEY));

  it('(c) chip-stop terminates a known terminal via thread/backgroundTerminals/terminate', async () => {
    const { agent, requests } = makeAgent(async (method) =>
      method === 'thread/backgroundTerminals/list'
        ? { terminals: [{ id: 'term-1', command: 'python3 -m http.server' }] }
        : {},
    );
    // Poll first so the adapter knows the terminal (also covers the happy list path).
    const sink = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(sink);
    expect(sink.events.some(
      (e) => e.type === 'shell_backgrounded' && (e as Extract<AgentEvent, { type: 'shell_backgrounded' }>).shellId === 'term-1',
    )).toBe(true);

    const result = await agent.stopBackgroundTask('term-1');
    expect(result).toEqual({ stopped: true });
    const terminate = requests.find((r) => r.method === 'thread/backgroundTerminals/terminate');
    expect(terminate).toBeDefined();
    // The id is named with the app-server's OWN key (`id`, as the list used),
    // not the invented `terminalId` the first version sent — which does not
    // occur in the shipped binary at all.
    expect(terminate!.params).toEqual({ threadId: 'thread-bg', id: 'term-1' });
    expect(JSON.stringify(terminate!.params)).not.toContain('terminalId');
  });

  it('(c) names the id with the key the list response used (processId), not a guess', async () => {
    const { agent, requests } = makeAgent(async (method) =>
      method === 'thread/backgroundTerminals/list' ? { terminals: [{ processId: 'pid-5' }] } : {},
    );
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(await agent.stopBackgroundTask('pid-5')).toEqual({ stopped: true });
    const terminate = requests.find((r) => r.method === 'thread/backgroundTerminals/terminate');
    expect(terminate!.params).toEqual({ threadId: 'thread-bg', processId: 'pid-5' });
  });

  it('(c) retries under the other candidate names when the shape is refused', async () => {
    // A binary whose terminate param is `processId` while its list said `id`:
    // the shape refusal is retried under the remaining candidates rather than
    // leaving the user with a chip that cannot be stopped.
    const attempted: string[] = [];
    const { agent } = makeAgent(async (method, params) => {
      if (method === 'thread/backgroundTerminals/list') return { terminals: [{ id: 'x1' }] };
      if (method === 'thread/backgroundTerminals/terminate') {
        const keys = Object.keys(params as Record<string, unknown>).filter((k) => k !== 'threadId');
        attempted.push(keys[0]!);
        if (keys[0] !== 'processId') throw new Error('unknown field `' + keys[0] + '`, expected `processId`');
        return {};
      }
      return {};
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(await agent.stopBackgroundTask('x1')).toEqual({ stopped: true });
    expect(attempted).toEqual(['id', 'processId']);
  });

  it('stopBackgroundTask falls through (stopped:false, no terminate) for an id it never announced', async () => {
    const { agent, requests } = makeAgent(async () => ({}));
    const result = await agent.stopBackgroundTask('never-seen');
    expect(result).toEqual({ stopped: false });
    expect(requests.some((r) => r.method === 'thread/backgroundTerminals/terminate')).toBe(false);
  });

  it('(d) a DEFINITIVE refusal degrades silently — no throw, a debug line, and no re-probe', async () => {
    let listCalls = 0;
    const { agent, debugLines } = makeAgent(async (method) => {
      if (method === 'thread/backgroundTerminals/list') {
        listCalls += 1;
        // The real shape of "no such method" on THIS app-server: it has no
        // "Method not found" string; `ClientRequest` is a serde-tagged enum, so
        // an unrecognised method fails as `unknown variant`.
        throw new Error('unknown variant `thread/backgroundTerminals/list`, expected one of ...');
      }
      return {};
    });
    const sink = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(sink);
    expect(sink.events).toEqual([]);
    expect(listCalls).toBe(1);
    expect(debugLines.some((l) => l.includes('refused definitively'))).toBe(true);

    // Latched: a second boundary does not probe again.
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(sink);
    expect(listCalls).toBe(1);
    expect(sink.events).toEqual([]);
  });

  it('(d) a JSON-RPC -32601 code latches even when the message says nothing', async () => {
    let listCalls = 0;
    const { agent } = makeAgent(async () => {
      listCalls += 1;
      throw Object.assign(new Error('rejected'), { code: -32601 });
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(listCalls).toBe(1);
  });

  it('(d) a TRANSIENT failure does NOT latch — it retries at the next turn boundary', async () => {
    // The bug this pins: the methods really do ship, so latching on any error
    // meant one unlucky poll (a thread not ready yet, a turn still pending)
    // disabled background-terminal chips for the entire session.
    let listCalls = 0;
    const { agent, debugLines } = makeAgent(async (method) => {
      if (method === 'thread/backgroundTerminals/list') {
        listCalls += 1;
        if (listCalls === 1) throw new Error('thread not found');
        if (listCalls === 2) throw new Error('thread already has an active or pending turn');
        return { terminals: [{ id: 'late-1', command: 'python3 -m http.server' }] };
      }
      return {};
    });
    const first = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(first);
    expect(first.events).toEqual([]);
    expect(debugLines.some((l) => l.includes('transiently'))).toBe(true);

    const second = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(second);
    expect(second.events).toEqual([]);

    // Third boundary: the app-server is ready and the chip finally appears.
    const third = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(third);
    expect(listCalls).toBe(3);
    expect(third.events).toEqual([{
      type: 'shell_backgrounded',
      toolUseId: 'codex-bgterm:late-1',
      shellId: 'late-1',
      command: 'python3 -m http.server',
      intent: 'python3 -m http.server',
    }]);
  });

  it('(d) a terminate that the binary rejects degrades silently to stopped:false', async () => {
    const { agent } = makeAgent(async (method) => {
      if (method === 'thread/backgroundTerminals/list') return { terminals: [{ id: 'term-1' }] };
      if (method === 'thread/backgroundTerminals/terminate') throw new Error('no handler for thread/backgroundTerminals/terminate');
      return {};
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    const result = await agent.stopBackgroundTask('term-1');
    expect(result).toEqual({ stopped: false });
  });
});

// ============================================================
// 2b. Live-wire shapes — facts read off the running binary over stdio
// ============================================================

/**
 * These pin what a real stdio session against the shipped binary answered, so
 * the inference this feature was originally built on can never creep back:
 *   - the terminate parameter is `processId`, and it must be digit-parseable
 *     (`{id:…}` → ``missing field `processId` ``; `{processId:1}` → `invalid
 *     type: integer 1, expected a string`; `{processId:"ab"}` → `invalid
 *     background terminal process id: invalid digit found in string`);
 *   - `list {threadId}` → `{"data":[],"nextCursor":null}`;
 *   - `terminate` answers `{"terminated": false}` for a pid it did not kill;
 *   - this binary returns **-32600 for everything**, so no code-based arm fires.
 */
describe('codex background terminals — live-wire shapes', () => {
  afterEach(() => cleanupModeState(KEY));

  it('reads the measured envelope: {"data":[…],"nextCursor":null}', () => {
    const adapter = new CodexEventAdapter();
    const events = adapter.syncBackgroundTerminals({
      data: [{ processId: '4242', command: 'python3 -m http.server' }],
      nextCursor: null,
    });
    expect(events).toEqual([{
      type: 'shell_backgrounded',
      toolUseId: 'codex-bgterm:4242',
      shellId: '4242',
      command: 'python3 -m http.server',
      intent: 'python3 -m http.server',
    }]);
  });

  it('coerces a NUMERIC processId instead of dropping the terminal silently', () => {
    // The measured failure this fixes: `{data:[{processId:4242}]}` produced no
    // chip AND no debug line — inert and undiagnosable. A PID-shaped field
    // arriving as a JSON number is entirely plausible.
    const adapter = new CodexEventAdapter();
    const events = adapter.syncBackgroundTerminals({ data: [{ processId: 4242 }], nextCursor: null });
    expect(events).toEqual([{ type: 'shell_backgrounded', toolUseId: 'codex-bgterm:4242', shellId: '4242' }]);
    expect(adapter.isKnownBackgroundTerminal('4242')).toBe(true);
    expect(adapter.backgroundTerminalIdKey('4242')).toBe('processId');
  });

  it('refuses a non-finite numeric id (NaN/Infinity stringify into nothing usable)', () => {
    const adapter = new CodexEventAdapter();
    expect(adapter.syncBackgroundTerminals({ data: [{ processId: Number.NaN }] })).toEqual([]);
    expect(adapter.syncBackgroundTerminals({ data: [{ processId: Number.POSITIVE_INFINITY }] })).toEqual([]);
  });

  it('prefers the DIGIT-PARSEABLE key when an entry carries both', () => {
    // `terminate` rejects a non-numeric process id (`invalid digit`), and that
    // refusal is not a shape error — so addressing this terminal as "sh-a" would
    // yield a chip whose Stop can never succeed.
    const adapter = new CodexEventAdapter();
    adapter.syncBackgroundTerminals({ data: [{ id: 'sh-a', processId: 4242 }], nextCursor: null });
    expect(adapter.isKnownBackgroundTerminal('4242')).toBe(true);
    expect(adapter.isKnownBackgroundTerminal('sh-a')).toBe(false);
    expect(adapter.backgroundTerminalIdKey('4242')).toBe('processId');
  });

  it('puts the MEASURED key first, so the true wire costs no wasted round-trip', () => {
    // `processId` is the field the live binary actually wants; every other
    // spelling is a fallback for a future one. Order is load-bearing twice: it
    // decides which key an entry is addressed by when several are present and
    // none is numeric, and it is the order `stopBackgroundTask` walks its
    // candidates in — so `id` first meant one guaranteed refused request on the
    // real wire before the right name was tried.
    expect(CODEX_BACKGROUND_TERMINAL_ID_KEYS[0]).toBe('processId');
    expect([...CODEX_BACKGROUND_TERMINAL_ID_KEYS]).not.toContain('terminalId');

    // Behavioural half: two non-numeric candidates, so the digit-preference
    // cannot decide it and only the ORDER can.
    const adapter = new CodexEventAdapter();
    adapter.syncBackgroundTerminals({ data: [{ id: 'aa', processId: 'bb' }], nextCursor: null });
    expect(adapter.isKnownBackgroundTerminal('bb')).toBe(true);
    expect(adapter.isKnownBackgroundTerminal('aa')).toBe(false);
    expect(adapter.backgroundTerminalIdKey('bb')).toBe('processId');
  });

  it('walks terminate candidates in the measured order (processId tried first)', async () => {
    const attempted: string[] = [];
    const { agent } = makeAgent(async (method, params) => {
      // An entry that teaches no key at all (unknown spelling) → pure fallback.
      if (method === 'thread/backgroundTerminals/list') return { data: [{ sessionId: '5' }], nextCursor: null };
      if (method === 'thread/backgroundTerminals/terminate') {
        const key = Object.keys(params as Record<string, unknown>).find((k) => k !== 'threadId')!;
        attempted.push(key);
        if (key !== 'processId') throw new Error('missing field `processId`');
        return { terminated: true };
      }
      return {};
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(await agent.stopBackgroundTask('5')).toEqual({ stopped: true });
    // The learned key is tried first, then the candidates IN ORDER — and
    // `processId` must come before `id`, or the real wire pays a wasted trip.
    expect(attempted).toEqual(['sessionId', 'processId']);
  });

  it('a TRUNCATED page does not report a missing terminal as completed', () => {
    // The measured wrong state: with `a` and `b` known, a page of just `[a]`
    // plus a cursor emitted `task_completed` for `b` — the chip vanished while
    // the process was still running, then re-announced next poll.
    const adapter = new CodexEventAdapter();
    adapter.syncBackgroundTerminals({ data: [{ id: 'a' }, { id: 'b' }], nextCursor: null });
    const truncated = adapter.syncBackgroundTerminals({ data: [{ id: 'a' }], nextCursor: 'PAGE2' });
    expect(truncated).toEqual([]);
    expect(adapter.isKnownBackgroundTerminal('b')).toBe(true);
    // Once the listing is complete, the real absence IS reported.
    const complete = adapter.syncBackgroundTerminals({ data: [{ id: 'a' }], nextCursor: null });
    expect(complete).toEqual([{ type: 'task_completed', taskId: 'b', status: 'completed' }]);
  });

  it('a present-but-exited terminal still completes on an incomplete page', () => {
    // Self-evident on any page: only DISAPPEARANCE needs the whole set.
    const adapter = new CodexEventAdapter();
    adapter.syncBackgroundTerminals({ data: [{ id: 'a' }], nextCursor: null });
    const events = adapter.syncBackgroundTerminals({ data: [{ id: 'a', exitCode: 0 }], nextCursor: 'MORE' });
    expect(events).toEqual([{ type: 'task_completed', taskId: 'a', status: 'completed' }]);
  });

  it('follows nextCursor across pages and diffs the WHOLE set', async () => {
    const pages: Record<string, unknown> = {
      __first: { data: [{ processId: '1' }], nextCursor: 'P2' },
      P2: { data: [{ processId: '2' }], nextCursor: null },
    };
    const sent: unknown[] = [];
    const { agent } = makeAgent(async (method, params) => {
      if (method !== 'thread/backgroundTerminals/list') return {};
      sent.push(params);
      const cursor = (params as { cursor?: string }).cursor;
      return pages[cursor ?? '__first'];
    });
    const sink = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(sink);
    expect(sink.events.map((e) => (e as { shellId?: string }).shellId)).toEqual(['1', '2']);
    expect(sent).toEqual([{ threadId: 'thread-bg' }, { threadId: 'thread-bg', cursor: 'P2' }]);

    // Both terminals gone on a COMPLETE listing → both complete.
    const second = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(second);
    expect(second.events).toEqual([]);
  });

  it('bounds the cursor walk and degrades to announce-only rather than spinning', async () => {
    let calls = 0;
    const { agent, debugLines } = makeAgent(async (method) => {
      if (method !== 'thread/backgroundTerminals/list') return {};
      calls += 1;
      // A server that ALWAYS returns a cursor must not be able to hang a turn.
      return { data: [{ processId: String(calls) }], nextCursor: `C${calls}` };
    });
    const sink = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(sink);
    expect(calls).toBe(10);
    expect(sink.events).toHaveLength(10);
    expect(sink.events.every((e) => e.type === 'shell_backgrounded')).toBe(true);
    expect(debugLines.some((l) => l.includes('treating the set as incomplete'))).toBe(true);
  });

  // ----------------------------------------------------------
  // P2.245 — a hang is not a throw, and this poll is on EVERY turn
  // ----------------------------------------------------------
  //
  // The `it`s in the first group below drive the fake client above, whose
  // `request` takes TWO arguments and drops the options object on the floor. That
  // is one real point: an `AppServerClient` reclaims its own pending entry from
  // `timeoutMs`, but the DEADLINE has to be the caller's property, not a favour
  // from whichever channel is on `this.client` — so these pass only if the race
  // holds it.
  //
  // AND THAT IS ONLY HALF THE COVERAGE — the half that shipped alone, and the
  // reason the sentinel was production-dead for a commit. A double that ignores
  // `timeoutMs` cannot see WHICH timer wins, so every one of these passed
  // identically with the production behaviour and without it. The second group
  // drives {@link makeTimeoutHonouringAgent}, which is what a real channel does,
  // and it fails the moment the sentinel stops winning.

  it('P2.245 · a list that never answers bounds the walk instead of hanging the turn', async () => {
    let calls = 0;
    const { agent, debugLines } = makeAgent(async (method) => {
      if (method !== 'thread/backgroundTerminals/list') return {};
      calls += 1;
      // The defect: an app-server that ACCEPTS the method and never answers.
      // Unbounded, this never settles — and a hang is not a red test, it is a
      // run that prints nothing and never ends.
      return await new Promise<never>(() => { /* never answers */ });
    });
    const sink = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(sink, 25);
    // ONE call, not ten. The budget is spent ACROSS the walk, so the ten
    // sequential pages can never multiply a per-call ceiling into 10x the wait
    // at the head of the user's turn.
    expect(calls).toBe(1);
    expect(sink.events).toEqual([]);
    expect(debugLines.some((l) => l.includes('did not answer within 25ms'))).toBe(true);
  });

  it('P2.245 · the budget is spent ACROSS the walk, so ten SLOW pages cannot multiply it', async () => {
    // The failure a per-call ceiling leaves standing, and the reason this row is
    // not just "pass timeoutMs". The pages are cursor-chained and therefore
    // SEQUENTIAL by construction — page N+1's cursor is read off page N — so a
    // ceiling of T on each call still lets the ten of them hold the head of the
    // user's turn for 10 x T. Here every page answers in 80ms, comfortably under
    // any per-call ceiling, and the walk's budget is 120ms.
    let calls = 0;
    const { agent, debugLines } = makeAgent(async (method) => {
      if (method !== 'thread/backgroundTerminals/list') return {};
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { data: [{ processId: String(calls) }], nextCursor: `C${calls}` };
    });
    const sink = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(sink, 120);
    // One page fits the budget, the second is cut short by what is left of it.
    // A per-call ceiling would have run all ten and taken ~800ms.
    expect(calls).toBeLessThan(3);
    expect(debugLines.some((l) => l.includes('did not answer within'))).toBe(true);
    // What DID arrive is still announced — the degradation is announce-only,
    // not silence.
    expect(sink.events).toEqual([
      { type: 'shell_backgrounded', toolUseId: 'codex-bgterm:1', shellId: '1' },
    ]);
  });

  it('P2.245 · a deadline is TRANSIENT — it never latches the capability off', async () => {
    let calls = 0;
    const { agent, debugLines } = makeAgent(async (method) => {
      if (method !== 'thread/backgroundTerminals/list') return {};
      calls += 1;
      return await new Promise<never>(() => { /* never answers */ });
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector(), 25);
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector(), 25);
    // The capability is not ABSENT, the answer is: a deadline must reach the
    // transient arm, never the definitive one that would disable background
    // terminals for the whole session. It cannot even be classified — the
    // deadline resolves a sentinel rather than rejecting, so no message of ours
    // is ever handed to `isDefinitiveBackgroundTerminalsRefusal`.
    expect(calls).toBe(2);
    expect(debugLines.some((l) => l.includes('disabled for this runtime'))).toBe(false);
  });

  it('P2.245 · a deadline mid-walk announces the pages that DID arrive and retires no chip', async () => {
    let calls = 0;
    const { agent } = makeAgent(async (method) => {
      if (method !== 'thread/backgroundTerminals/list') return {};
      calls += 1;
      if (calls === 1) return { data: [{ processId: '1' }], nextCursor: null };
      if (calls === 2) return { data: [{ processId: '2' }], nextCursor: 'P2' };
      return await new Promise<never>(() => { /* page 2 of the second walk hangs */ });
    });
    // First walk completes and announces terminal 1.
    const first = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(first, 25);
    expect(first.events).toEqual([
      { type: 'shell_backgrounded', toolUseId: 'codex-bgterm:1', shellId: '1' },
    ]);

    // Second walk reads one page (terminal 2, cursor set) and then times out.
    const second = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(second, 25);
    expect(calls).toBe(3);
    // The page that arrived is still announced — degradation is not silence.
    expect(second.events).toEqual([
      { type: 'shell_backgrounded', toolUseId: 'codex-bgterm:2', shellId: '2' },
    ]);
    // And terminal 1, absent from a PREFIX, is not reported as finished: a
    // timed-out walk hands the adapter `complete: false` exactly as an exhausted
    // page bound does.
    const adapter = (agent as unknown as { eventAdapter: CodexEventAdapter }).eventAdapter;
    expect(adapter.isKnownBackgroundTerminal('1')).toBe(true);
  });

  // ----------------------------------------------------------
  // P2.245 review — the same walk, on a channel that HONOURS timeoutMs
  // ----------------------------------------------------------

  it('P2.245 · on a TIMEOUT-HONOURING channel the SENTINEL wins, so the pages that arrived survive', async () => {
    // The measured defect, and the reason this file needed a second double. Both
    // timers used to be armed with the same number and `client.request(...)` is
    // evaluated first in the race, so the CHANNEL's rejection always arrived
    // first on a real `AppServerClient`. Measured against the committed code with
    // exactly this scenario: no events at all, no `did not answer within` line,
    // and the transient `catch` instead — the page that HAD arrived was thrown
    // away, and "degradation is announce-only, not silence" was, in production,
    // silence.
    let calls = 0;
    const { agent, debugLines } = makeTimeoutHonouringAgent(async (method) => {
      if (method !== 'thread/backgroundTerminals/list') return {};
      calls += 1;
      if (calls === 1) return { data: [{ processId: '1' }], nextCursor: 'P1' };
      return await new Promise<never>(() => { /* the second page never answers */ });
    });
    const sink = collector();
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(sink, 60);

    expect(calls).toBe(2);
    // The deadline branch, not the error branch: the operator-facing line exists
    // and the classifier was never reached.
    expect(debugLines.some((l) => l.includes('did not answer within 60ms'))).toBe(true);
    expect(debugLines.some((l) => l.includes('failed transiently'))).toBe(false);
    // And the page that arrived is still announced.
    expect(sink.events).toEqual([
      { type: 'shell_backgrounded', toolUseId: 'codex-bgterm:1', shellId: '1' },
    ]);
  });

  it('P2.245 · a deadline on a HONOURING channel is still transient — it never latches', async () => {
    const { agent, debugLines } = makeTimeoutHonouringAgent(async (method) => {
      if (method !== 'thread/backgroundTerminals/list') return {};
      return await new Promise<never>(() => { /* never answers */ });
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector(), 25);
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector(), 25);
    // The capability is not absent, the answer is — and on THIS channel that was
    // load-bearing on a second, undocumented mechanism (the channel's timeout
    // message carries no serde token) rather than on the sentinel it was
    // documented to rest on.
    expect(debugLines.some((l) => l.includes('disabled for this runtime'))).toBe(false);
    expect((agent as unknown as { backgroundTerminalsUnsupported: boolean }).backgroundTerminalsUnsupported).toBe(false);
  });

  it('P2.245 · the channel is handed WHOLE milliseconds, and more of them than the race gets', async () => {
    // Two facts in one assertion, both of them defects that were live: the
    // channel's budget must EXCEED this caller's or the sentinel cannot win, and
    // it must be a whole number or it reaches an operator as
    // `timed out after 59.70074999999997ms` (a real debug line — the budget
    // arrives as a `performance.now()` difference).
    const { agent, channelTimeouts } = makeTimeoutHonouringAgent(async () => ({ data: [], nextCursor: null }));
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector(), 60);
    expect(channelTimeouts).toHaveLength(1);
    expect(Number.isInteger(channelTimeouts[0])).toBe(true);
    expect(channelTimeouts[0]!).toBeGreaterThan(60);
    expect(channelTimeouts[0]!).toBeLessThanOrEqual(160);
  });

  it('P2.245 · the DEFAULT budget on the wire is the production constant, not a number a test invented', async () => {
    // Every other test in this row passes an explicit small budget, so nothing
    // pinned the number production actually uses — a default that drifted to
    // `undefined` would restore the exact hang this row exists to close, with the
    // whole suite still green.
    expect(CODEX_BACKGROUND_TERMINALS_TIMEOUT_MS).toBe(5_000);
    const { agent, channelTimeouts } = makeTimeoutHonouringAgent(async () => ({ data: [], nextCursor: null }));
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(channelTimeouts).toHaveLength(1);
    expect(channelTimeouts[0]!).toBeGreaterThan(CODEX_BACKGROUND_TERMINALS_TIMEOUT_MS);
    expect(channelTimeouts[0]!).toBeLessThanOrEqual(CODEX_BACKGROUND_TERMINALS_TIMEOUT_MS + 100);
  });

  it('P2.245 · the channel rejection the race LOSES is not an unhandled rejection', async () => {
    // The cost of letting the sentinel win: the channel's own timer is still
    // armed and still fires, a margin after this caller has moved on. If that
    // rejection were unhandled it would be a process-level event in every turn of
    // a wedged session. `Promise.race` subscribes to both arms, so it is not.
    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown) => captured.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { agent } = makeTimeoutHonouringAgent(async (method) => {
        if (method !== 'thread/backgroundTerminals/list') return {};
        return await new Promise<never>(() => { /* never answers */ });
      });
      await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector(), 25);
      // Past the channel's own timer (this caller's budget plus the margin).
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(captured).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('NEVER throws, structurally — a hostile list shape is contained', async () => {
    // The parse and the pushes used to sit OUTSIDE the try, so only the request
    // was guarded. A sink that throws stands in for any downstream fault.
    const { agent } = makeAgent(async () => ({ data: [{ processId: '7' }], nextCursor: null }));
    const hostile = { push: () => { throw new Error('sink exploded'); } };
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(hostile);
    // Reaching here at all is the assertion: no rejection escaped.
    expect(true).toBe(true);
  });

  it('reads terminated=false instead of rounding a response up to success', async () => {
    const { agent } = makeAgent(async (method) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [{ processId: '99' }], nextCursor: null };
      if (method === 'thread/backgroundTerminals/terminate') return { terminated: false };
      return {};
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(await agent.stopBackgroundTask('99')).toEqual({ stopped: false });
  });

  it('treats terminated=true (and an absent field) as a real stop', async () => {
    const { agent } = makeAgent(async (method) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [{ processId: '99' }], nextCursor: null };
      if (method === 'thread/backgroundTerminals/terminate') return { terminated: true };
      return {};
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(await agent.stopBackgroundTask('99')).toEqual({ stopped: true });
  });

  it('an `invalid digit` refusal keeps walking the candidates instead of failing silently', async () => {
    // Not a shape error, so the original code `break`s and Stop failed silently.
    const attempted: string[] = [];
    const { agent } = makeAgent(async (method, params) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [{ processHandle: 'sh-x' }], nextCursor: null };
      if (method === 'thread/backgroundTerminals/terminate') {
        const key = Object.keys(params as Record<string, unknown>).find((k) => k !== 'threadId')!;
        attempted.push(key);
        throw new Error('invalid background terminal process id: invalid digit found in string');
      }
      return {};
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(await agent.stopBackgroundTask('sh-x')).toEqual({ stopped: false });
    // It tried the learned key AND every remaining candidate, rather than one.
    expect(attempted.length).toBeGreaterThan(1);
    expect(attempted[0]).toBe('processHandle');
  });

  it('a bare "not supported" does NOT latch — only serde tokens do', async () => {
    // 92/139 such strings exist in the binary as ordinary runtime conditions; a
    // transient one used to disable the capability for the whole session.
    let calls = 0;
    const { agent } = makeAgent(async () => {
      calls += 1;
      throw new Error('this operation is not supported while the thread is busy');
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(calls).toBe(2);
  });

  it('-32600 (this binary answers it for everything) does not latch on its own', async () => {
    let calls = 0;
    const { agent } = makeAgent(async () => {
      calls += 1;
      throw Object.assign(new Error('request failed'), { code: -32600 });
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(calls).toBe(2);
  });

  it('a -32600 carrying a serde message DOES latch (text is the real signal here)', async () => {
    let calls = 0;
    const { agent } = makeAgent(async () => {
      calls += 1;
      throw Object.assign(new Error('unknown variant `thread/backgroundTerminals/list`'), { code: -32600 });
    });
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    await (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink(collector());
    expect(calls).toBe(1);
  });
});

// ============================================================
// 3. Turn-boundary wiring — the poll actually runs inside chatImpl
// ============================================================

describe('CodexAgent turn-boundary background-terminal wiring', () => {
  afterEach(() => cleanupModeState(KEY));

  it('polls at the turn boundary and yields the chip event before complete', async () => {
    cleanupModeState(KEY);
    const agent = new CodexAgent(createConfig());
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      request(method: string, params: unknown) {
        requests.push({ method, params });
        if (method === 'thread/backgroundTerminals/list') {
          return Promise.resolve({ terminals: [{ id: 'term-boot', command: 'python3 -m http.server' }] });
        }
        if (method === 'turn/start') {
          queueMicrotask(() => (agent as unknown as { handleNotification: (m: string, p: unknown) => void }).handleNotification('turn/completed', {}));
        }
        return Promise.resolve({ thread: { id: 'thread-1' } });
      },
      notify() {},
      close() {},
    };
    (agent as unknown as { ensureRuntime: () => Promise<void>; client: unknown; threadId: string | null }).ensureRuntime = async () => {
      (agent as unknown as { client: unknown }).client = client;
      (agent as unknown as { threadId: string | null }).threadId = 'thread-1';
    };
    agent.setCapabilityTurnRuntime({ view: { skills: [] } } as never);

    const events: AgentEvent[] = [];
    for await (const event of (agent as unknown as { chatImpl: (m: string) => AsyncGenerator<AgentEvent> }).chatImpl('hello codex')) {
      events.push(event);
    }

    const shellIdx = events.findIndex((e) => e.type === 'shell_backgrounded');
    const completeIdx = events.findIndex((e) => e.type === 'complete');
    expect(shellIdx).toBeGreaterThanOrEqual(0);
    expect((events[shellIdx] as Extract<AgentEvent, { type: 'shell_backgrounded' }>).shellId).toBe('term-boot');
    // The chip must ride ahead of `complete` — SessionManager returns the chat
    // iterator on `complete`, so anything after it would be dropped.
    expect(completeIdx).toBeGreaterThan(shellIdx);

    // And the list was polled BEFORE turn/start (a turn boundary, not mid-turn).
    const methods = requests.map((r) => r.method);
    expect(methods.indexOf('thread/backgroundTerminals/list')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('thread/backgroundTerminals/list')).toBeLessThan(methods.indexOf('turn/start'));
  });

  it('P2.245 · a turn whose background-terminal sync never answers STILL STARTS and still completes', async () => {
    // The row's whole point, driven through the real `chatImpl`: this poll is
    // awaited at the head of EVERY turn, so an app-server that accepts the
    // method and never answers used to end the turn before it began — the user
    // sees their own message and then nothing, with no status and no error.
    cleanupModeState(KEY);
    const agent = new CodexAgent(createConfig());
    const requests: Array<{ method: string; params: unknown }> = [];
    const debugLines: string[] = [];
    agent.onDebug = (m) => debugLines.push(m);
    const client = {
      request(method: string, params: unknown) {
        requests.push({ method, params });
        if (method === 'thread/backgroundTerminals/list') {
          return new Promise<never>(() => { /* accepted, never answered */ });
        }
        if (method === 'turn/start') {
          queueMicrotask(() => (agent as unknown as { handleNotification: (m: string, p: unknown) => void }).handleNotification('turn/completed', {}));
        }
        return Promise.resolve({ thread: { id: 'thread-1' } });
      },
      notify() {},
      close() {},
    };
    (agent as unknown as { ensureRuntime: () => Promise<void>; client: unknown; threadId: string | null }).ensureRuntime = async () => {
      (agent as unknown as { client: unknown }).client = client;
      (agent as unknown as { threadId: string | null }).threadId = 'thread-1';
    };
    agent.setCapabilityTurnRuntime({ view: { skills: [] } } as never);
    // The SHIPPED implementation, with a budget a test can wait out — which is
    // what the method's `timeoutMs` parameter is for. Production takes the
    // 5 s constant; nothing else about the path is stubbed.
    const poll = (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink.bind(agent);
    (agent as unknown as PrivatePoll).syncBackgroundTerminalsIntoSink = (sink) => poll(sink, 25);

    const events: AgentEvent[] = [];
    for await (const event of (agent as unknown as { chatImpl: (m: string) => AsyncGenerator<AgentEvent> }).chatImpl('hello codex')) {
      events.push(event);
    }

    // The turn ran: the poll did not swallow it, and it degraded out loud.
    expect(requests.map((r) => r.method)).toContain('turn/start');
    expect(events.some((e) => e.type === 'complete')).toBe(true);
    expect(debugLines.some((l) => l.includes('the turn starts anyway'))).toBe(true);
  });
});

/**
 * P6.793 — the codex REFUSAL, stated by name.
 *
 * Native-first, asked and answered: `grep -ril background packages/codex-protocol/generated`
 * returns ONE file (`ImageGenerationItem.ts`) against 562 generated v2 types.
 * The `thread/backgroundTerminals/*` pair the rest of this file drives is not
 * the same mechanism and must not be mistaken for it — it lists and terminates
 * terminals codex ITSELF started in the background; nothing there takes a
 * running foreground call and lets the turn continue without it.
 *
 * The method exists precisely because omitting it would look identical from the
 * caller's side while carrying no reason, which is the silent block this row
 * removes.
 */
describe('CodexAgent.backgroundInFlightTasks (P6.793)', () => {
  it('refuses by name, sends no request, and never claims success', async () => {
    const { agent, requests } = makeAgent(async () => ({}));

    const result = await agent.backgroundInFlightTasks('toolu_01');

    expect(result).toEqual({ backgrounded: false, unsupported: true });
    // `unsupported` and not an `error`: "this runtime has no such lever" is not
    // "the lever went wrong", and the two get different sentences.
    expect(result).not.toHaveProperty('error');
    expect(requests).toEqual([]);
  });
});
