/**
 * P3.315 — codex writes one sandbox mode and enforces another, and nothing said
 * so. These are the assertions that refuse to let that be silent again.
 *
 * ## The measurement behind the fixtures
 *
 * Driven on the bundled `darwin-arm64/codex-app-server` (`rust-v0.148.0`,
 * 2026-09-03, load 19-27), reading `ThreadStartResponse.sandbox` — the field the
 * host used to cast away. Six arms, two of them CONTROLS:
 *
 * | config | resolved `sandbox` |
 * | --- | --- |
 * | shipped shape: `sandbox_mode = "danger-full-access"` + `default_permissions` (extends `:workspace`) | **`workspaceWrite`** |
 * | CONTROL: `sandbox_mode = "danger-full-access"` ALONE | `dangerFullAccess` |
 * | shipped read-only shape: `sandbox_mode = "read-only"` + the profile (extends `:read-only`) | `readOnly` — agrees |
 * | CONTROL: `sandbox_mode = "read-only"` ALONE | `readOnly` |
 * | `default_permissions = ":danger-full-access"` | `dangerFullAccess` |
 * | `extends = ":danger-full-access"` | config REJECTED — `cannot extend unsupported built-in profile` |
 *
 * The controls are what make the first row a reading rather than a dead rig: the
 * SAME mode alone is honoured. Source agrees at the same tag —
 * `resolve_permission_config_syntax` sets `Profiles` from `default_permissions`
 * AFTER `Legacy` from `sandbox_mode` within one layer, and the `Profiles` branch
 * of `Config::load` never reads the mode.
 *
 * ## What each test kills
 *
 *  - "reports the divergence" dies if the reader is removed — the shipped state,
 *    where a session runs under a policy the user was never shown.
 *  - "names the resolved policy as the one in force" dies if the notice reports
 *    the two values without saying which wins, which is the half that makes it
 *    actionable rather than merely alarming.
 *  - "stays quiet when they agree" is the CONTROL: without it, a reader that
 *    warned unconditionally would pass the test above and be useless.
 *  - "degrades on an absent field" dies if a shape drift starts throwing or
 *    refusing — the same degradation contract `verifyPermissionProfileAccepted`
 *    follows two methods below it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAgent } from '../codex-agent.ts';
import { createMockBackendConfig } from './test-utils.ts';
import type { BackendConfig } from '../backend/types.ts';

type Probe = {
  agent: CodexAgent;
  debug: string[];
  /** Operator notices held for the next turn — there is no `turnSink` here. */
  notices: string[];
  note: (resolved: { type?: string } | undefined) => void;
};

