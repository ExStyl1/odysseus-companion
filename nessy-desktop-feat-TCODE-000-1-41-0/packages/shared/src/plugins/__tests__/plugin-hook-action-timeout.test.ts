/**
 * F1.209 (origin WJ-o P-WJ-o-2) — a plugin agent / mcp_tool / http hook keeps
 * the `timeout` it declares, and the documented default when it declares none.
 *
 * ## What was wrong
 *
 * hooks.md#common-fields, `timeout`: *"Seconds before canceling. Defaults: 600
 * for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`"*,
 * lowered to 30 for `command`/`http`/`mcp_tool` on `UserPromptSubmit`,
 * `PreModelSwitch` and `PostModelSwitch`. `pluginHookAction`
 * (`capabilities/runtime-automations.ts`) resolves exactly that
 * (`resolveImportedHookTimeoutMs`) and then put it on the command and prompt
 * actions only: the agent, mcp_tool and http actions were built without it, the
 * runner requests had no field for it, and the host runners
 * (`SessionManager.plugin{Agent,McpTool,Http}HookRunner`) applied a flat 30 s.
 * So an http hook declaring `timeout: 120` against a policy server answering in
 * 45 s timed out at 30 s, as a non-blocking error.
 *
 * This file pins the shared half on the real builder and the real dispatcher:
 * the action carries the resolved budget, the runner request carries it, and
 * the SDK matcher ceiling (F1.171/F1.188) counts it. The host half — the
 * runner honouring it against a real loopback server — is
 * `server-core/.../SessionManager.plugin-hook-timeout.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { buildPluginHookAutomations } from '../../capabilities/runtime-automations.ts';
import type { RuntimeHookRegistration } from '../../capabilities/resolver.ts';
import type { AutomationAction, AutomationsConfig } from '../../automations/types.ts';
import { executePluginHookAutomations, PluginScopedAutomationSystem } from '../hooks-automation.ts';

function registration(
  event: string,
  type: 'agent' | 'mcp' | 'http',
  timeoutMs?: number,
): RuntimeHookRegistration {
  const pluginInstanceId = `plugin://internal/toolkit@1.0.0#${'a'.repeat(64)}`;
  return {
    key: `toolkit/${type}-hook`,
    pluginInstanceId,
    resource: { pluginInstanceId, relativePath: `hooks/${type}.json`, contentHash: 'c'.repeat(64) },
    executableHash: 'e'.repeat(64),
    event,
    type,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(type === 'agent' ? { agentName: 'reviewer' } : {}),
    ...(type === 'mcp' ? { mcpTool: 'mcp__policy__check' } : {}),
    ...(type === 'http' ? { http: { url: 'https://policy.invalid/hook' } } : {}),
  } as RuntimeHookRegistration;
}

function builtAction(hook: RuntimeHookRegistration): AutomationAction {
  const config = buildPluginHookAutomations([hook]);
  const matcher = Object.values(config.automations)[0]?.[0];
  expect(matcher).toBeDefined();
  return matcher!.actions[0]!;
}

describe('F1.209 — the action keeps its resolved `timeout`', () => {
  it('a declared timeout reaches the agent, mcp_tool and http actions, in ms', () => {
    for (const type of ['agent', 'mcp', 'http'] as const) {
      expect(builtAction(registration('Stop', type, 120_000))).toMatchObject({ timeoutMs: 120_000 });
    }
  });

  it('with none declared, each takes the documented default for its type and event', () => {
    expect(builtAction(registration('Stop', 'agent'))).toMatchObject({ timeoutMs: 60_000 });
    expect(builtAction(registration('Stop', 'mcp'))).toMatchObject({ timeoutMs: 600_000 });
    expect(builtAction(registration('Stop', 'http'))).toMatchObject({ timeoutMs: 600_000 });
    // The event lowering the page documents, for the two it names by type.
    expect(builtAction(registration('UserPromptSubmit', 'http'))).toMatchObject({ timeoutMs: 30_000 });
    expect(builtAction(registration('UserPromptSubmit', 'mcp'))).toMatchObject({ timeoutMs: 30_000 });
  });
});

describe('F1.209 — the dispatcher hands the runner that budget', () => {
  it('each runner request carries the action\'s timeoutMs', async () => {
    const seen: Record<string, number | undefined> = {};
    const hooks = [registration('Stop', 'agent', 45_000), registration('Stop', 'mcp', 90_000), registration('Stop', 'http', 120_000)];
    const result = await executePluginHookAutomations(buildPluginHookAutomations(hooks), 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath: process.cwd(),
      agentRunner: async request => { seen.agent = request.timeoutMs; },
      mcpToolRunner: async request => { seen.mcp = request.timeoutMs; },
      httpRunner: async request => { seen.http = request.timeoutMs; },
    });
    expect(result.matchedCount).toBe(3);
    expect(seen).toEqual({ agent: 45_000, mcp: 90_000, http: 120_000 });
  });

  /**
   * CONTROL — a hand-written action with no `timeoutMs` (an app-event
   * automation, a fixture) reaches its runner without one, so the host keeps
   * its own budget for it rather than being told "zero" or "undefined ms".
   */
  it('an action with no timeoutMs leaves the request without one', async () => {
    const requests: Array<Record<string, unknown>> = [];
    await executePluginHookAutomations({
      automations: { Stop: [{ actions: [{ type: 'plugin-http', http: { url: 'https://policy.invalid/hook' } }] }] },
    }, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath: process.cwd(),
      httpRunner: async request => { requests.push({ ...request }); },
    });
    expect(requests).toHaveLength(1);
    expect('timeoutMs' in requests[0]!).toBe(false);
  });
});

describe('F1.209 — the claude SDK matcher ceiling counts the declared budget', () => {
  function matcherTimeoutSeconds(actions: Record<string, unknown>[]): number | undefined {
    const system = new PluginScopedAutomationSystem({
      workspaceRootPath: '/tmp/f1209',
      pluginHookConfig: { automations: { Stop: [{ id: 'f1209a', actions }] } } as unknown as AutomationsConfig,
    } as never);
    const matchers = system.buildSdkHooks().Stop ?? [];
    expect(matchers).toHaveLength(1);
    return matchers[0]!.timeout;
  }

  it('two 600 s http actions in one matcher lift its timeout past the 600 s floor', () => {
    const http = (timeoutMs: number) => ({ type: 'plugin-http', http: { url: 'https://policy.invalid/hook' }, timeoutMs });
    // Counted at the flat 30 s this matcher said 600 (the floor); counted at
    // what the host will now wait, it is the sum.
    expect(matcherTimeoutSeconds([http(600_000), http(600_000)])).toBe(1_200);
  });

  /** CONTROL — an action that declares nothing keeps the host's own 30 s budget in the sum. */
  it('undeclared agent / mcp / http actions still count at the host budget', () => {
    expect(matcherTimeoutSeconds([
      { type: 'plugin-agent', agentName: 'reviewer' },
      { type: 'plugin-mcp-tool', mcpTool: 'mcp__policy__check' },
      { type: 'plugin-http', http: { url: 'https://policy.invalid/hook' } },
    ])).toBe(600);
  });
});
