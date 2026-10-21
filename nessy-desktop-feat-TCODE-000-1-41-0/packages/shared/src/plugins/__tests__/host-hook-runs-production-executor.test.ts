/**
 * D1.354 — the HOST arm of the hook-run history, on the executor production
 * actually uses.
 *
 * P6.828 built `hookRuns` and built it on `AutomationSystem.executeAgentEvent`.
 * D1.351 then measured that method as having NO production caller at all:
 * `buildPinnedAgentAutomationSystem` never passes `nativeSystem`, so
 * `PluginScopedAutomationSystem` is the whole production agent-event path and it
 * dispatches through `executePluginHookAutomations`, which produced no
 * observation of any kind. `base-agent.ts` therefore read `result.hookRuns` and
 * saw `undefined` on every session, on all three runtimes, and fell back to the
 * notice list — which is silent on a clean run by construction. The claude and
 * codex event adapters build their own observations, so the two runtime-NATIVE
 * arms were live and only the host arm was dead.
 *
 * Two halves had to move together and each one alone is invisible:
 *
 * 1. `executePluginHookAutomations` produces the observation at the run site.
 * 2. `mergeExecutionResults` CARRIES it — the production dispatch folds four
 *    tiers through that function, which dropped the field entirely, so a
 *    producer alone would still have published nothing to a session.
 *
 * The first case below is a real TWO-TIER dispatch for that reason: with the
 * merge unfixed it reports one run instead of two, and with the producer
 * unfixed it reports none.
 *
 * The last case drives the REAL `BaseAgent.emitAutomationEvent` over the REAL
 * system, with nothing planted: `host-hook-runs-reader.test.ts` pins the
 * reader's PREFERENCE against a hand-built result, which is exactly the shape
 * that stayed green for the whole time the host arm was dead.
 */
import { describe, expect, it } from 'bun:test';
import { PluginScopedAutomationSystem, type CommandHookRunner } from '../hooks-automation.ts';
import type { AutomationsConfig, HookCommandActionResult } from '../../automations/types.ts';
import { TestAgent, createMockBackendConfig } from '../../agent/__tests__/test-utils.ts';

const WORKSPACE_ROOT = '/tmp/d1354-workspace';

const PRE_TOOL_USE_INPUT = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
} as const;

/** One command hook, named, on `PreToolUse`. */
function commandHookConfig(name: string, command: string, action: Record<string, unknown> = {}): AutomationsConfig {
  return {
    automations: {
      PreToolUse: [{ matcher: '^Bash$', name, actions: [{ type: 'command', command, ...action }] }],
    },
  } as unknown as AutomationsConfig;
}

/**
 * A non-spawning execution authority, keyed by the command string so one runner
 * can answer for both tiers of a dispatch. This is the seam the host really
 * injects in production (`pluginCommandRunner`, from
 * `SessionManager.pluginCommandHookRunner`), not a test-only one.
 */
function runnerFor(results: Record<string, Partial<HookCommandActionResult>>): CommandHookRunner {
  return async (action): Promise<HookCommandActionResult> => ({
    type: 'command',
    command: action.command,
    success: true,
    exitCode: 0,
    signal: null,
    durationMs: 2,
    ...results[action.command],
  } as HookCommandActionResult);
}

function systemWith(
  configs: { user?: AutomationsConfig; plugin: AutomationsConfig },
  runner?: CommandHookRunner,
): PluginScopedAutomationSystem {
  return new PluginScopedAutomationSystem({
    ...(configs.user ? { userGlobalHookConfig: configs.user } : {}),
    pluginHookConfig: configs.plugin,
    workspaceRootPath: WORKSPACE_ROOT,
    ...(runner ? { pluginCommandRunner: runner } : {}),
  });
}

