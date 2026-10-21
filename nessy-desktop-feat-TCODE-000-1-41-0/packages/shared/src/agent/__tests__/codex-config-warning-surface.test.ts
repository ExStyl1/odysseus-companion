/**
 * P3.120 — the `configWarning` P3.81 classified must reach a USER, not just a
 * log a packaged build never writes.
 *
 * ## What was still silent after P3.81
 *
 * P3.81 put one classified sentence on `AppServerClient`'s `onDiagnostic`
 * channel. `CodexAgent` bound that channel to `debug()`, which routes through
 * electron-log — and the packaged main process disables its transports. So the
 * one class the sentence names — *"this session has NO projected non-negotiable
 * deny rules and NO durable Always-Allow grants"* — reached nobody on a real
 * build. The fix is a SURFACE, not a log level.
 *
 * ## Why the deferral is the load-bearing half here too
 *
 * MEASURED by P3.81 against the shipped `codex-app-server` (rust-v0.148.0,
 * darwin-arm64, md5 `eb2144664b1c4eb0697b69b4b242b737`): a rules `configWarning`
 * arrives in the same flush as the `initialize` RESPONSE — 92 ms from spawn on
 * darwin-arm64, 260 ms under Rosetta — which is before `thread/start`, let alone
 * before any turn. `turnSink` is null at that moment, so a surfacing built on
 * `turnSink?.push(...)` would fire exactly never for the only class we can name.
 *
 * The payloads below are P3.81's own measured ones, run through the real
 * classifier shape (the `[codex configWarning]` prefix plus its sentence), so
 * this file asserts on the strings a real binary produces rather than on
 * invented ones.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-codex-config-warning';
const SESSION_ID = 'session-codex-config-warning';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Codex Config Warning Workspace',
      rootPath: '/tmp/ws-codex-config-warning-root',
      workspaceRootPath: '/tmp/ws-codex-config-warning-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-config-warning',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-codex-config-warning-root',
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
  /** The channel `AppServerClient` writes classified lines onto. */
  diagnostic: (message: string) => void;
  openTurn: () => Event[];
  events: Event[];
  pending: string[];
}

function harness(options: { withTurn?: boolean } = {}): Harness {
  const agent = new CodexAgent(createConfig());
  const internals = agent as unknown as {
    turnSink: { push: (e: Event) => void } | null;
    pendingServerWarningNotices: string[];
    noteCodexConfigWarningDiagnostic: (message: string) => void;
    flushPendingServerWarnings: (queue: { push: (e: Event) => void }) => void;
  };
  const events: Event[] = [];
  const sink = { push: (e: Event) => events.push(e) };
  internals.turnSink = options.withTurn ? sink : null;
  return {
    diagnostic: message => internals.noteCodexConfigWarningDiagnostic(message),
    openTurn: () => {
      internals.turnSink = sink;
      internals.flushPendingServerWarnings(sink);
      return events;
    },
    events,
    pending: internals.pendingServerWarningNotices,
  };
}

/**
 * The rules class, as `describeCodexConfigWarning` emits it. Verbatim from
 * `config-warning.ts`, including the two things it says are now absent — those
 * are the half a reader who sees only "Error parsing rules" never connects to
 * the security floor.
 */
const RULES_LINE =
  '[codex configWarning] EXECPOLICY RULES DID NOT LOAD — codex fails a rules file open and '
  + 'whole-file, so one bad line drops ALL of them: this session has NO projected non-negotiable '
  + 'deny rules and NO durable Always-Allow grants. Error parsing rules; custom rules not applied. '
  + '— /tmp/p381-home-fINkPw/rules/nessy.rules';

/** The P6.7 class on the same channel — an administrator requirement clamped a setting. */
const REQUIREMENT_LINE =
  '[codex configWarning] AN ADMINISTRATOR REQUIREMENT OVERRODE THIS SESSION\'S SETTING '
  + '(`permission_profile`) — codex did not refuse: it replaced the value this app asked for '
  + 'with the one a deployed requirements.toml requires, and started anyway.';

