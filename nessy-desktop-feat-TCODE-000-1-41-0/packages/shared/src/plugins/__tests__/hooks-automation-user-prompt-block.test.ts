/**
 * F1.864 `[claude]` `[hooks]` — a `UserPromptSubmit` hook's `decision: "block"`
 * reason must reach the user on claude, not "Operation stopped by hook".
 *
 * ## The measured defect (release sitting SIT-x, crit-bb #2 / crit-ee #2)
 *
 * The block itself worked; its reason appeared nowhere, and the child logged
 * `requested preventContinuation`. The SDK callback built by `buildSdkHooks`
 * answered a prompt block with `{ continue: false, decision: 'block', reason }`.
 *
 * ## Why that loses the reason (read in the vendored 2.1.267 binary)
 *
 * The hook-output parser turns `continue: false` into `preventContinuation` and
 * `decision: "block"` into `blockingError` (carrying `reason`). The generic hook
 * executor then yields the `preventContinuation` item BEFORE the `blockingError`
 * one, and the `UserPromptSubmit` consumer returns on the first item it sees:
 * `preventContinuation` with no `stopReason` renders as the bare "Operation
 * stopped by hook". The `UserPromptExpansion` consumer has the same shape.
 * `PostToolBatch`'s consumer keeps reading and takes the first non-empty message
 * of the two, so a block there never lost its reason.
 *
 * ## The contract (hooks.md#userpromptsubmit-decision-control)
 *
 * > `decision`: "`"block"` prevents the prompt from being processed and erases
 * > it from context."
 * > `reason`: "Shown to the user when `decision` is `"block"`."
 *
 * The documented block ends the turn by itself, so the translator sends only
 * that. A hook's OWN `continue: false` is a different, documented request
 * (hooks.md#json-output: "Takes precedence over any event-specific decision
 * fields") and still leaves as `continue: false` with its `stopReason`.
 */
import { describe, expect, it } from 'bun:test';
import type { AutomationsConfig, HookCommandActionResult } from '../../automations/types.ts';
import { buildPluginHookAutomations } from '../../capabilities/runtime-automations.ts';
import type { RuntimeHookRegistration } from '../../capabilities/resolver.ts';
import { PluginScopedAutomationSystem, type CommandHookRunner } from '../hooks-automation.ts';

function commandHook(event: string, command: string): RuntimeHookRegistration {
  const pluginInstanceId = `plugin://internal/toolkit@1.0.0#${'a'.repeat(64)}`;
  return {
    key: 'toolkit/prompt-gate',
    pluginInstanceId,
    resource: { pluginInstanceId, relativePath: 'hooks/prompt-gate.json', contentHash: 'c'.repeat(64) },
    executableHash: 'e'.repeat(64),
    event,
    type: 'command',
    command,
  };
}

/**
 * The host's own runner seam: the hook "ran" and printed `stdout`. Spawning a
 * real interpreter from this checkout costs ~4.6 s of preload per hook, which
 * is the whole default test budget; the translator under test never sees the
 * difference.
 */
function runnerPrinting(stdout: string): CommandHookRunner {
  return async (action): Promise<HookCommandActionResult> => ({
    type: 'command',
    command: action.command,
    success: true,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout,
  } as HookCommandActionResult);
}

/** The one SDK callback `buildSdkHooks` registers for a single command hook. */
function sdkCallback(event: string, stdout: string) {
  const config: AutomationsConfig = buildPluginHookAutomations([commandHook(event, 'prompt-gate.sh')]);
  const scoped = new PluginScopedAutomationSystem({
    pluginHookConfig: config,
    workspaceRootPath: '/tmp/f1864-workspace',
    pluginCommandRunner: runnerPrinting(stdout),
  });
  const matchers = scoped.buildSdkHooks()[event as keyof ReturnType<typeof scoped.buildSdkHooks>] ?? [];
  expect(matchers).toHaveLength(1);
  return (input: Record<string, unknown>) => matchers[0]!.hooks[0]!(
    { hook_event_name: event, session_id: 's-1', ...input } as never,
    'hook-1',
    {},
  ) as Promise<Record<string, unknown>>;
}

const printJson = (value: Record<string, unknown>) => JSON.stringify(value);

describe('F1.864 — a prompt block reaches the SDK in its documented shape', () => {
  it('a UserPromptSubmit block leaves as decision/reason, without the continue:false that hid the reason', async () => {
    const call = sdkCallback('UserPromptSubmit', printJson({ decision: 'block', reason: 'no deploys on Friday' }));
    const output = await call({ prompt: 'deploy to prod' });
    expect(output).toEqual({ continue: true, decision: 'block', reason: 'no deploys on Friday' });
  });

  it('a UserPromptExpansion block leaves the same way (same SDK consumer shape)', async () => {
    const call = sdkCallback('UserPromptExpansion', printJson({ decision: 'block', reason: 'not directly invocable' }));
    const output = await call({ expansion_type: 'slash_command', command_name: 'deploy', command_args: '', prompt: '/deploy' });
    expect(output).toEqual({ continue: true, decision: 'block', reason: 'not directly invocable' });
  });

  it("boundary: the hook's own continue:false still stops, with its stopReason", async () => {
    const call = sdkCallback('UserPromptSubmit', printJson({ continue: false, stopReason: 'maintenance window' }));
    const output = await call({ prompt: 'hi' });
    const cont = output.continue;
    const stopReason = output.stopReason;
    expect(cont).toBe(false);
    expect(stopReason).toBe('maintenance window');
  });

  it('boundary: a PostToolBatch block keeps ending the turn through continue:false (its consumer reads both)', async () => {
    const call = sdkCallback('PostToolBatch', printJson({ decision: 'block', reason: 'batch rejected' }));
    const output = await call({ tool_calls: [] });
    expect(output).toEqual({ continue: false, decision: 'block', reason: 'batch rejected' });
  });

  it('control: a non-blocking UserPromptSubmit hook returns nothing new', async () => {
    const call = sdkCallback('UserPromptSubmit', '');
    const output = await call({ prompt: 'hi' });
    expect(output).toEqual({ continue: true });
  });
});