describe('D1.354 · the production executor publishes what its command hooks ran', () => {
  it('records BOTH tiers of one dispatch — the clean run and the failing one', async () => {
    // POSITIVE, and the two-tier shape is the point: `mergeExecutionResults`
    // folds the tiers, so a merge that drops `hookRuns` answers one and a
    // producer that never builds it answers none.
    const system = systemWith(
      {
        user: commandHookConfig('user/audit', 'audit.sh'),
        // `blockOnNonZero: false` is what keeps the failure below a documented
        // NON-blocking one, so the notice is built rather than folded into the
        // block — the arm where the two lists overlap and a run could be
        // counted twice. Measured: with the flag absent the exit-1 run blocks
        // and `buildHookErrorNotice` returns nothing at all.
        plugin: commandHookConfig('acme/guard', 'guard.sh', { blockOnNonZero: false }),
      },
      runnerFor({
        'audit.sh': { success: true, exitCode: 0, stdout: 'all good\n' },
        'guard.sh': { success: false, exitCode: 1, stderr: 'guard refused\n' },
      }),
    );

    const result = await system.executeAgentEvent('PreToolUse', PRE_TOOL_USE_INPUT);

    expect(result.hookRuns).toHaveLength(2);
    const runs = [...(result.hookRuns ?? [])];
    // Read every field into a local BEFORE any shape assertion: `toMatchObject`
    // overwrites the object it is given with the matcher (measured 2026-09-07).
    expect(runs.map(run => run.runtime)).toEqual(['host', 'host']);
    expect(runs.map(run => run.event)).toEqual(['PreToolUse', 'PreToolUse']);
    // Tier order — user first, then plugin — is the order the dispatch runs them
    // in and the order `mergeExecutionResults` concatenates them in.
    expect(runs.map(run => run.name)).toEqual(['user/audit', 'acme/guard']);
    expect(runs.map(run => run.outcome)).toEqual(['success', 'error']);
    expect(runs.map(run => run.exitCode)).toEqual([0, 1]);
    // The half no notice could ever have carried...
    expect(runs[0]!.stdout).toBe('all good\n');
    // ...beside the half it always did, reported exactly ONCE in each list.
    expect(runs[1]!.stderr).toBe('guard refused\n');
    expect(result.hookErrors).toHaveLength(1);
    expect(result.hookErrors![0]!.hookName).toBe('acme/guard');
  });

  it('a timeout is an outcome of its own, and a signal-killed run carries no exit code', async () => {
    // BOUNDARY. `exitCode` is `number | null` on the runner's result and
    // `number | undefined` on the observation: a `null` copied straight across
    // would render as an exit code of nothing at all.
    const system = systemWith(
      { plugin: commandHookConfig('acme/slow', 'slow.sh') },
      runnerFor({
        'slow.sh': {
          success: false,
          exitCode: null,
          signal: 'SIGTERM',
          durationMs: 30_000,
          timedOut: true,
          error: 'Hook command timed out after 30000ms.',
        },
      }),
    );

    const result = await system.executeAgentEvent('PreToolUse', PRE_TOOL_USE_INPUT);

    expect(result.hookRuns).toHaveLength(1);
    const run = result.hookRuns![0]!;
    expect(run.outcome).toBe('timeout');
    expect(run.exitCode).toBeUndefined();
    expect('exitCode' in run).toBe(false);
  });

  it('an event that ran no command hook reports no run list at all', async () => {
    // NEGATIVE. Absent, not empty: "this result reports no runs" and "nothing
    // ran" are different facts, and only the second may be shown as such. The
    // matcher below MATCHES — a result with `matchedCount: 0` would pass this
    // for the wrong reason.
    const system = systemWith({
      plugin: {
        automations: {
          PreToolUse: [{ matcher: '^Bash$', name: 'acme/advice', actions: [{ type: 'decision', additionalContext: 'look here' }] }],
        },
      } as unknown as AutomationsConfig,
    });

    const result = await system.executeAgentEvent('PreToolUse', PRE_TOOL_USE_INPUT);

    expect(result.matchedCount).toBe(1);
    expect(result.hookRuns).toBeUndefined();
  });

  it('a command hook with no execution authority still blocks, and since F1.270 is ONE error row carrying the reason', async () => {
    // This arm used to pin the opposite — "a hook that could not RUN must not
    // appear in the run history". F1.232 reversed that off PreToolUse (the
    // notice is observed as its row) and F1.270 (decided 2026-09-23: record the
    // block as a run row with its reason) reverses it here, because on
    // PreToolUse there is no notice for the reader to fall back to, and `/hooks`
    // showed nothing for a hook that had just stopped a tool. The block and the
    // failure flag are unchanged — the control half of this arm.
    const system = systemWith({ plugin: commandHookConfig('acme/guard', 'guard.sh') });

    const result = await system.executeAgentEvent('PreToolUse', PRE_TOOL_USE_INPUT);

    expect(result.hookRunFailed).toBe(true);
    expect(result.decision?.decision).toBe('block');
    expect(result.decision?.reason).toBe('command-hook-execution-authority-unavailable');
    const runs = result.hookRuns ?? [];
    expect(runs.map(run => ({ runtime: run.runtime, event: run.event, name: run.name, outcome: run.outcome, exitCode: run.exitCode })))
      .toEqual([{ runtime: 'host', event: 'PreToolUse', name: 'acme/guard', outcome: 'error', exitCode: undefined }]);
    expect(runs[0]?.stderr).toContain('command-hook-execution-authority-unavailable');
  });

  it('the run reaches the session store through the real reader', async () => {
    // The END-TO-END arm: the real `BaseAgent.emitAutomationEvent` over the real
    // `PluginScopedAutomationSystem`, nothing planted. Before D1.354 this store
    // was EMPTY here — both hooks exit 0, and the notice list the reader fell
    // back to is silent on a clean run.
    const system = systemWith(
      {
        user: commandHookConfig('user/audit', 'audit.sh'),
        plugin: commandHookConfig('acme/guard', 'guard.sh'),
      },
      runnerFor({
        'audit.sh': { stdout: 'audited\n' },
        'guard.sh': { stdout: 'allowed\n' },
      }),
    );
    const agent = new TestAgent(createMockBackendConfig());
    agent.setAutomationSystem(system);

    await (agent as unknown as {
      emitAutomationEvent(event: string, input: unknown): Promise<unknown>;
    }).emitAutomationEvent('PreToolUse', PRE_TOOL_USE_INPUT);

    const stored = (agent as unknown as {
      hookRuns: { groups(): Array<{ label: string; runs: Array<{ outcome: string }> }> };
    }).hookRuns.groups()
      .map(group => ({ label: group.label, outcomes: group.runs.map(run => run.outcome) }))
      // The store does not promise an order ACROSS hooks; the subject is which
      // runs were recorded, never their order.
      .sort((a, b) => a.label.localeCompare(b.label));

    expect(stored).toEqual([
      { label: 'acme/guard', outcomes: ['success'] },
      { label: 'user/audit', outcomes: ['success'] },
    ]);
  });
});
