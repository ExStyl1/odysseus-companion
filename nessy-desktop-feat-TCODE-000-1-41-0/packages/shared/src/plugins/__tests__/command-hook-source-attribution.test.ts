/**
 * D1.343 `[product]` `[host]` — WHICH configuration declared a command hook, as
 * a RECORD the dispatcher hands the host's execution authority.
 *
 * The host pre-authorises a hook the user wrote in their own settings and keeps
 * the permission card for one a plugin shipped (`SessionManager`'s
 * `pluginCommandHookRunner`, pinned in
 * `packages/server-core/src/sessions/SessionManager.hook-preauthorized-source.test.ts`).
 * That decision is only as good as the attribution, and the attribution exists
 * for exactly one method's lifetime: by the time `mergeAutomationsConfigs` has
 * run, the tiers are one config and provenance is gone — the same reason
 * `HookBindingView.tier` is captured where the resource ref still exists.
 *
 * So what is pinned here is the seam, not the verdict: every tier declares
 * itself, they are FOUR different answers rather than plugin/not-plugin, and an
 * undeclared dispatch stays undeclared instead of defaulting to the user's own.
 * The last of those is the whole fail-closed argument — a future dispatch site
 * that forgets its tier must not silently widen what runs without asking.
 */
import { describe, expect, test } from 'bun:test';

import type { AutomationsConfig, ComponentHookLayer, SdkAutomationInput } from '../../automations/types.ts';
import {
  commandHookPreauthorizedTier,
  executePluginHookAutomations,
  PluginScopedAutomationSystem,
  type CommandHookRunner,
  type CommandHookSource,
} from '../hooks-automation.ts';

function commandTier(command: string): AutomationsConfig {
  return {
    automations: {
      UserPromptSubmit: [{ actions: [{ type: 'command', command, timeoutMs: 1_000 }] }],
    },
  };
}

/** A layer with one always-on matcher, which is all the component tier needs here. */
function componentLayer(config: AutomationsConfig): ComponentHookLayer {
  return {
    matchersFor: () => config,
    onceMatchersFor: () => undefined,
    consumeOnce: () => undefined,
    hasMatchers: () => true,
  };
}

/**
 * Records the attribution and NEVER spawns: the seam under test ends at the
 * runner's arguments, and a real spawn would make this file's verdict depend on
 * the permission gate it is upstream of.
 */
function recordingRunner(): { runner: CommandHookRunner; seen: Array<{ command: string; source: CommandHookSource | undefined }> } {
  const seen: Array<{ command: string; source: CommandHookSource | undefined }> = [];
  const runner: CommandHookRunner = async (action, options) => {
    seen.push({ command: action.command, source: options.hookSource });
    return { type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 0 };
  };
  return { runner, seen };
}

const input = { hook_event_name: 'UserPromptSubmit', prompt: 'hello' } as SdkAutomationInput;

