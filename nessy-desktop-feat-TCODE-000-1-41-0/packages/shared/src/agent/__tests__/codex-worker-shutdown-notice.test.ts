/**
 * P6.271, the codex half — a worker shutting down is announced on claude, was
 * announced on Pi by `d4bf58cc3`, and on codex was said nowhere.
 *
 * ## The row's verdict, and the direction it was true of
 *
 * The row records codex as `absent` — STRUCTURAL. That is true of RECEIVING:
 * `shutdown` occurs in exactly one of 562 generated v2 files
 * (`CollabAgentStatus.ts`, a spawned agent's status, not a worker notice), so
 * codex never tells us its worker is going. It is NOT true of this signal, which
 * is HOST-originated on codex exactly as it is on Pi: we are the ones tearing the
 * app-server down for an idle provider replacement, so nothing has to be learned
 * — only said. Half (b) of the row is unaffected and stays as written.
 *
 * ## Why the two cases below are a PAIR, and the silent one carries the contract
 *
 * The message being matched is `SDKWorkerShuttingDownMessage`, whose docblock in
 * the vendored `sdk.d.ts` reads, verbatim: *"Emitted by the bridge on opt-in
 * graceful worker teardown (only when the teardown caller supplied a reason) …
 * Absence is NOT a dead-host signal: handoffs (/update, /teleport, respawn),
 * auto-disable, mode transitions, and internal fatal-error paths emit nothing by
 * design."* So a notice on EVERY teardown would be wrong, and a test that only
 * asserted the notice exists would pass over exactly that implementation.
 *
 * Codex needs a discriminator Pi did not: on Pi the final path ends in a
 * different kill (`killSubprocess`), while here `destroy()` and the restart both
 * go through `disposeForRestart()`. `destroyed` cannot answer — `destroy()`
 * opens with `if (this.destroyed) return`, so it is still false at the
 * delegation — which is why `teardownIsFinal` exists and why the second case
 * below is the one that would catch a regression to `destroyed`.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

interface Event { type: string; message?: string; level?: string }

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-worker-shutdown',
      name: 'Codex Worker Shutdown Workspace',
      rootPath: '/tmp/ws-codex-worker-shutdown-root',
      workspaceRootPath: '/tmp/ws-codex-worker-shutdown-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-worker-shutdown',
    } as any,
    session: {
      id: 'session-codex-worker-shutdown',
      workspaceRootPath: '/tmp/ws-codex-worker-shutdown-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

interface Rig {
  agent: CodexAgent;
  /** What the OPEN turn received, in order. */
  events: Event[];
  /** What was held for the next turn, for a teardown with no turn open. */
  pending: string[];
  /** True once the turn sink has been finished — read per push. */
  finishedBeforePush: boolean[];
}

function setupRig(options: { withTurn?: boolean } = {}): Rig {
  const agent = new CodexAgent(createConfig());
  const events: Event[] = [];
  const finishedBeforePush: boolean[] = [];
  let finished = false;
  const sink = {
    push: (event: Event) => {
      events.push(event);
      finishedBeforePush.push(finished);
    },
    finish: () => { finished = true },
  };
  const internals = agent as unknown as {
    turnSink: typeof sink | null;
    pendingServerWarningNotices: string[];
    teardownRuntime: () => Promise<void>;
    debug: (message: string) => void;
  };
  internals.turnSink = options.withTurn ? sink : null;
  // The runtime was never started in this rig; the disposal's async half is not
  // this row's subject and would only measure the harness.
  internals.teardownRuntime = async () => {};
  internals.debug = () => {};
  return { agent, events, pending: internals.pendingServerWarningNotices, finishedBeforePush };
}

const NOTICE = 'Codex worker is shutting down (runtime_restart).';

describe('P6.271 — the codex worker-shutdown notice', () => {
  it('a graceful restart says claude\'s own sentence on the open turn, before the sink is finished', async () => {
    const rig = setupRig({ withTurn: true });

    await rig.agent.disposeForRestart();

    const notices = rig.events.filter(event => event.type === 'info' && event.message === NOTICE);
    expect(notices).toHaveLength(1);
    // Durable + warning is the one family the session layer persists, matching
    // claude's own `level` for this message.
    expect(notices[0]!.level).toBe('warning');
    // The ordering half: `disposeForRestart` finishes the turn sink in the same
    // synchronous prologue, and a finished sink accepts nothing. Asserting the
    // message alone would not see a notice placed one line later.
    expect(rig.finishedBeforePush).toEqual([false]);
  });

  it('holds the notice for the next turn when the restart finds no turn open', async () => {
    // The ACTUAL case for an idle provider replacement — and the reason this
    // uses the runtime's own `surfaceCodexOperatorNotice` seam rather than a
    // straight push, which would report nothing exactly when it matters.
    const rig = setupRig();

    await rig.agent.disposeForRestart();

    expect(rig.events).toEqual([]);
    expect(rig.pending).toContain(NOTICE);
  });

  it('a FINAL teardown stays silent, as claude does on its end-of-life paths', () => {
    const rig = setupRig({ withTurn: true });

    // `destroy()` delegates to `disposeForRestart()`, so this is the case a
    // notice placed unconditionally in that method would get wrong — and the
    // case a discriminator written as `this.destroyed` would ALSO get wrong,
    // because `destroy()` returns early on that flag and so cannot have set it.
    rig.agent.destroy();

    // The silence has to be a DECISION, not a `destroy()` that threw before it
    // reached the delegation — in which case this case would pass over any
    // implementation at all. `runtimeDisposal` is assigned by the same
    // synchronous prologue the notice sits in, so its presence proves the
    // prologue ran.
    expect((rig.agent as unknown as { runtimeDisposal: unknown }).runtimeDisposal).not.toBeNull();
    expect(rig.events.filter(event => event.message === NOTICE)).toEqual([]);
    expect(rig.pending).not.toContain(NOTICE);
  });
});
