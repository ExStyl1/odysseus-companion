/**
 * UB12.99 — a command hook held to Claude's contract reads Claude's spelling of
 * the event in `hook_event_name`; every other hook reads this fork's.
 *
 * hooks.md#elicitation-input (curl'd 2026-10-17) shows the Elicitation input
 * with `"hook_event_name": "Elicitation"`. The host fires that event as
 * `McpElicitation` (`BaseAgent.elicitationHookBase`), and the Claude adapter
 * imports a plugin's `Elicitation` hook under that name (`CLAUDE_HOOK_EVENT_MAP`).
 * Before this row the stdin of a Claude plugin's Elicitation hook said
 * `McpElicitation`, so a hook that checked for `Elicitation` never matched.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPluginHookAutomations } from '../../capabilities/runtime-automations.ts';
import type { RuntimeHookRegistration } from '../../capabilities/resolver.ts';
import { CLAUDE_HOOK_EVENT_SPELLINGS, claudeHookEventName, hookCommandStdinPayload } from '../../automations/hook-command.ts';
import type { AgentEvent, AutomationsConfig, HookCommandActionResult, SdkAutomationInput } from '../../automations/types.ts';
import { CLAUDE_ANSWERED_HOOK_EVENT_NAMES, mapExternalHookEventName } from '../format-adapters.ts';
import { executePluginHookAutomations, type CommandHookRunner } from '../hooks-automation.ts';

const pluginRoot = mkdtempSync(join(tmpdir(), 'ub12-99-'));

/** What `BaseAgent.buildElicitationHookInput` hands the executor for a form request. */
const ELICITATION_INPUT: SdkAutomationInput = {
  hook_event_name: 'McpElicitation',
  mcp_server_name: 'linear',
  mode: 'form',
  message: 'Pick a project',
  requested_schema: { type: 'object', properties: { project_key: { type: 'string' } } },
};

/** A Claude plugin's command hook as the resolver registers it: the adapter's event, contract and profile. */
function claudePluginHook(event: string, command: string): RuntimeHookRegistration {
  const pluginInstanceId = `plugin://internal/policy@1.0.0#${'a'.repeat(64)}`;
  return {
    key: 'policy/elicit',
    pluginInstanceId,
    resource: { pluginInstanceId, relativePath: 'hooks/hooks.json', contentHash: 'c'.repeat(64) },
    executableHash: 'e'.repeat(64),
    event,
    type: 'command',
    command,
    exitCodeContract: 'claude-three-way',
    pluginRuntime: { rootPath: pluginRoot, dataPath: join(pluginRoot, '.data'), profile: 'claude-plugin-env-v1' },
  } as RuntimeHookRegistration;
}

function nativeConfig(event: AgentEvent, command: string): AutomationsConfig {
  return { automations: { [event]: [{ id: 'native', actions: [{ type: 'command', command }] }] } } as unknown as AutomationsConfig;
}

