/**
 * D1.354 — the SETTINGS tier's command-hook dispatch, on the executor that
 * really runs it.
 *
 * These cases were written against `AutomationSystem.executeAgentEvent`'s
 * `commandHookRunner`, on the premise that it is the seam the host injects in
 * production. D1.351 measured that premise false: `buildPinnedAgentAutomationSystem`
 * never passes `nativeSystem`, so that method has no production caller at all,
 * and a workspace `hooks.json` or `config.json` hooks block reaches a session
 * through `runtime-automations.ts` — which files a NATIVE resource into
 * `userGlobalHookConfig` (or `projectHookConfig` for a project-scoped one) and
 * dispatches it through `executePluginHookAutomations` with its `hookSource`.
 * So this file is not a convenience home; it is where the settings tier runs.
 *
 * `options.runner` is the production executor's own non-spawning execution
 * authority — the seam `SessionManager.pluginCommandHookRunner` fills — so every
 * observation the original cases asserted moves across unchanged, with no
 * wall-clock assumption anywhere.
 *
 * The three P6.828 cases of the same move (a clean run recorded, a failing run
 * recorded exactly once, an event that ran no command hook reporting no list)
 * live in `host-hook-runs-production-executor.test.ts`, beside the two-tier
 * merge arm they need and the end-to-end reader arm they could not have.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePluginHookAutomations, type CommandHookRunner } from '../hooks-automation.ts';
import type { AutomationsConfig, HookCommandActionResult } from '../../automations/types.ts';
import { parseHooksConfigContent } from '../../automations/hooks-config.ts';

const WORKSPACE_ROOT = '/tmp/d1354-settings-tier';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'd1354-settings-tier-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const PRE_TOOL_USE_INPUT = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
} as const;

/**
 * The tier's own options: a settings-file hook declares itself `user`, which is
 * what `PluginScopedAutomationSystem` passes for `userGlobalHookConfig`.
 */
function userTierOptions(runner: CommandHookRunner) {
  return { workspaceRootPath: WORKSPACE_ROOT, runner, hookSource: 'user' as const };
}

function commandHookConfig(name: string, command: string, action: Record<string, unknown> = {}): AutomationsConfig {
  return {
    automations: {
      PreToolUse: [{ matcher: '^Bash$', name, actions: [{ type: 'command', command, ...action }] }],
    },
  } as unknown as AutomationsConfig;
}

/**
 * C3.334 — the SETTINGS tier's background branch.
 *
 * This tier carries the workspace `config.json` hooks block and `hooks.json`,
 * which is the file `hooks.md#configure-an-async-hook` puts its own
 * `async: true` example in.
 *
 * `hooks.md#run-hooks-in-the-background`, verbatim: *"Async hooks can't block
 * or control Claude's behavior: response fields like `decision`,
 * `permissionDecision`, and `continue` have no effect"*.
 */
describe('C3.334 · a settings-tier background hook does not block the event', () => {
  const blockingResult: HookCommandActionResult = {
    type: 'command',
    command: 'deploy.sh',
    success: false,
    exitCode: 2,
    signal: null,
    durationMs: 1,
  } as HookCommandActionResult;

  it('runs an `async` hook in the background instead of awaiting it', async () => {
    const state: { started: number; release?: () => void } = { started: 0 };
    // Never settles while the event is dispatched, so an executor that awaited
    // this could not return at all — the assertion cannot pass by luck of
    // timing, and no wall clock is consulted.
    const runner: CommandHookRunner = async () => {
      state.started += 1;
      await new Promise<void>(resolve => { state.release = resolve; });
      return blockingResult;
    };

    const result = await executePluginHookAutomations(
      commandHookConfig('deploy', 'deploy.sh', { async: true }),
      'PreToolUse',
      PRE_TOOL_USE_INPUT,
      userTierOptions(runner),
    );

    // It RAN — "did not block" would be satisfied vacuously by a hook that
    // never started.
    expect(state.started).toBe(1);
    expect(result.matchedCount).toBe(1);
    // ...and nothing was read back from it: no decision, no notice, no run.
    expect(result.decision).toBeUndefined();
    expect(result.hookErrors).toBeUndefined();
    expect(result.hookRuns).toBeUndefined();
    state.release?.();
  });

  it('the SAME hook without `async` blocks on the same exit code (the control)', async () => {
    const runner: CommandHookRunner = async () => blockingResult;

    const result = await executePluginHookAutomations(
      commandHookConfig('deploy', 'deploy.sh'),
      'PreToolUse',
      PRE_TOOL_USE_INPUT,
      userTierOptions(runner),
    );

    expect(result.decision?.decision).toBe('block');
    expect(result.hookRuns).toHaveLength(1);
  });
});

