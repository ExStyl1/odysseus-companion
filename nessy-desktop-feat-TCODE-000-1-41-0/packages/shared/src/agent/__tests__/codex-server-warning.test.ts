/**
 * P2.408 (agent half) — codex's plain `warning` must reach a human, and the
 * DEFERRAL is what makes that true rather than notionally true.
 *
 * MEASURED against the shipped `codex-app-server` (`rust-v0.148.0`,
 * darwin-arm64, 2026-08-29): the frame arrives in the same flush as
 * `thread/started`, once per thread, and never at `initialize`. `CodexAgent`
 * opens its thread in `createRuntime`, while `turnSink` is set by `chatImpl` —
 * so at the moment this notification lands there is no turn, and a surfacing
 * built on `turnSink?.push(...)` would fire exactly never for the one class we
 * can name.
 *
 * Real frame, verbatim off the wire (CODEX_HOME path shortened):
 *
 * ```json
 * {"threadId":"01a04ea4-95b8-7180-b5b9-cadd3924f7c8",
 *  "message":"Under-development features enabled: executed_tool_call_metadata. …"}
 * ```
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-codex-warning';
const SESSION_ID = 'session-codex-warning';
const THREAD = 'thread-codex-warning';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Codex Warning Workspace',
      rootPath: '/tmp/ws-codex-warning-root',
      workspaceRootPath: '/tmp/ws-codex-warning-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-warning',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-codex-warning-root',
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
  notify: (method: string, params: unknown) => void;
  /** Open a turn sink, as `chatImpl` does, and drain anything held for it. */
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
  internals.threadId = THREAD;
  internals.turnSink = options.withTurn ? sink : null;
  return {
    notify: (method, params) => internals.handleNotification(method, params),
    openTurn: () => {
      internals.turnSink = sink;
      internals.flushPendingServerWarnings(sink);
      return events;
    },
    events,
    pending: internals.pendingServerWarningNotices,
  };
}

/** ARM B of the live probe, verbatim; `CODEX_HOME` path shortened. */
const UNSTABLE = {
  threadId: THREAD,
  message:
    'Under-development features enabled: executed_tool_call_metadata. Under-development features '
    + 'are incomplete and may behave unpredictably. To suppress this warning, set '
    + '`suppress_unstable_features_warning = true` in /tmp/p2408-home-fINkPw/config.toml.',
};

describe('codex `warning` reaches the operator', () => {
  /**
   * THE ROW'S CENTRAL CASE, and the one the measurement forced.
   *
   * KILLS: surfacing this on `turnSink?.push(...)` alone. That variant passes
   * every "does the classifier work" test and reports NOTHING in production,
   * because the frame lands before any turn exists.
   */
  it('holds a warning that arrives before any turn, and delivers it when one opens', () => {
    const h = harness();
    h.notify('warning', UNSTABLE);

    expect(h.events).toEqual([]);
    expect(h.pending).toHaveLength(1);

    const delivered = h.openTurn();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.type).toBe('info');
    // Durable + warning is the ONE family the session layer persists, so the
    // notice survives a reload instead of scrolling past.
    expect(delivered[0]!.level).toBe('warning');
    expect(delivered[0]!.message).toContain('under development');
    expect(delivered[0]!.message).toContain('executed_tool_call_metadata');
    // Nothing left behind, and nothing repeated on the next turn.
    expect(h.pending).toHaveLength(0);
    expect(h.openTurn()).toHaveLength(1);
  });

  /**
   * KILLS: a deferral so unconditional that a mid-turn warning is withheld until
   * the NEXT turn — which for a re-forked thread would report the wrong session.
   */
  it('pushes straight onto a turn that is already open', () => {
    const h = harness({ withTurn: true });
    h.notify('warning', UNSTABLE);
    expect(h.pending).toHaveLength(0);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.level).toBe('warning');
  });

  /**
   * KILLS: relaying codex's "set `suppress_unstable_features_warning = true`"
   * advice into a transcript. That is one of the four keys P2.384 pinned
   * unwritten, all four are schema-valid, and the tripwire only watches the
   * config writer's output — nothing would catch an operator who took the hint.
   */
  it('does not tell the operator how to silence it', () => {
    const h = harness({ withTurn: true });
    h.notify('warning', UNSTABLE);
    expect(h.events[0]!.message).not.toContain('suppress_unstable_features_warning');
  });

  /**
   * KILLS: a queue an unbounded producer can grow without limit, and a re-forked
   * thread reporting the same sentence once per fork.
   */
  it('deduplicates and bounds what it holds', () => {
    const h = harness();
    for (let i = 0; i < 30; i += 1) h.notify('warning', UNSTABLE);
    expect(h.pending).toHaveLength(1);
    for (let i = 0; i < 30; i += 1) {
      h.notify('warning', { threadId: THREAD, message: `distinct notice ${i}` });
    }
    expect(h.pending.length).toBeLessThanOrEqual(8);
  });

  /**
   * KILLS: dropping an unclassified warning — the exact defect this row fixes,
   * reintroduced one class narrower.
   */
  it('relays a warning of a class it cannot name', () => {
    const h = harness({ withTurn: true });
    h.notify('warning', { threadId: THREAD, message: 'Something else entirely happened.' });
    expect(h.events[0]!.message).toBe('Codex: Something else entirely happened.');
  });

  /** KILLS: an empty transcript row, and a throw inside notification dispatch. */
  it('says nothing for an empty or malformed payload, and never throws', () => {
    const h = harness({ withTurn: true });
    for (const params of [{}, null, undefined, { message: '  ' }, { message: 7 }, 'nope']) {
      expect(() => h.notify('warning', params)).not.toThrow();
    }
    expect(h.events).toEqual([]);
    expect(h.pending).toEqual([]);
  });

  /**
   * POSITIVE CONTROL on the same rig: an absence above must not be an inert
   * harness. A `guardianWarning` — the live control P2.384 named — still lands.
   */
  it('POSITIVE CONTROL: the sibling guardianWarning still reaches the sink', () => {
    const h = harness({ withTurn: true });
    h.notify('guardianWarning', { threadId: THREAD, message: 'network egress blocked' });
    expect(h.events).toEqual([
      { type: 'info', message: 'Guardian: network egress blocked', level: 'warning' },
    ]);
  });
});