describe('codex `configWarning` reaches the operator, not only the log', () => {
  /**
   * THE ROW'S CENTRAL CASE.
   *
   * KILLS: leaving the line on `debug()` alone, and any surfacing built on
   * `turnSink?.push(...)` — the frame lands at `initialize`, when there is no
   * turn, so a straight push reports nothing at all for the measured class.
   */
  it('holds the rules warning that arrives before any turn, and delivers it when one opens', () => {
    const h = harness();
    h.diagnostic(RULES_LINE);

    expect(h.events).toEqual([]);
    expect(h.pending).toHaveLength(1);

    const delivered = h.openTurn();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.type).toBe('info');
    // Durable + warning is the ONE family the session layer persists, so a
    // security floor's disappearance survives a reload instead of scrolling past.
    expect(delivered[0]!.level).toBe('warning');
    expect(delivered[0]!.message).toContain('NO projected non-negotiable deny rules');
    expect(delivered[0]!.message).toContain('NO durable Always-Allow grants');
    expect(h.pending).toHaveLength(0);
  });

  /** KILLS: a deferral so unconditional a mid-session warning waits for the NEXT turn. */
  it('pushes straight onto a turn that is already open', () => {
    const h = harness({ withTurn: true });
    h.diagnostic(REQUIREMENT_LINE);
    expect(h.pending).toHaveLength(0);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.level).toBe('warning');
    expect(h.events[0]!.message).toContain('permission_profile');
  });

  /**
   * KILLS: routing the WHOLE diagnostic channel to the transcript. That channel
   * also carries `[app-server stderr]` chunks, `invalid JSON line: …` and
   * `response for unknown id …` — turning those into durable user-visible
   * warnings would bury the one class that matters under runtime noise.
   */
  it('ignores every other line on the same diagnostic channel', () => {
    const h = harness({ withTurn: true });
    for (const line of [
      '[app-server stderr] 2026-09-01T00:00:00Z INFO codex_core: started',
      'invalid JSON line: {"jsonrpc"',
      'response for unknown id 7',
      'cannot write: stdin not writable',
      'unrecognized message: hello',
      'codex configWarning without the bracket prefix',
    ]) h.diagnostic(line);
    expect(h.events).toEqual([]);
    expect(h.pending).toEqual([]);
  });

  /** KILLS: an unbounded queue, and a re-forked runtime repeating one sentence per fork. */
  it('deduplicates and bounds what it holds, sharing one ceiling with its sibling', () => {
    const h = harness();
    for (let i = 0; i < 30; i += 1) h.diagnostic(RULES_LINE);
    expect(h.pending).toHaveLength(1);
    for (let i = 0; i < 30; i += 1) h.diagnostic(`[codex configWarning] distinct ${i}`);
    expect(h.pending.length).toBeLessThanOrEqual(8);
  });

  /** KILLS: a throw inside the transport's own diagnostic dispatch. */
  it('never throws on a degenerate line', () => {
    const h = harness({ withTurn: true });
    for (const line of ['', ' ', '[codex configWarning]']) {
      expect(() => h.diagnostic(line)).not.toThrow();
    }
    // The bare prefix IS a classifier line (the classifier always emits at
    // least "no summary, path or details on the notification" after it), so it
    // surfaces rather than being dropped — the empty strings do not.
    expect(h.events).toHaveLength(1);
  });

  /**
   * POSITIVE CONTROL on the same rig: the absence assertion above must not be
   * an inert harness. The sibling `warning` channel P2.408 built still lands.
   */
  it('POSITIVE CONTROL: the sibling plain `warning` still reaches the sink', () => {
    const agent = new CodexAgent(createConfig());
    const internals = agent as unknown as {
      threadId: string | null;
      turnSink: { push: (e: Event) => void } | null;
      handleNotification: (method: string, params: unknown) => void;
    };
    const events: Event[] = [];
    internals.threadId = 'thread-codex-config-warning';
    internals.turnSink = { push: (e: Event) => events.push(e) };
    internals.handleNotification('guardianWarning', {
      threadId: 'thread-codex-config-warning',
      message: 'network egress blocked',
    });
    expect(events).toEqual([
      { type: 'info', message: 'Guardian: network egress blocked', level: 'warning' },
    ]);
  });
});

/**
 * The WIRING, pinned by source match, for the reason `codex-config-requirements
 * .test.ts` gives for the same technique: `createRuntime` spawns a real
 * app-server, verifies a binary manifest and binds an adapter port, so the one
 * line that carries this whole row — the `AppServerClient` diagnostic channel
 * reaching the surfacing method at all — is not drivable from a unit test.
 *
 * Without this case the behaviour above is real and UNREACHED: every assertion
 * calls the private method directly, so deleting the call site would leave the
 * suite green and the user silent again. That is precisely the shape of the
 * defect P3.120 exists to close, one layer up.
 */
describe('the codex spawn routes its diagnostic channel to the surface', () => {
  const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
  const at = (needle: string): number => {
    const index = source.indexOf(needle);
    expect(index, `missing source anchor: ${needle}`).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('surfaces from the AppServerClient onDiagnostic handler, without removing the log line', () => {
    const client = at('client = new AppServerClient(child, {');
    const debugLine = at('          this.debug(m);');
    const surface = at('          this.noteCodexConfigWarningDiagnostic(m);');
    const notification = at('        onNotification: (method, params) => this.handleNotification(method, params),');
    // Both, in the one handler: P3.81's log line is support's copy and must not
    // be traded away for the user's copy.
    expect(client).toBeLessThan(debugLine);
    expect(debugLine).toBeLessThan(surface);
    expect(surface).toBeLessThan(notification);
  });
});