/**
 * C3.350 — the same sentence, through a REAL dispatch. `hook-command.test.ts`
 * proves the reason composes; only a dispatch can prove anything hands it the
 * matcher's name, which is the whole of the wiring.
 */
describe('C3.350 · the block a user meets names the hook that stalled', () => {
  it('carries the hook name, the event and the budget into the reason', async () => {
    const runner: CommandHookRunner = async () => ({
      type: 'command',
      command: 'slow.sh',
      success: false,
      exitCode: null,
      signal: 'SIGTERM',
      durationMs: 30_000,
      timedOut: true,
      error: 'Hook command timed out after 30000ms.',
    } as HookCommandActionResult);

    const result = await executePluginHookAutomations(
      commandHookConfig('acme/guard', 'slow.sh'),
      'PreToolUse',
      PRE_TOOL_USE_INPUT,
      userTierOptions(runner),
    );

    const reason = result.decision?.reason ?? '';
    expect(result.decision?.decision).toBe('block');
    expect(reason).toContain('"acme/guard"');
    expect(reason).toContain('PreToolUse');
    expect(reason).toContain('timed out after 30000ms');
    expect(reason).toContain('`timeout`');
  });
});

/**
 * The three real-SPAWN cases, re-homed from the same class for the same reason.
 *
 * `allowDirectCommandRunner` is the production executor's explicit legacy
 * opt-in, and `buildPinnedAgentAutomationSystem` really passes it for the
 * non-Pi providers — so unlike the authority these cases used to drive, this
 * one is reachable from a shipped session. They spawn real processes, which is
 * the point: the env the hook sees, the redaction of what it prints, and the
 * stdout contract are all things an injected stub would assert about itself.
 */
describe('D1.354 · the settings tier under the direct-spawn authority', () => {
  const directSpawn = () => ({ workspaceRootPath: tempDir, allowDirectCommandRunner: true, hookSource: 'user' as const });

  it('runs command hooks for matching agent events, with the documented env', async () => {
    const markerPath = join(tempDir, 'hook-fired.txt');
    const config = {
      automations: {
        UserPromptSubmit: [{
          actions: [{ type: 'command', command: `printf "$NESSY_PROMPT" > ${JSON.stringify(markerPath)}` }],
        }],
      },
    } as unknown as AutomationsConfig;

    const result = await executePluginHookAutomations(config, 'UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello hook',
    }, directSpawn());

    expect(result.matchedCount).toBe(1);
    expect(readFileSync(markerPath, 'utf-8')).toBe('hello hook');
  }, 15_000);

  it('returns a PreToolUse block decision when a command hook exits non-zero, redacted', async () => {
    const config = {
      automations: {
        PreToolUse: [{
          matcher: '^Bash$',
          actions: [{ type: 'command', command: 'printf "token=super-secret\\n" >&2; exit 42' }],
        }],
      },
    } as unknown as AutomationsConfig;

    const result = await executePluginHookAutomations(config, 'PreToolUse', PRE_TOOL_USE_INPUT, directSpawn());

    expect(result.decision).toEqual({
      decision: 'block',
      reason: 'token=[REDACTED]\n',
    });
  }, 15_000);

  it('accepts JSON PreToolUse decisions from command stdout', async () => {
    const config = {
      automations: {
        PreToolUse: [{
          matcher: '^Bash$',
          actions: [{
            type: 'command',
            command: 'printf %s \'{"decision":"allow","updatedInput":{"command":"echo rewritten"}}\'',
          }],
        }],
      },
    } as unknown as AutomationsConfig;

    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo original' },
    }, directSpawn());

    expect(result.decision).toEqual({
      decision: 'allow',
      updatedInput: { command: 'echo rewritten' },
    });
  }, 15_000);
});

/**
 * F1.1176 — a hooks document in CLAUDE'S settings shape (F1.898 made it load)
 * keeps Claude's exit-code contract, on the executor the settings tier runs on.
 *
 * `hooks.md#other-exit-codes`: "For most hook events, exit code 2 is the only exit
 * code that blocks through the code alone. Without valid JSON on stdout, Claude
 * Code treats exit code 1 as a non-blocking error and proceeds with the
 * action". The contract belongs to the format the hook was authored in — the
 * plugin tier's rule (`pluginHookAction`, `exitCodeContract`) — so the same
 * `exit 1` in our own `actions` shape still blocks.
 */