/** An agent whose written mode is pinned, so the assertions never read the rig. */
function codexAgent(sandboxOn: boolean, mode = 'default'): Probe {
  const debug: string[] = [];
  const agent = new CodexAgent({
    ...createMockBackendConfig(),
    provider: 'codex-runtime',
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig);
  (agent as unknown as { onDebug?: (m: string) => void }).onDebug = (message: string) => {
    debug.push(message);
  };
  // Both inputs to the written mode are stubbed rather than left to the ambient
  // config: the sandbox default is a standing product decision that has moved
  // once already, and a test that inherits it asserts the rig.
  const inner = agent as unknown as {
    getPermissionMode(): string;
    sandboxGloballyEnabled(): boolean;
    pendingServerWarningNotices: string[];
    noteResolvedSandboxPolicy(resolved: { type?: string } | undefined): void;
  };
  inner.getPermissionMode = () => mode;
  inner.sandboxGloballyEnabled = () => sandboxOn;
  return {
    agent,
    debug,
    notices: inner.pendingServerWarningNotices,
    note: (resolved) => inner.noteResolvedSandboxPolicy(resolved),
  };
}

describe('P3.315 — the written sandbox mode and the resolved policy', () => {
  it('reports the divergence the shipped config produces', () => {
    // Sandbox OFF → the host writes `danger-full-access`; the binary, with our
    // own `default_permissions` profile in the same file, resolves
    // `workspaceWrite`. This is the live reading W2-p7 could not explain.
    const { debug, notices, note } = codexAgent(false);
    note({ type: 'workspaceWrite' });
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('danger-full-access');
    expect(notices[0]).toContain('workspaceWrite');
    // Nothing may be reported ONLY on the debug channel: `debug()` routes
    // through electron-log, whose transports a packaged main process disables,
    // which is the reason this notice exists at all. The one debug line a
    // divergence may produce is the queue's own deferral trace — asserted by
    // its prefix rather than allowed as "any debug line", so a future edit that
    // downgraded the notice to a debug line would still redden this.
    expect(debug.every(line => line.startsWith('Codex warning held for the next turn:'))).toBe(true);
  });

  it('names the RESOLVED policy as the one in force, not just both values', () => {
    const { notices, note } = codexAgent(false);
    note({ type: 'workspaceWrite' });
    expect(notices[0]).toContain('the resolved policy is the one being enforced');
    expect(notices[0]).toContain('supersedes');
  });

  it('CONTROL: stays quiet, on the debug channel only, when they agree', () => {
    // Sandbox ON + `default` → the host writes `workspace-write`, and the
    // profile it emits extends `:workspace`, so the two agree. Six of our seven
    // modes are this arm; without it a reader that warned unconditionally would
    // pass every assertion above.
    const { debug, notices, note } = codexAgent(true);
    note({ type: 'workspaceWrite' });
    expect(notices).toEqual([]);
    expect(debug.length).toBe(1);
    expect(debug[0]).toContain('which is what the "workspace-write" mode this host wrote asks for');
  });

  it('CONTROL: the read-only modes agree too, so the divergence is exactly one mode', () => {
    const { debug, notices, note } = codexAgent(true, 'plan');
    note({ type: 'readOnly' });
    expect(notices).toEqual([]);
    expect(debug[0]).toContain('"read-only"');
  });

  it('DEGRADES rather than refusing when the field is absent', () => {
    const { debug, notices, note } = codexAgent(false);
    note(undefined);
    expect(notices).toEqual([]);
    expect(debug.length).toBe(1);
    expect(debug[0]).toContain('starts unverified');
  });

  it('DEGRADES on a shape it does not recognise, without throwing', () => {
    const { notices, note } = codexAgent(false);
    expect(() => note({} as { type?: string })).not.toThrow();
    expect(notices).toEqual([]);
  });

  it('is WIRED: `thread/start` hands its resolved policy to the reader', () => {
    // Every assertion above drives the reader directly, so all of them survive
    // the one mutation that matters most — deleting the CALL. There is nothing
    // at runtime to notice a reader nobody calls, which is the same argument
    // `managed-update-registration.test.ts` makes for reading the source, so
    // this reads the source.
    const source = readFileSync(
      join(import.meta.dir, '..', 'codex-agent.ts'),
      'utf8',
    );
    const start = source.indexOf(`client.request('thread/start'`);
    expect(start).toBeGreaterThan(0);
    // D1.111 — an END ANCHOR, not 1 200 characters, and NOT `bracedRegion`:
    // this anchor sits mid-STATEMENT, and the first `{` after it belongs to a
    // template literal two lines down, so a brace scan would return a region of
    // eleven characters that silently satisfies nothing. `source-regions.ts`'s
    // own header says the same thing about a corpus whose braces do not bound
    // the region you mean — bound it with an anchor read out of the source.
    const end = source.indexOf('const threadId = threadResult.thread?.id', start);
    expect(end).toBeGreaterThan(start);
    const window = source.slice(start, end);
    // BOUNDARY CONTROL. With an explicit end anchor the bound is exact, so the
    // failure mode is not a runaway scan but a RENAMED end anchor: `indexOf`
    // would then find its next occurrence far below and the region would
    // swallow whole methods. No method declaration belongs in the open-thread
    // walk, so this fires on exactly that.
    expect(window).not.toContain('private ');
    expect(window).toContain('this.noteResolvedSandboxPolicy(threadResult.sandbox)');
    // And the response cast must still carry the field, or the argument is
    // `undefined` forever and every arm degrades silently. `2ea351566` hoisted
    // the inline cast into a NAMED alias declared above the whole open-thread
    // walk, so the declaration no longer falls inside this window: the cast is
    // pinned here, where it is used, and the field is pinned on the alias where
    // it now lives. Together they are the one invariant the inline form pinned
    // in one line — a cast that stopped naming the type, or a type that stopped
    // carrying the field, still fails.
    expect(window).toContain('as OpenThreadResult');
    expect(source).toContain('type OpenThreadResult = { thread?: { id?: string }; sandbox?: { type?: string } };');
  });

  it('treats an UNKNOWN policy name as a divergence rather than as agreement', () => {
    // `externalSandbox` is in codex's own union and no mode of ours asks for it,
    // so it must not fall through to silence.
    const { notices, note } = codexAgent(true);
    note({ type: 'externalSandbox' });
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('externalSandbox');
  });
});

/**
 * F1.734 — the same notice, said in sentence case and once per divergence.
 *
 * The 1.41.0 sitting (SIT-d) read the upper-case line as loud, and `createRuntime`
 * re-reads the resolved policy on every respawn, so an unchanged divergence was
 * restated each time. Driven with a live `turnSink`, because the defer queue
 * already drops an identical PENDING notice and would hide a missing latch.
 */
describe('F1.734 — the divergence notice is sentence case and said once per divergence', () => {
  function sinked(mode: { value: string }) {
    const probe = codexAgent(false);
    const events: { type: string; message?: string }[] = [];
    const inner = probe.agent as unknown as {
      turnSink: { push: (e: { type: string; message?: string }) => void } | null;
      getPermissionMode(): string;
      sandboxGloballyEnabled(): boolean;
    };
    inner.turnSink = { push: e => events.push(e) };
    inner.getPermissionMode = () => mode.value;
    return { ...probe, events, inner };
  }

  it('is written in sentence case', () => {
    const { events, note } = sinked({ value: 'default' });
    note({ type: 'workspaceWrite' });
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toStartWith('Codex is not running under the sandbox mode this app asked for. ');
    expect(events[0]!.message).not.toContain('IS NOT RUNNING');
  });

  it('says an unchanged divergence once, however many respawns re-read it', () => {
    const { events, debug, note } = sinked({ value: 'default' });
    for (let i = 0; i < 4; i += 1) note({ type: 'workspaceWrite' });
    expect(events).toHaveLength(1);
    // The repeats are not dropped: each lands on the debug channel, named.
    expect(debug.filter(line => line.includes('already reported to this session'))).toHaveLength(3);
  });

  it('BOUNDARY: a different divergence is a new fact and is said again', () => {
    const mode = { value: 'default' };
    const { events, inner, note } = sinked(mode);
    note({ type: 'workspaceWrite' });
    // Sandbox on + explore writes `read-only`; a resolved `workspaceWrite` now
    // diverges from a DIFFERENT written mode, so it must not be latched away.
    inner.sandboxGloballyEnabled = () => true;
    mode.value = 'plan';
    note({ type: 'workspaceWrite' });
    expect(events).toHaveLength(2);
    expect(events[1]!.message).toContain('sandbox_mode = "read-only"');
  });
});

/**
 * F1.1124 — with the sandbox switch OFF the host writes `danger-full-access` for every mode, and since
 * F1.787 (owner option B) `plan` and `dontAsk` build `nessy_runtime` on codex's `:read-only` parent, so
 * the resolutions that parent produces are the host's own construction, not codex's precedence
 * overriding it (the final sitting's D-15: contradictory rows in Plan). Both of them are quiet: a bare
 * `readOnly` when no write key lands, and — the real Plan spawn since F1.1003 — a `workspaceWrite`
 * whose only writable roots are this session's own grants (measured on the shipped 0.159.3, 2026-10-10:
 * plans+data keys → `workspaceWrite`, no keys → `readOnly`). The P3.315 `default` arm above keeps its
 * disclosure. Residue, stated: a resolved `dangerFullAccess` here stays quiet on the agreement arm (the
 * bare mode line is honoured; no measurement has codex reporting it with the profile written) — a profile
 * that failed to land would be silent, a hole this row does not close.
 */
describe('F1.1124 — the deliberate `:read-only` parent of plan and dontAsk is not reported as a divergence', () => {
  it('plan, switch off, resolved `readOnly`: quiet, one debug line naming the deliberate parent', () => {
    const { debug, notices, note } = codexAgent(false, 'plan');
    note({ type: 'readOnly' });
    expect(notices).toEqual([]);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain(':read-only');
  });

  it('dontAsk, switch off, resolved `readOnly`: quiet too', () => {
    const { notices, note } = codexAgent(false, 'dontAsk');
    note({ type: 'readOnly' });
    expect(notices).toEqual([]);
  });

  it('BOUNDARY: plan, switch off, resolved `workspaceWrite` is quiet too — the real spawn (F1.1003), its only writable roots are this session\'s own grants', () => {
    const { debug, notices, note } = codexAgent(false, 'plan');
    note({ type: 'workspaceWrite' });
    expect(notices).toEqual([]);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain('only writable roots are the folders this session grants');
  });

  it('BOUNDARY: default, switch off, resolved `readOnly` is still said (only plan and dontAsk carry that parent)', () => {
    const { notices, note } = codexAgent(false, 'default');
    note({ type: 'readOnly' });
    expect(notices).toHaveLength(1);
  });
});
