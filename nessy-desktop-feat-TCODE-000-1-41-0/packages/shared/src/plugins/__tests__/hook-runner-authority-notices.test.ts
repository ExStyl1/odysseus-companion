/**
 * P6.12 — "four of the five hook handler kinds are wired for Pi alone."
 *
 * Measured at the injection site: `SessionManager.buildAgentAutomationSystem`
 * passes `pluginAgentHookRunner` / `pluginMcpToolHookRunner` /
 * `pluginHttpHookRunner` / `pluginPromptHookRunner` inside a
 * `provider === 'pi'` ternary, and every other runtime takes the
 * `{ allowDirectCommandRunner: true }` arm. Before this suite an absent runner
 * was SILENTLY ZERO RUNS: `executePluginHookAutomations` built an empty run
 * list and the matched hook left no trace on any surface.
 *
 * The fifth kind already had the honest shape two branches down — a missing
 * command runner pushes `command-hook-execution-authority-unavailable` onto
 * `hookErrors`, which `SessionManager.reportHookErrors` turns into a transcript
 * warning plus a debug line, and which `sdkUniversalHookOutput` carries as
 * `systemMessage` on claude-runtime. These pins hold the other four to it.
 *
 * The invariant, per kind: one positive (runner present → it runs, no notice)
 * and one negative (runner absent → exactly one notice naming the hook and the
 * event, and nothing executed).
 */
import { describe, expect, it } from 'bun:test';
import { executePluginHookAutomations } from '../hooks-automation.ts';
import type { AutomationsConfig } from '../../automations/types.ts';

const workspaceRootPath = process.cwd();

/** Fresh objects per call: the notice is deduped per ACTION identity. */
function configWith(event: string, actions: readonly unknown[]): AutomationsConfig {
  return {
    automations: {
      [event]: [{ id: 'toolkit/guard', name: 'toolkit/guard', actions: structuredClone(actions) }],
    },
  } as unknown as AutomationsConfig;
}

describe('non-command hook runners report when they are absent', () => {
  it('an agent hook with no runner is reported, not silently skipped', async () => {
    const config = configWith('Stop', [{ type: 'plugin-agent', agentName: 'reviewer' }]);

    const result = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath,
    });

    expect(result.matchedCount).toBe(1);
    expect(result.hookErrors).toHaveLength(1);
    expect(result.hookErrors?.[0]).toMatchObject({
      hookName: 'toolkit/guard',
      event: 'Stop',
      exitCode: null,
    });
    expect(result.hookErrors?.[0]?.summary).toContain('agent hook did not run');
  });

  it('an agent hook WITH a runner runs and reports nothing', async () => {
    const spawned: string[] = [];
    const config = configWith('Stop', [{ type: 'plugin-agent', agentName: 'reviewer' }]);

    const result = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath,
      agentRunner: async request => { spawned.push(request.agentName); },
    });

    expect(spawned).toEqual(['reviewer']);
    expect(result.hookErrors).toBeUndefined();
  });

  it('an mcp_tool hook with no runner is reported, not silently skipped', async () => {
    const config = configWith('Stop', [{ type: 'plugin-mcp-tool', mcpTool: 'mcp__policy__check' }]);

    const result = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath,
    });

    expect(result.hookErrors).toHaveLength(1);
    expect(result.hookErrors?.[0]?.summary).toContain('mcp_tool hook did not run');
  });

  it('an mcp_tool hook WITH a runner runs and reports nothing', async () => {
    const invoked: string[] = [];
    const config = configWith('Stop', [{ type: 'plugin-mcp-tool', mcpTool: 'mcp__policy__check' }]);

    const result = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath,
      mcpToolRunner: async request => { invoked.push(request.proxyName); return undefined; },
    });

    expect(invoked).toEqual(['mcp__policy__check']);
    expect(result.hookErrors).toBeUndefined();
  });

  it('an http hook with no runner is reported, not silently skipped', async () => {
    const config = configWith('Stop', [{ type: 'plugin-http', http: { url: 'https://example.invalid/hook' } }]);

    const result = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath,
    });

    expect(result.hookErrors).toHaveLength(1);
    expect(result.hookErrors?.[0]?.summary).toContain('http hook did not run');
    expect(result.hookErrors?.[0]?.detail).toContain('the request was never sent');
  });

  it('an http hook WITH a runner fires and reports nothing', async () => {
    const urls: string[] = [];
    const config = configWith('Stop', [{ type: 'plugin-http', http: { url: 'https://example.invalid/hook' } }]);

    const result = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath,
      httpRunner: async request => { urls.push(request.http.url); return undefined; },
    });

    expect(urls).toEqual(['https://example.invalid/hook']);
    expect(result.hookErrors).toBeUndefined();
  });

  it('a prompt hook with no judge is reported as degraded, and still injects its context', async () => {
    // The prompt kind is the one that does NOT become zero runs: without a
    // runner it falls back to the documented observational injection. The
    // divergence is that it can no longer BLOCK, which is what the notice says.
    const config = configWith('PreToolUse', [{ type: 'plugin-prompt', prompt: 'is this safe?' }]);

    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
    }, { workspaceRootPath });

    expect(result.hookErrors).toHaveLength(1);
    expect(result.hookErrors?.[0]?.summary).toContain('cannot block here');
    expect(result.decision?.additionalContext).toContain('is this safe?');
  });

  it('a prompt hook on PermissionRequest is NOT reported: discarding its output is the documented behaviour', async () => {
    // hooks.md scopes the discard to this event, so the fallback there is the
    // contract rather than a degradation. Reporting it would cry wolf.
    const config = configWith('PermissionRequest', [{ type: 'plugin-prompt', prompt: 'is this safe?' }]);

    const result = await executePluginHookAutomations(config, 'PermissionRequest', {
      hook_event_name: 'PermissionRequest', tool_name: 'Bash',
    }, { workspaceRootPath });

    expect(result.hookErrors).toBeUndefined();
  });

  it('a prompt hook WITH a judge blocks and reports nothing', async () => {
    const config = configWith('PreToolUse', [{ type: 'plugin-prompt', prompt: 'is this safe?' }]);

    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
    }, {
      workspaceRootPath,
      promptRunner: async () => ({ ok: false, reason: 'the judge said no' }),
    });

    expect(result.decision?.decision).toBe('block');
    expect(result.hookErrors).toBeUndefined();
  });

  it('the notice fires once per action, not once per dispatch', async () => {
    // A PreToolUse hook fires on every tool call; one warning per call would be
    // noise. Same dedupe shape `reportUnparseableIfRule` uses for its matcher.
    const config = configWith('PreToolUse', [{ type: 'plugin-http', http: { url: 'https://example.invalid/hook' } }]);
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash' };

    const first = await executePluginHookAutomations(config, 'PreToolUse', input, { workspaceRootPath });
    const second = await executePluginHookAutomations(config, 'PreToolUse', input, { workspaceRootPath });

    expect(first.hookErrors).toHaveLength(1);
    expect(second.hookErrors).toBeUndefined();
  });

  it('the fifth kind is unchanged: a missing command runner still reports its own notice', async () => {
    // The positive control for the whole suite — the shape the four above were
    // held to already existed here, and must not have moved.
    const config = configWith('Stop', [{ type: 'command', command: 'node hook.js' }]);

    const result = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath,
    });

    expect(result.hookErrors?.[0]?.summary).toBe('command-hook-execution-authority-unavailable');
  });
});