describe('F1.1176 · a Claude-shape hooks.json keeps Claude\'s exit-code contract', () => {
  const exited = (exitCode: number): HookCommandActionResult => ({
    type: 'command', command: './lint-check.sh', success: false, exitCode, signal: null, durationMs: 1,
    stderr: 'lint failed', output: 'lint failed',
  });
  const claudeShape = (event: string, handler: Record<string, unknown> = { type: 'command', command: './lint-check.sh' }) =>
    parseHooksConfigContent(JSON.stringify({ hooks: { [event]: [{ hooks: [handler] }] } }), 'hooks.json');
  const dispatch = async (config: AutomationsConfig, event: 'Stop' | 'PreToolUse', exitCode: number) =>
    executePluginHookAutomations(
      config,
      event,
      event === 'Stop' ? { hook_event_name: 'Stop' } : PRE_TOOL_USE_INPUT,
      userTierOptions(async () => exited(exitCode)),
    );

  it('exit 1 is a non-blocking error the user is told about, and exit 2 blocks with stderr, on Stop and PreToolUse', async () => {
    for (const event of ['Stop', 'PreToolUse'] as const) {
      const loaded = claudeShape(event);
      expect(loaded.errors).toEqual([]);
      const nonBlocking = await dispatch(loaded.config, event, 1);
      expect(nonBlocking.matchedCount).toBe(1);
      expect(nonBlocking.decision).toBeUndefined();
      expect(nonBlocking.hookErrors?.length).toBe(1);
      const blocking = await dispatch(loaded.config, event, 2);
      expect(blocking.decision?.decision).toBe('block');
      expect(blocking.decision?.reason).toBe('lint failed');
    }
  });

  it('BOUNDARY — our own `actions` shape, a handler that spells `blockOnNonZero`, and WorktreeCreate keep any-non-zero-blocks', async () => {
    const native = parseHooksConfigContent(JSON.stringify({
      hooks: { Stop: [{ actions: [{ type: 'command', command: './lint-check.sh' }] }] },
    }), 'hooks.json');
    expect((await dispatch(native.config, 'Stop', 1)).decision?.decision).toBe('block');
    const spelled = claudeShape('PreToolUse', { type: 'command', command: './lint-check.sh', blockOnNonZero: true });
    expect((await dispatch(spelled.config, 'PreToolUse', 1)).decision?.decision).toBe('block');
    // hooks.md, the same note: "any non-zero exit code from `WorktreeCreate` aborts worktree creation".
    const worktree = claudeShape('WorktreeCreate').config.automations.WorktreeCreate?.[0]?.actions[0];
    expect(worktree).toEqual({ type: 'command', command: './lint-check.sh' });
  });
});

/**
 * F1.1177 — a Claude-shape handler's exec-form `args` survives the document
 * schema and is spawned as an argument vector, REAL spawn under the direct
 * authority. `hooks.md#command-hook-fields`, `args`: "When present, `command`
 * is resolved as an executable and spawned directly with `args` as the argument
 * vector, with no shell involved." Before, the schema stripped `args` and the
 * hook ran `sh -c /bin/sh` with the hook JSON on its stdin.
 */
describe('F1.1177 · a Claude-shape exec-form hook keeps its `args`', () => {
  it('spawns `command` with `args` as its argument vector, one element with a space staying one argument', async () => {
    const script = join(tempDir, 'guard.sh');
    const marker = join(tempDir, 'guard ran.txt');
    writeFileSync(script, 'printf "%s" "$1" > "$1"\n');
    const loaded = parseHooksConfigContent(JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/bin/sh', args: [script, marker] }] }] },
    }), 'hooks.json');
    expect(loaded.errors).toEqual([]);

    const result = await executePluginHookAutomations(loaded.config, 'PreToolUse', PRE_TOOL_USE_INPUT, {
      workspaceRootPath: tempDir, allowDirectCommandRunner: true, hookSource: 'user' as const,
    });

    expect(result.matchedCount).toBe(1);
    expect(readFileSync(marker, 'utf-8')).toBe(marker);
    expect(result.decision).toBeUndefined();
    expect(result.hookErrors).toBeUndefined();
  }, 15_000);
});