/** A hook that declines the request only when its stdin names the event `expected`. */
function declinesOnlyFor(expected: string, hookEventName: string): string {
  const script = `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{`
    + `if(JSON.parse(d).hook_event_name===${JSON.stringify(expected)})`
    + `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:${JSON.stringify(hookEventName)},action:'decline'}}))})`;
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** Records the input each command hook is handed, and answers exit 0 with nothing. */
function recordingRunner(seen: Array<{ command: string; input: SdkAutomationInput; stdin: string }>): CommandHookRunner {
  return async (action, options) => {
    seen.push({
      command: action.command,
      input: options.input,
      // The bytes the host's sandboxed runner writes (`SessionManager` builds its
      // `stdinData` with this same call; its source pin is in server-core).
      stdin: hookCommandStdinPayload(options.event, options.input, options.cwd),
    });
    return { type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 1, stdout: '' } as HookCommandActionResult;
  };
}

describe('UB12.99 — the event name a hook reads', () => {
  it('POSITIVE: a Claude plugin\'s Elicitation hook reads "Elicitation" on stdin, so its branch on that name runs', async () => {
    // The adapter's half, so the registration below is what a real bundle yields.
    expect(mapExternalHookEventName('Elicitation', 'claude').event).toBe('McpElicitation');
    const config = buildPluginHookAutomations([claudePluginHook('McpElicitation', declinesOnlyFor('Elicitation', 'Elicitation'))]);
    expect(config.automations.McpElicitation?.[0]?.actions[0]).toMatchObject({ type: 'command', blockOnNonZero: false });

    const result = await executePluginHookAutomations(config, 'McpElicitation', ELICITATION_INPUT, {
      workspaceRootPath: pluginRoot,
      pluginRuntime: true,
      allowDirectCommandRunner: true,
    });

    expect(result.hookErrors).toBeUndefined();
    expect(result.decision).toEqual({ elicitationAction: 'decline' });
  }, 20_000);

  it('POSITIVE: the host runner is handed Claude\'s spelling with every other field intact', async () => {
    const seen: Array<{ command: string; input: SdkAutomationInput; stdin: string }> = [];
    const config = buildPluginHookAutomations([claudePluginHook('McpElicitation', './elicit.sh')]);

    await executePluginHookAutomations(config, 'McpElicitation', ELICITATION_INPUT, {
      workspaceRootPath: pluginRoot,
      pluginRuntime: true,
      runner: recordingRunner(seen),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.input).toEqual({ ...ELICITATION_INPUT, hook_event_name: 'Elicitation' });
    expect(JSON.parse(seen[0]!.stdin).hook_event_name).toBe('Elicitation');
  });

  it('NEGATIVE: a native automation keeps its stored name, and its own branch on it still runs', async () => {
    const seen: Array<{ command: string; input: SdkAutomationInput; stdin: string }> = [];
    await executePluginHookAutomations(nativeConfig('McpElicitation', './native.sh'), 'McpElicitation', ELICITATION_INPUT, {
      workspaceRootPath: pluginRoot,
      runner: recordingRunner(seen),
    });
    expect(seen.map(entry => JSON.parse(entry.stdin).hook_event_name)).toEqual(['McpElicitation']);

    const result = await executePluginHookAutomations(
      nativeConfig('McpElicitation', declinesOnlyFor('McpElicitation', 'McpElicitation')),
      'McpElicitation',
      ELICITATION_INPUT,
      { workspaceRootPath: pluginRoot, allowDirectCommandRunner: true },
    );
    expect(result.hookErrors).toBeUndefined();
    expect(result.decision).toEqual({ elicitationAction: 'decline' });
  }, 20_000);

  it('BOUNDARY: one dispatch, two contracts — each hook reads its own spelling and the caller\'s input is not changed', async () => {
    const seen: Array<{ command: string; input: SdkAutomationInput; stdin: string }> = [];
    const claude = buildPluginHookAutomations([claudePluginHook('McpElicitation', './claude.sh')]);
    const config = {
      automations: { McpElicitation: [...(claude.automations.McpElicitation ?? []), ...(nativeConfig('McpElicitation', './native.sh').automations.McpElicitation ?? [])] },
    } as AutomationsConfig;
    const input = { ...ELICITATION_INPUT };

    await executePluginHookAutomations(config, 'McpElicitation', input, {
      workspaceRootPath: pluginRoot,
      pluginRuntime: true,
      runner: recordingRunner(seen),
    });

    expect(Object.fromEntries(seen.map(entry => [entry.command, JSON.parse(entry.stdin).hook_event_name])))
      .toEqual({ './claude.sh': 'Elicitation', './native.sh': 'McpElicitation' });
    expect(input.hook_event_name).toBe('McpElicitation');
  });

  it('BOUNDARY: a Claude-contract hook on an event both spell alike reads that name unchanged', async () => {
    const seen: Array<{ command: string; input: SdkAutomationInput; stdin: string }> = [];
    const input: SdkAutomationInput = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
    await executePluginHookAutomations(buildPluginHookAutomations([claudePluginHook('PreToolUse', './guard.sh')]), 'PreToolUse', input, {
      workspaceRootPath: pluginRoot,
      pluginRuntime: true,
      runner: recordingRunner(seen),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.input).toBe(input);
    expect(JSON.parse(seen[0]!.stdin).hook_event_name).toBe('PreToolUse');
  });

  it('the spelling table is the non-identity half of the Claude adapter\'s event map, in both directions', () => {
    const renamed = Object.fromEntries(CLAUDE_ANSWERED_HOOK_EVENT_NAMES.flatMap(name => {
      const ours = mapExternalHookEventName(name, 'claude').event;
      return ours !== undefined && ours !== name ? [[ours, name]] : [];
    }));
    expect(CLAUDE_HOOK_EVENT_SPELLINGS).toEqual(renamed);
    expect(renamed).toEqual({ McpElicitation: 'Elicitation' });
    // Control: a name that is already Claude's, or is spelled alike, is its own.
    expect(['Elicitation', 'ElicitationResult', 'PreToolUse'].map(claudeHookEventName))
      .toEqual(['Elicitation', 'ElicitationResult', 'PreToolUse']);
  });
});