describe('D1.343 — the declaring tier reaches the command runner', () => {
  test('each of the five tiers declares itself, and they are five answers rather than plugin/not-plugin', async () => {
    const { runner, seen } = recordingRunner();
    const system = new PluginScopedAutomationSystem({
      workspaceRootPath: '/workspace',
      userGlobalHookConfig: commandTier('user-tier'),
      // D1.429 — `workspaceHookConfig` had no production setter when this case
      // was written and fed `buildSdkHooks` alone; it is now set by
      // `buildPinnedAgentAutomationSystem` and dispatched here too.
      workspaceHookConfig: commandTier('workspace-tier'),
      projectHookConfig: commandTier('project-tier'),
      pluginHookConfig: commandTier('plugin-tier'),
      componentHookLayer: () => componentLayer(commandTier('component-tier')),
      pluginCommandRunner: runner,
    });

    await system.executeAgentEvent('UserPromptSubmit', input);

    // Keyed by COMMAND rather than by position: the dispatch order is
    // `executeAgentEventInner`'s business and this case is about the mapping.
    expect(Object.fromEntries(seen.map(entry => [entry.command, entry.source]))).toEqual({
      'user-tier': 'user',
      'workspace-tier': 'workspace',
      'project-tier': 'project',
      'plugin-tier': 'plugin',
      'component-tier': 'component',
    });
    // The control for the sharp half: `project` is its own answer. A seam that
    // had reused the existing `pluginRuntime` bit would have answered `user`
    // here — a repository's own settings file read as the operator's. D1.429
    // adds the same control for `workspace`, which really did answer `user`.
    expect(new Set(seen.map(entry => entry.source)).size).toBe(5);
  });

  test('the SDK route declares the same tiers as the direct route, so one hook cannot run unasked on one runtime and ask on another', async () => {
    const { runner, seen } = recordingRunner();
    const system = new PluginScopedAutomationSystem({
      workspaceRootPath: '/workspace',
      userGlobalHookConfig: commandTier('user-tier'),
      workspaceHookConfig: commandTier('workspace-tier'),
      projectHookConfig: commandTier('project-tier'),
      pluginHookConfig: commandTier('plugin-tier'),
      pluginCommandRunner: runner,
    });

    // `buildSdkHooks` is the anthropic backend's dispatch route for every event
    // but `PreToolUse`; it reaches the SAME injected runner, so it owes the same
    // record. Driven through the registered callbacks rather than read as text.
    const sdkHooks = system.buildSdkHooks();
    for (const matcher of sdkHooks.UserPromptSubmit ?? []) {
      for (const callback of matcher.hooks) {
        await callback(input, 'tool-use-d1343', { signal: new AbortController().signal });
      }
    }

    expect(Object.fromEntries(seen.map(entry => [entry.command, entry.source]))).toEqual({
      'user-tier': 'user',
      'workspace-tier': 'workspace',
      'project-tier': 'project',
      'plugin-tier': 'plugin',
    });
  });

  test('an undeclared dispatch stays undeclared — absence is never read as the user tier', async () => {
    const { runner, seen } = recordingRunner();

    // The executor called directly with no `hookSource`, which is what any
    // future dispatch site that forgets to declare one looks like.
    await executePluginHookAutomations(commandTier('undeclared'), 'UserPromptSubmit', input, {
      workspaceRootPath: '/workspace',
      runner,
    });
    // The positive control on the same instrument: the identical call WITH a
    // source records it, so the `undefined` above is a reading and not a runner
    // that ignores the field.
    await executePluginHookAutomations(commandTier('declared'), 'UserPromptSubmit', input, {
      workspaceRootPath: '/workspace',
      runner,
      hookSource: 'user',
    });

    expect(seen).toEqual([
      { command: 'undeclared', source: undefined },
      { command: 'declared', source: 'user' },
    ]);
  });
});

describe('D1.343 — which source may run without a permission card', () => {
  test('the operator\'s own settings run unasked; a trusted project\'s do; nothing else does', () => {
    // `hooks.md#workspace-trust`: trust is checked before a hook from a SETTINGS
    // FILE runs, and past that check the hook simply runs. The user tier needs
    // no trust decision — a workspace-only session has no project folder to
    // trust, so `'none'` is its ordinary state and not a refusal.
    expect(commandHookPreauthorizedTier('user', false)).toBe('user');
    expect(commandHookPreauthorizedTier('user', true)).toBe('user');
    expect(commandHookPreauthorizedTier('project', true)).toBe('project');

    // The boundary the page draws, and the fork's stricter half beside it.
    expect(commandHookPreauthorizedTier('project', false)).toBeUndefined();
    expect(commandHookPreauthorizedTier('plugin', true)).toBeUndefined();
    expect(commandHookPreauthorizedTier('component', true)).toBeUndefined();
    expect(commandHookPreauthorizedTier(undefined, true)).toBeUndefined();

    // D1.429 — `workspace` is on the STRICTER side, and it is the one tier
    // whose name makes it look like the user's own. It is the app's own
    // directory, which the model-invocable `automation_create` writes; project
    // trust cannot admit it either, because trust is a statement about a
    // repository folder and this file is in neither.
    expect(commandHookPreauthorizedTier('workspace', false)).toBeUndefined();
    expect(commandHookPreauthorizedTier('workspace', true)).toBeUndefined();
  });
});
