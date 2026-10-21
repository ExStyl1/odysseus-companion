import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import type { AgentAutomationSystem, AutomationMatcher, AutomationsConfig } from '../../automations/types.ts';
import { AutomationSystem } from '../../automations/automation-system.ts';
import {
  PluginScopedAutomationSystem,
  executePluginHookAutomations,
} from '../hooks-automation.ts';
import { buildPluginHookAutomations } from '../../capabilities/runtime-automations.ts';
import type { RuntimeHookRegistration } from '../../capabilities/resolver.ts';
import type { PluginRuntimeCompatibilityProfile } from '../types.ts';

describe('plugin hook automation bridge', () => {
  // Three rows retired with the V1 registration bridge (F4): "skips untrusted
  // hooks with diagnostics and trust requirements", "requires new trust when the
  // command hash changes" and "re-prompts for trust when only the exec-form
  // argument vector changes". All three asserted `buildTrustedPluginHookAutomations`'s
  // own trust gate and its `pluginHookExecutableHash`. Neither exists on the one
  // remaining path: a hook registration only reaches
  // `buildPluginHookAutomations` after the RESOLVER has granted trust, and the
  // hash it is granted against is host-derived in `projection-candidates.ts`
  // (`hostDerivedPluginTrust` over the bundle hash plus the whole capability
  // definition, `args` included), so re-authoring a hook still re-prompts. The
  // gate itself is covered by the resolver and trust-store suites.

  it('registers hooks for user, tool, session, and subagent events', () => {
    const hooks = [
      hook({ hookId: 'prompt', event: 'UserPromptSubmit', command: nodeCommand('process.exit(0)') }),
      hook({ hookId: 'pretool', event: 'PreToolUse', command: nodeCommand('process.exit(0)'), cwd: '/workspace/project' }),
      hook({ hookId: 'posttool', event: 'PostToolUse', command: nodeCommand('process.exit(0)') }),
      hook({ hookId: 'subagent', event: 'SubagentStart', matcher: 'hive-reviewer', command: nodeCommand('process.exit(0)') }),
      hook({ hookId: 'session-end', event: 'SessionEnd', command: nodeCommand('process.exit(0)') }),
    ];

    const result = automationsFor(hooks);

    expect(Object.keys(result.automations).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SubagentStart',
      'UserPromptSubmit',
    ]);
    const action = result.automations.PreToolUse?.[0]?.actions[0];
    expect(action).toEqual(expect.objectContaining({ type: 'command', cwd: '/workspace/project' }));
    expect(result.automations.SubagentStart?.[0]?.matcher).toBe('hive-reviewer');
  });

  it('scopes the imported matcher and exit-code semantics to plugin hooks', () => {
    const imported = hook({
      event: 'PreToolUse', matcher: 'Write|Edit', command: 'node hook.js', timeoutMs: 5000,
      exitCodeContract: 'claude-three-way',
    });

    const result = automationsFor([imported]);

    const matcher = result.automations.PreToolUse?.[0];
    // The two-mode matcher and the three-way exit-code contract are opted into
    // per record here, never by changing the native default.
    expect(matcher?.matchMode).toBe('claude');
    expect(matcher?.actions[0]).toMatchObject({ type: 'command', blockOnNonZero: false });
  });

  it('spawns an exec-form hook with its argument vector and no shell', async () => {
    // hooks.md § Exec form and shell form: `args` present means `command` is an
    // executable spawned directly, "each `args` element is one argument exactly
    // as written", and "special characters such as apostrophes, `$`, and
    // backticks pass through verbatim because there is no shell to interpret
    // them". The argument below is exactly the string a shell would mangle.
    // UB12.101 — the documented nested spelling: a Claude-contract hook's
    // top-level `additionalContext` is not applied, as Claude Code ignores it.
    const argv = [
      '-e',
      'process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: process.argv[1]}}))',
      '$HOME `id` \'quoted\'',
    ];
    const execForm = hook({
      event: 'PreToolUse',
      command: process.execPath,
      args: argv,
      exitCodeContract: 'claude-three-way',
    });

    const result = automationsFor([execForm]);
    const action = result.automations.PreToolUse?.[0]?.actions[0] as { type: string; args?: string[] };
    expect(action.type).toBe('command');
    expect(action.args).toEqual(argv);

    const decision = await executePluginHookAutomations(result, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' },
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });
    expect(decision.decision?.additionalContext).toBe('$HOME `id` \'quoted\'');
  }, 15_000);

  it('resolves the documented per-type and per-event timeout for imported hooks', () => {
    // hooks.md § Common fields: "Defaults: 600 for `command`, `http`, and
    // `mcp_tool`; 30 for `prompt`; 60 for `agent`. `UserPromptSubmit` lowers the
    // `command` … default to 30 … `SessionEnd` hooks share a 1.5-second budget",
    // and § SessionEnd: "Timeouts set on plugin-provided hooks don't raise the
    // budget" — so on that event the budget is a ceiling, not just a default.
    const hooks = [
      hook({ hookId: 'default', event: 'PreToolUse', command: 'node a.js' }),
      hook({ hookId: 'declared', event: 'PreToolUse', command: 'node b.js', timeoutMs: 300_000 }),
      hook({ hookId: 'prompt', event: 'PreToolUse', type: 'prompt', prompt: 'ok?' }),
      hook({ hookId: 'submit', event: 'UserPromptSubmit', command: 'node c.js' }),
      hook({ hookId: 'ending', event: 'SessionEnd', command: 'node d.js', timeoutMs: 300_000 }),
    ];

    const result = automationsFor(hooks);
    const timeoutOf = (event: string, hookId: string) => ((Object.values(result.automations).flat() as AutomationMatcher[])
      .find(matcher => matcher?.name === `toolkit/${hookId}`)
      ?.actions[0] as { timeoutMs?: number } | undefined)?.timeoutMs ?? `${event}/${hookId} not registered`;

    expect(timeoutOf('PreToolUse', 'default')).toBe(600_000);
    expect(timeoutOf('PreToolUse', 'declared')).toBe(300_000);
    expect(timeoutOf('PreToolUse', 'prompt')).toBe(30_000);
    expect(timeoutOf('UserPromptSubmit', 'submit')).toBe(30_000);
    expect(timeoutOf('SessionEnd', 'ending')).toBe(1_500);
  });

  it('gives a Codex SessionEnd hook the Codex budget and leaves the Claude one alone', () => {
    // The two platforms document different numbers for the same event, and we
    // applied Claude's to both.
    //   Codex `hooks.md` § Notes, `timeout`: "`SessionEnd` uses `1` second by
    //   default and supports up to `3` seconds."
    //   Claude `hooks.md`: "`SessionEnd` hooks share a 1.5-second budget", and
    //   "Timeouts set on plugin-provided hooks don't raise the budget."
    // A Codex plugin's cleanup hook asking for the 3 s its author was told they
    // had was being killed at 1.5 s.
    const hooks = [
      hook({ pluginId: 'codexkit', hookId: 'codex-declared', event: 'SessionEnd', command: 'node a.js', timeoutMs: 3_000, profile: 'codex-plugin-env-v1' }),
      hook({ pluginId: 'codexkit', hookId: 'codex-over', event: 'SessionEnd', command: 'node b.js', timeoutMs: 300_000, profile: 'codex-plugin-env-v1' }),
      hook({ pluginId: 'codexkit', hookId: 'codex-default', event: 'SessionEnd', command: 'node c.js', profile: 'codex-plugin-env-v1' }),
      hook({ pluginId: 'toolkit', hookId: 'claude-declared', event: 'SessionEnd', command: 'node d.js', timeoutMs: 3_000 }),
      hook({ pluginId: 'codexkit', hookId: 'codex-other-event', event: 'PreToolUse', command: 'node e.js', timeoutMs: 300_000, profile: 'codex-plugin-env-v1' }),
    ];

    const result = automationsFor(hooks);
    const timeoutOf = (pluginId: string, hookId: string) => ((Object.values(result.automations).flat() as AutomationMatcher[])
      .find(matcher => matcher?.name === `${pluginId}/${hookId}`)
      ?.actions[0] as { timeoutMs?: number } | undefined)?.timeoutMs ?? `${pluginId}/${hookId} not registered`;

    expect(timeoutOf('codexkit', 'codex-declared')).toBe(3_000);
    expect(timeoutOf('codexkit', 'codex-over')).toBe(3_000);
    expect(timeoutOf('codexkit', 'codex-default')).toBe(1_000);
    // Claude's budget must not move, and the Codex window is SessionEnd-only.
    expect(timeoutOf('toolkit', 'claude-declared')).toBe(1_500);
    expect(timeoutOf('codexkit', 'codex-other-event')).toBe(300_000);
  });

  it('reports a matched hook status message and clears it when the event ends', async () => {
    // hooks.md § Common fields: "Custom spinner message displayed while the
    // hook runs." It survived projection and died at the resolver, so nothing
    // ever displayed it. The label belongs to a hook that will actually run —
    // a hook filtered out by its matcher must not relabel the spinner.
    const labelled = hook({
      hookId: 'labelled', event: 'PreToolUse', matcher: 'Bash',
      command: nodeCommand('process.exit(0)'), statusMessage: 'Scanning for secrets…',
      exitCodeContract: 'claude-three-way',
    });
    const unmatched = hook({
      hookId: 'unmatched', event: 'PreToolUse', matcher: 'Write',
      command: nodeCommand('process.exit(0)'), statusMessage: 'Formatting…',
      exitCodeContract: 'claude-three-way',
    });

    const result = automationsFor([labelled, unmatched]);
    const reported: Array<string | undefined> = [];
    await executePluginHookAutomations(result, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' },
    }, {
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
      statusReporter: message => reported.push(message),
    });
    expect(reported).toEqual(['Scanning for secrets…']);

    // The clear is the event's, not the action's: `executeAgentEvent` owns it
    // so a hook that blocked or threw still releases the spinner.
    const cleared: Array<string | undefined> = [];
    const system = new PluginScopedAutomationSystem({
      pluginHookConfig: result,
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
      hookStatusReporter: message => cleared.push(message),
    });
    await system.executeAgentEvent('PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' },
    });
    expect(cleared).toEqual(['Scanning for secrets…', undefined]);
  }, 15_000);

  it('leaves a non-Claude command hook on the native any-non-zero exit contract', async () => {
    // Only hooks authored against hooks.md carry `exitCodeContract`. A Codex or
    // native `nessy-plugin.json` command hook has none, so exit 1 must still
    // block the way its author intended — opting EVERY imported hook into
    // Claude's three-way contract is what silently disarmed them.
    const nativeFormat = hook({ event: 'PreToolUse', command: nodeCommand('process.exit(1)') });

    const result = automationsFor([nativeFormat]);

    const action = result.automations.PreToolUse?.[0]?.actions[0];
    expect(action).toMatchObject({ type: 'command' });
    expect((action as { blockOnNonZero?: boolean }).blockOnNonZero).toBeUndefined();

    const decision = await executePluginHookAutomations(result, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' },
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });
    expect(decision.decision?.decision).toBe('block');
  }, 15_000);

  it('registers neither an event outside the agent inventory nor a type outside the five runtimes', () => {
    // `McpToolCall` is a plugin-facing hook event with no agent event behind it;
    // `webhook` is outside the five executable runtimes
    // (command/prompt/agent/mcp/http). Both must produce no matcher at all —
    // registering either would be a hook that can never fire.
    const unsupportedEvent = hook({ event: 'McpToolCall', command: nodeCommand('process.exit(0)') });
    const unsupportedType = hook({ event: 'PreToolUse', type: 'webhook' as RuntimeHookRegistration['type'] });

    const result = automationsFor([unsupportedEvent, unsupportedType]);

    expect(Object.keys(result.automations)).toEqual([]);
  });

  it('registers a matcher-bearing hook on every event that documents one, and on the matcher-less ones too', () => {
    const hooks = [
      // Documented as matcher-less: the field is silently ignored upstream and
      // the hook fires on every occurrence here too.
      hook({ hookId: 'stop', event: 'Stop', matcher: 'whatever', command: nodeCommand('process.exit(0)') }),
      // A matcher on a supported event is silent.
      hook({ hookId: 'denied', event: 'PermissionDenied', matcher: 'Bash', command: nodeCommand('process.exit(0)') }),
      // R73 · the two events that LEFT the inert set once their producers
      // landed. A narrowing matcher on either must now register with NO
      // diagnostic — that absence is the assertion. The third member of that
      // set, `Setup`, left by being removed as an event; a hook on it can no
      // longer reach this builder at all (see the case below).
      hook({ hookId: 'cfg', event: 'ConfigChange', matcher: 'project_settings', command: nodeCommand('process.exit(0)') }),
      hook({ hookId: 'expand', event: 'UserPromptExpansion', matcher: 'deploy', command: nodeCommand('process.exit(0)') }),
    ];

    const result = automationsFor(hooks);

    expect(Object.keys(result.automations).sort())
      .toEqual(['ConfigChange', 'PermissionDenied', 'Stop', 'UserPromptExpansion']);
  });

  it('refuses a Setup hook outright rather than registering one that can never run (R73 · f001)', () => {
    // The adapter defers `Setup` before it gets here, so this is the backstop
    // for a projection that already carries the name — a plugin record stored
    // by an older build, say. It must NOT register: hooks.md#setup fires the
    // event only under `--init-only` / `-p --init` / `-p --maintenance`, and
    // Nessy has no such launch mode. Registering it silently is the exact
    // outcome this finding exists to prevent, so the assertion is that nothing
    // reaches the config.
    const hooks = [
      hook({ hookId: 'setup-init', event: 'Setup', matcher: 'init', command: nodeCommand('process.exit(0)') }),
      hook({ hookId: 'setup-all', event: 'Setup', command: nodeCommand('process.exit(0)') }),
    ];

    const result = automationsFor(hooks);

    expect(Object.keys(result.automations)).toEqual([]);
  });

  // --- B1: prompt and agent hook runtimes -----------------------------------

  it('injects a prompt hook as one-shot observational additionalContext (ordered)', async () => {
    const promptHook = hook({
      hookId: 'brief',
      event: 'UserPromptSubmit',
      type: 'prompt',
      prompt: 'Remember the house style guide before answering.',
    });

    // It fires on the bound event and only produces additionalContext. (The
    // untrusted half of this row went with the V1 registration gate — a hook only
    // reaches this builder after the resolver granted trust.)
    const config = automationsFor([promptHook]);
    const result = await executePluginHookAutomations(config, 'UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    }, { workspaceRootPath: process.cwd() });
    // P6.12 — the injection is unchanged; what is new is that the DEGRADATION is
    // no longer silent. Without a judge this hook cannot block, and the notice
    // says so once per action.
    expect(result).toMatchObject({
      matchedCount: 1,
      decision: { additionalContext: 'Remember the house style guide before answering.' },
    });
    expect(result.hookErrors?.[0]?.summary).toContain('cannot block here');
  });

  it('spawns an agent hook through the injected subagent runner, and stays inert without one', async () => {
    // `SubagentStop` supports all five hook types (hooks.md § Prompt-based
    // hooks); this test used `SubagentStart`, which the support matrix now
    // refuses for agent hooks at registration.
    const agentHook = hook({
      hookId: 'review',
      event: 'SubagentStop',
      type: 'agent',
      agentName: 'hive-reviewer',
    });


    const config = automationsFor([agentHook]);

    // No runner injected: the agent hook matches but produces no spawn and no
    // decision. P6.12 — it is no longer SILENT about it: an absent runner is a
    // per-runtime capability difference, and it now rides `hookErrors`.
    const noRunner = await executePluginHookAutomations(config, 'SubagentStop', {
      hook_event_name: 'SubagentStop',
    }, { workspaceRootPath: process.cwd() });
    expect(noRunner.matchedCount).toBe(1);
    expect(noRunner.decision).toBeUndefined();
    expect(noRunner.hookErrors?.[0]?.summary).toContain('agent hook did not run');

    // Runner injected: it is called exactly once with the declared agent name.
    const spawned: Array<{ agentName: string; event: string }> = [];
    const withRunner = await executePluginHookAutomations(config, 'SubagentStop', {
      hook_event_name: 'SubagentStop',
    }, {
      workspaceRootPath: process.cwd(),
      agentRunner: async (request) => {
        spawned.push({ agentName: request.agentName, event: request.event });
      },
    });
    expect(withRunner).toEqual({ matchedCount: 1, hookRuns: [{ runtime: 'host', event: 'SubagentStop', name: 'toolkit/review', outcome: 'success' }] }); // F1.9: the run is observed
    expect(spawned).toEqual([{ agentName: 'hive-reviewer', event: 'SubagentStop' }]);
  });

  // --- B2: mcp_tool and http hook runtimes ----------------------------------

  it('invokes an mcp_tool hook through the injected MCP pool runner by qualified name, and stays inert without one', async () => {
    const mcpHook = hook({
      hookId: 'lint',
      event: 'PostToolUse',
      type: 'mcp',
      mcpTool: 'mcp__linter__lint_file',
      mcpArgs: { strict: true },
    });


    const config = automationsFor([mcpHook]);

    // No runner: matches but no invocation, no decision — and P6.12's notice.
    const noRunner = await executePluginHookAutomations(config, 'PostToolUse', { hook_event_name: 'PostToolUse' }, { workspaceRootPath: process.cwd() });
    expect(noRunner.matchedCount).toBe(1);
    expect(noRunner.decision).toBeUndefined();
    expect(noRunner.hookErrors?.[0]?.summary).toContain('mcp_tool hook did not run');

    const calls: Array<{ proxyName: string; args: Record<string, unknown> }> = [];
    const withRunner = await executePluginHookAutomations(config, 'PostToolUse', { hook_event_name: 'PostToolUse' }, {
      workspaceRootPath: process.cwd(),
      mcpToolRunner: async (request) => { calls.push({ proxyName: request.proxyName, args: request.args }); },
    });
    expect(withRunner).toEqual({ matchedCount: 1, hookRuns: [{ runtime: 'host', event: 'PostToolUse', name: 'toolkit/lint', outcome: 'success' }] }); // F1.9: the run is observed
    expect(calls).toEqual([{ proxyName: 'mcp__linter__lint_file', args: { strict: true } }]);
  });

  it('fires an http hook only under the network permission contract, and never as a side effect when denied', async () => {
    const httpHook = hook({
      hookId: 'notify',
      event: 'Stop',
      type: 'http',
      http: { url: 'https://example.invalid/webhook', method: 'POST', body: { ok: true } },
    });

    const config = automationsFor([httpHook]);

    // No http runner (network denied): the hook matches but fires nothing.
    // P6.12 — the denial is now REPORTED rather than silent; the request is
    // still never sent, which is the half this row has always pinned.
    const denied = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, { workspaceRootPath: process.cwd() });
    expect(denied.matchedCount).toBe(1);
    expect(denied.decision).toBeUndefined();
    expect(denied.hookErrors?.[0]?.summary).toContain('http hook did not run');

    // Network permitted: the runner is called exactly once with the descriptor.
    const requests: Array<{ url: string; method?: string }> = [];
    const allowed = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath: process.cwd(),
      httpRunner: async (request) => { requests.push({ url: request.http.url, method: request.http.method }); },
    });
    expect(allowed).toEqual({ matchedCount: 1, hookRuns: [{ runtime: 'host', event: 'Stop', name: 'toolkit/notify', outcome: 'success' }] }); // F1.9: the run is observed
    expect(requests).toEqual([{ url: 'https://example.invalid/webhook', method: 'POST' }]);
  });

  it('keeps unsafe HTTP hooks and oversized context inert even when runners are present', async () => {
    const requests: string[] = [];
    const config = {
      automations: {
        Stop: [{
          actions: [
            { type: 'plugin-prompt' as const, prompt: 'x'.repeat(16_385) },
            { type: 'plugin-http' as const, http: { url: 'file:///tmp/hook' } },
          ],
        }],
      },
    };

    const result = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath: process.cwd(),
      httpRunner: async request => { requests.push(request.http.url); },
    });

    expect(result.matchedCount).toBe(1);
    expect(requests).toEqual([]);
    // P3.231 · ONE PREDICATE PAST P6.12. The request is still never sent — that
    // is the half this test has always pinned — but the refusal is no longer
    // indistinguishable from having configured no hook at all. Same `hookErrors`
    // channel P6.12 gave the absent-runner case.
    expect(result.hookErrors?.some(notice => notice.summary.includes('not an http(s) URL'))).toBe(true);
  });

  it('keeps credential-bearing HTTP descriptors inert before the network runner', async () => {
    const requests: string[] = [];
    const sensitiveHeaderNames = [
      'Authorization',
      'Proxy-Authorization',
      'Cookie',
      'X-Token',
      'X-Secret',
      'X-Password',
      'X-Api-Key',
      'X-Credential',
    ];
    const config = {
      automations: {
        Stop: [{
          actions: [
            ...sensitiveHeaderNames.map(name => ({
              type: 'plugin-http',
              http: { url: 'https://example.invalid/header', headers: { [name]: 'redacted' } },
            })),
            {
              type: 'plugin-http',
              http: {
                url: 'https://example.invalid/auth',
                auth: { type: 'bearer', token: 'redacted' },
              },
            },
            { type: 'plugin-http', http: { url: 'https://host/hook?token=raw' } },
            { type: 'plugin-http', http: { url: 'https://host/hook?value=Bearer%20raw' } },
            { type: 'plugin-http', http: { url: 'https://host/hook', headers: { 'X-Custom': 'Bearer raw' } } },
            { type: 'plugin-http', http: { url: 'https://user:password@host/hook' } },
            {
              type: 'plugin-http',
              http: { url: 'https://host/hook', body: { payload: { credential: 'raw' } } },
            },
            { type: 'plugin-http', http: { url: 'https://host/hook', body: 'token=raw' } },
            { type: 'plugin-http', http: { url: 'https://host/hook', body: 'Bearer raw' } },
            { type: 'plugin-http', http: { url: 'https://host/hook', body: 'Basic raw' } },
          ],
        }],
      },
    } as any;

    const result = await executePluginHookAutomations(config, 'Stop', {
      hook_event_name: 'Stop',
    }, {
      workspaceRootPath: process.cwd(),
      httpRunner: async request => { requests.push(request.http.url); },
    });

    expect(result.matchedCount).toBe(1);
    expect(requests).toEqual([]);
    // P3.231 · every one of these descriptors is now REPORTED as refused rather
    // than silently dropped, one notice per action object. The wording says
    // "carries credentials, or could not be inspected" on purpose: the guard is
    // fail-closed and also refuses anything too large, too deep or too odd to
    // inspect, so asserting a credential was present would sometimes be a lie.
    // SIX, not seventeen: hooks.md deduplicates http hooks by URL, and these
    // seventeen actions carry six distinct ones — so the notice count follows
    // the run list it is reporting on rather than the declaration list.
    expect(result.hookErrors?.length).toBe(6);
    expect(result.hookErrors?.every((notice: { summary: string }) => notice.summary.includes('carries credentials'))).toBe(true);
  });

  it('preserves ordinary plugin HTTP query and body descriptors', async () => {
    // The two hooks carry distinct URLs: hooks.md deduplicates HTTP hooks by
    // URL, so a same-URL pair would be one run (asserted separately below).
    const requests: Array<{ url: string; body: unknown }> = [];
    const config = {
      automations: {
        Stop: [{
          actions: [
            {
              type: 'plugin-http',
              http: {
                url: 'https://example.invalid/hook?event=stop&author=ada',
                body: { event: 'stop', payload: { author: 'Ada', label: 'ordinary' } },
              },
            },
            {
              type: 'plugin-http',
              http: { url: 'https://example.invalid/hook?event=stop&author=ada&form=1', body: 'author=ada&event=stop' },
            },
          ],
        }],
      },
    } as any;

    const result = await executePluginHookAutomations(config, 'Stop', {
      hook_event_name: 'Stop',
    }, {
      workspaceRootPath: process.cwd(),
      httpRunner: async request => { requests.push({ url: request.http.url, body: request.http.body }); },
    });

    expect(result).toEqual({ matchedCount: 1, hookRuns: [{ runtime: 'host', event: 'Stop', name: 'Stop', outcome: 'success' }, { runtime: 'host', event: 'Stop', name: 'Stop', outcome: 'success' }] }); // F1.9: both runs are observed; F1.875: a nameless hook is named by its event
    expect(requests).toEqual([
      {
        url: 'https://example.invalid/hook?event=stop&author=ada',
        body: { event: 'stop', payload: { author: 'Ada', label: 'ordinary' } },
      },
      { url: 'https://example.invalid/hook?event=stop&author=ada&form=1', body: 'author=ada&event=stop' },
    ]);
  });

  it('executes trusted plugin hooks through the agent event command path', async () => {
    const hooks = [
      hook({ hookId: 'prompt', event: 'UserPromptSubmit', command: nodeCommand('process.exit(0)') }),
      hook({
        hookId: 'pretool',
        event: 'PreToolUse',
        command: nodeCommand('process.stdout.write(JSON.stringify({ decision: "block", reason: "policy" }))'),
      }),
      hook({ hookId: 'posttool', event: 'PostToolUse', command: nodeCommand('process.exit(0)') }),
      hook({ hookId: 'session-end', event: 'SessionEnd', command: nodeCommand('process.exit(0)') }),
    ];
    const config = automationsFor(hooks);
    // D1.354 — a clean run now publishes an observation of its own, which is the
    // half `hookErrors` could never carry. These three exit 0 and print nothing,
    // so the observation is the whole of what the result says about them.
    // `as const` on the two unions, not on the object: `event` and `name` are
    // parameters, so a whole-object `as const` would not narrow them and the
    // literal fields would widen to `string` against `HookRunObservation`.
    const cleanRun = (event: string, name: string) => ({
      matchedCount: 1,
      hookRuns: [{ runtime: 'host' as const, event, name, outcome: 'success' as const, exitCode: 0 }],
    });

    await expect(executePluginHookAutomations(config, 'UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true }))
      .resolves.toEqual(cleanRun('UserPromptSubmit', 'toolkit/prompt'));
    await expect(executePluginHookAutomations(config, 'PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true }))
      .resolves.toEqual(cleanRun('PostToolUse', 'toolkit/posttool'));
    await expect(executePluginHookAutomations(config, 'SessionEnd', {
      hook_event_name: 'SessionEnd',
      source: 'stop',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true }))
      .resolves.toEqual(cleanRun('SessionEnd', 'toolkit/session-end'));

    const preTool = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });
    expect(preTool).toEqual({
      matchedCount: 1,
      decision: { decision: 'block', reason: 'policy' },
      // D1.354 — the hook exited 0 and BLOCKED on its stdout, which is a hook
      // doing its job rather than a failure: the observation says `success` and
      // carries the stdout the decision was read from.
      hookRuns: [{
        runtime: 'host',
        event: 'PreToolUse',
        name: 'toolkit/pretool',
        outcome: 'success',
        exitCode: 0,
        stdout: JSON.stringify({ decision: 'block', reason: 'policy' }),
      }],
    });
  }, 15_000);

  it('keeps the observational hooks non-decision-bearing even on non-zero exit', async () => {
    // FileChanged is one of the observational lifecycle events; a failing command
    // hook on it must run but must never produce a blocking decision (only PreToolUse
    // is decision-bearing). This binds the frozen observational contract to enforcement.
    const config = {
      automations: {
        FileChanged: [{
          id: 'observational',
          actions: [{ type: 'command' as const, command: nodeCommand('process.exit(1)') }],
        }],
      },
    };
    const result = await executePluginHookAutomations(config, 'FileChanged', {
      hook_event_name: 'FileChanged',
      // The documented payload (hooks.md:2636) plus the retained Nessy aliases,
      // which is exactly what the emitter now produces.
      file_path: '/repo/a.txt',
      event: 'change',
      change_kind: 'write',
      path: '/repo/a.txt',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });
    // The observational contract is about the DECISION surface. The failure
    // itself is still reported (hooks.md § Exit code output) — that channel is
    // user-facing and carries no decision, so the contract is intact.
    expect(result).toEqual({
      matchedCount: 1,
      hookErrors: [{
        hookName: 'observational',
        event: 'FileChanged',
        exitCode: 1,
        summary: 'Hook command exited with code 1.',
      }],
      // P6.292 — the run FAILED, which is a separate answer from "the decision
      // surface stayed empty" and is what `once` consumption reads. Asserted
      // here rather than left out of the exact-shape comparison: the flag must
      // ride a non-zero exit even on an event that cannot decide.
      hookRunFailed: true,
      // D1.354 — and the RUN itself, which is a third answer again: the flag
      // says something failed, the notice says what the user is told, and this
      // says what happened. One observation for one run, so a reader preferring
      // `hookRuns` records the failure exactly once.
      hookRuns: [{
        runtime: 'host',
        event: 'FileChanged',
        name: 'observational',
        outcome: 'error',
        exitCode: 1,
      }],
    });
    expect(result.decision).toBeUndefined();
    expect(result.universal).toBeUndefined();
  });

  it('keeps a non-zero PreToolUse exit blocking even when stdout contains a transform', async () => {
    const config = {
      automations: {
        PreToolUse: [{
          matcher: 'Bash',
          actions: [{
            type: 'command' as const,
            command: nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "ignore" } })); process.exit(1)'),
          }],
        }],
      },
    };
    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' },
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });
    expect(result.decision).toMatchObject({ decision: 'block' });
  });

  // --- R22: prompt hooks decide through an injected runner -------------------

  it('a prompt hook with a runner returning ok:false blocks PreToolUse', async () => {
    const promptHook = hook({ event: 'PreToolUse', type: 'prompt', prompt: 'policy check' });
    const config = automationsFor([promptHook]);
    const promptRunner = async () => ({ ok: false, reason: 'policy says no' });

    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' },
    }, { workspaceRootPath: process.cwd(), promptRunner });

    expect(result.decision?.decision).toBe('block');
    expect(result.decision?.reason).toContain('policy says no');
  });

  it('a prompt hook with a runner returning ok:true does not block and injects nothing', async () => {
    const promptHook = hook({ event: 'PreToolUse', type: 'prompt', prompt: 'policy check' });
    const config = automationsFor([promptHook]);
    const promptRunner = async () => ({ ok: true });

    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' },
    }, { workspaceRootPath: process.cwd(), promptRunner });

    expect(result.decision).toBeUndefined();
  });

  it('without a runner, prompt hooks stay observational additionalContext', async () => {
    const promptHook = hook({ event: 'PreToolUse', type: 'prompt', prompt: 'policy check' });
    const config = automationsFor([promptHook]);

    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' },
    }, { workspaceRootPath: process.cwd() });

    expect(result.decision?.additionalContext).toBe('policy check');
    expect(result.decision?.decision).toBeUndefined();
  });

  it('on PermissionRequest a prompt-hook decision is discarded', async () => {
    // hooks.md: on PermissionRequest prompt/agent hook output "is discarded" —
    // the runner is never consulted and the observational path stays.
    const promptHook = hook({ event: 'PermissionRequest', type: 'prompt', prompt: 'audit' });
    const config = automationsFor([promptHook]);
    const promptRunner = async () => ({ ok: false, reason: 'no' });

    const result = await executePluginHookAutomations(config, 'PermissionRequest', {
      hook_event_name: 'PermissionRequest', tool_name: 'Bash',
    }, { workspaceRootPath: process.cwd(), promptRunner });

    expect(result.decision?.decision).toBeUndefined();
  });

  // --- The per-hook shell field (hooks.md § Command hook fields) -------------

  describe('hook shell field', () => {
    // `$0` names the interpreter: `bash -c` reports `bash`, the platform
    // default `spawn(..., { shell: true })` reports `/bin/sh`. (A process-table
    // probe would see the exec'd command instead — `sh -c`/`bash -c` exec a
    // single simple command.)
    const SHELL_PROBE = 'basename "$0"';
    const runOnUserPromptSubmit = (config: Parameters<typeof executePluginHookAutomations>[0]) =>
      executePluginHookAutomations(config, 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit', prompt: 'hi',
      }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    async function importClaudeShellHook(dir: string, hookEntry: Record<string, unknown>) {
      const bundle = join(dir, 'shelly');
      mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
      writeFileSync(join(bundle, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'shelly', version: '1.0.0' }));
      mkdirSync(join(bundle, 'hooks'), { recursive: true });
      writeFileSync(join(bundle, 'hooks', 'hooks.json'), JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [hookEntry] }] },
      }));
      return normalizeClaudePluginBundle(bundle, { source: 'local-path', localPath: bundle, resolvedAt: 1 });
    }

    it.skipIf(process.platform === 'win32')('a hook declaring shell bash spawns through bash, end to end from the Claude adapter', async () => {
      // The probe prints the spawning shell's process name; UserPromptSubmit
      // exposes exit-0 stdout as context, so the shell identifies itself in
      // the result. The field travels adapter → capability → record → action:
      // dropping it at the adapter turns this red.
      const dir = mkdtempSync(join(tmpdir(), 'hook-shell-'));
      try {
        const normalized = await importClaudeShellHook(dir, { type: 'command', command: SHELL_PROBE, shell: 'bash' });
        const capability = (normalized.value?.capabilities ?? []).find(entry => entry.kind === 'hook');
        expect(capability?.kind).toBe('hook');
        const imported = capability?.kind === 'hook' ? capability.hook : undefined;
        expect(imported?.shell).toBe('bash');

        const record = hook({
          event: 'UserPromptSubmit',
          command: imported!.command!,
          ...(imported!.shell ? { shell: imported!.shell } : {}),
        });
        const config = automationsFor([record]);
        expect(config.automations.UserPromptSubmit?.[0]?.actions[0]).toMatchObject({ type: 'command', shell: 'bash' });

        const result = await runOnUserPromptSubmit(config);
        expect(result.decision?.additionalContext?.trim()).toBe('bash');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it.skipIf(process.platform === 'win32')('without the field the platform default shell spawns', async () => {
      const record = hook({ event: 'UserPromptSubmit', command: SHELL_PROBE });
      const config = automationsFor([record]);
      const result = await runOnUserPromptSubmit(config);
      // `spawn(..., { shell: true })` is /bin/sh on darwin/linux.
      expect(result.decision?.additionalContext?.trim()).toBe('sh');
    }, 15_000);

    it.skipIf(process.platform === 'win32' || !!Bun.which('pwsh'))('a missing powershell is a stated execution error, never a bash fallback', async () => {
      const record = hook({ event: 'PostToolUse', command: SHELL_PROBE, shell: 'powershell' });
      const config = automationsFor([record]);
      const result = await executePluginHookAutomations(config, 'PostToolUse', {
        hook_event_name: 'PostToolUse', tool_name: 'Bash',
      }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });
      // The spawn never fell back to another shell: the run failed under the
      // native any-non-zero contract, and the block reason names the shell the
      // author asked for.
      expect(result.decision?.reason).toContain('hook shell "powershell" failed to start');
    }, 15_000);

    it.skipIf(process.platform === 'win32')('exec form ignores the shell field (hooks.md: "Ignored when `args` is set")', async () => {
      // pwsh is not consulted at all: were the field honored in exec form, the
      // spawn would fail on machines without PowerShell. The executable runs
      // directly and succeeds.
      const record = hook({
        event: 'UserPromptSubmit',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("exec-form-ran")'],
        shell: 'powershell',
      });
      const config = automationsFor([record]);
      const result = await runOnUserPromptSubmit(config);
      expect(result.decision?.additionalContext?.trim()).toBe('exec-form-ran');
    }, 15_000);

    it('an unknown shell value is a registration diagnostic, not a silent default', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hook-shell-'));
      try {
        const normalized = await importClaudeShellHook(dir, { type: 'command', command: 'echo hi', shell: 'zsh' });
        expect((normalized.value?.capabilities ?? []).filter(entry => entry.kind === 'hook')).toEqual([]);
        expect(normalized.diagnostics.some(diagnostic =>
          diagnostic.code === 'plugin.format.claude_capability_incomplete'
          && diagnostic.message.includes('"bash" or "powershell"'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // "declaring a shell changes the trust hash; absence keeps the old hash"
    // retired with `pluginHookExecutableHash` (F4). `shell` still participates:
    // the host-derived hash in `projection-candidates.ts` covers the whole
    // capability definition, so declaring or changing one re-prompts.
  });

  // --- Dedup and parallel execution (hooks.md:331) ---------------------------

  it('two identical command hooks run once, keyed by command string and args', async () => {
    // hooks.md: "identical handlers are deduplicated automatically. Command
    // hooks are deduplicated by command string and `args`". The two matchers
    // model the same plugin hook installed under two marketplace ids — only
    // provenance env differs, and env is outside the documented key.
    let invoked = 0;
    const runner = async () => {
      invoked++;
      return { type: 'command' as const, command: 'node guard.js', success: true, exitCode: 0, signal: null, durationMs: 1, stdout: '' };
    };
    const matcherFor = (id: string, env: Record<string, string>) => ({
      id, name: id, actions: [{ type: 'command' as const, command: 'node guard.js', args: ['--check'], env }],
    });
    const config = { automations: { PostToolUse: [
      matcherFor('a', { NESSY_PLUGIN_MARKETPLACE_ID: 'internal' }),
      matcherFor('b', { NESSY_PLUGIN_MARKETPLACE_ID: 'mirror' }),
    ] } };

    const result = await executePluginHookAutomations(config, 'PostToolUse', {
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
    }, { workspaceRootPath: process.cwd(), runner });

    expect(invoked).toBe(1);
    expect(result.matchedCount).toBe(2);
  });

  it('command hooks with different args are distinct handlers', async () => {
    const seen: string[] = [];
    const runner = async (action: { command: string; args?: string[] }) => {
      seen.push(JSON.stringify([action.command, action.args ?? null]));
      return { type: 'command' as const, command: action.command, success: true, exitCode: 0, signal: null, durationMs: 1, stdout: '' };
    };
    const config = { automations: { PostToolUse: [{
      id: 'x', name: 'x', actions: [
        { type: 'command' as const, command: 'node lint.js', args: ['--fix'] },
        { type: 'command' as const, command: 'node lint.js', args: ['--write'] },
        { type: 'command' as const, command: 'node lint.js' },
      ],
    }] } };

    await executePluginHookAutomations(config, 'PostToolUse', {
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
    }, { workspaceRootPath: process.cwd(), runner });

    expect(seen).toHaveLength(3);
  });

  it('two http hooks with one URL fire once', async () => {
    // hooks.md: "HTTP hooks are deduplicated by URL."
    const requests: string[] = [];
    const config = {
      automations: { Stop: [{
        id: 's', name: 's', actions: [
          { type: 'plugin-http' as const, http: { url: 'https://example.invalid/hook', body: 'first' } },
          { type: 'plugin-http' as const, http: { url: 'https://example.invalid/hook', body: 'second' } },
        ],
      }] },
    };

    await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
      workspaceRootPath: process.cwd(),
      httpRunner: async request => { requests.push(String(request.http.body)); },
    });

    // First registration wins, matching every other first-wins merge here.
    expect(requests).toEqual(['first']);
  });

  it('matched command hooks run in parallel and reduce in registration order', async () => {
    // hooks.md: "All matching hooks run in parallel". Three 150ms runners must
    // finish in ~max, not ~sum; the decisions still reduce in registration
    // order (the later block wins over the earlier allow deterministically).
    const delays: Record<string, { ms: number; stdout: string }> = {
      'node a.js': { ms: 150, stdout: JSON.stringify({ decision: 'allow' }) },
      'node b.js': { ms: 150, stdout: JSON.stringify({ decision: 'block', reason: 'b said no' }) },
      'node c.js': { ms: 150, stdout: JSON.stringify({ decision: 'allow' }) },
    };
    const runner = (action: { command: string }) => new Promise<{
      type: 'command'; command: string; success: boolean; exitCode: number; signal: null; durationMs: number; stdout: string;
    }>(resolve => {
      const spec = delays[action.command]!;
      setTimeout(() => resolve({ type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: spec.ms, stdout: spec.stdout }), spec.ms);
    });
    const config = { automations: { PreToolUse: Object.keys(delays).map(command => ({
      id: command, name: command, actions: [{ type: 'command' as const, command }],
    })) } };

    const start = Date.now();
    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' },
    }, { workspaceRootPath: process.cwd(), runner: action => runner(action) });
    const elapsed = Date.now() - start;

    // Sequential would be >= 450ms; parallel is ~150ms. 380ms keeps slack for
    // slow CI without ever passing a serialized run.
    expect(elapsed).toBeLessThan(380);
    expect(result.decision).toMatchObject({ decision: 'block', reason: 'b said no' });
  });

  // --- R22+R9: the per-event hook-type support matrix ------------------------

  // "refuses a prompt hook at registration on an event outside the support
  // matrix" retired with the V1 registration bridge (F4): its subject was that
  // bridge's own `hookTypeSupportedForEvent` gate and its
  // `plugin.hooks.type_unsupported_event` diagnostic. The one remaining path
  // enforces the matrix at DISPATCH, which the next row pins — so the contract
  // (a prompt hook on `Notification` never consults the judge) still has a test;
  // what it no longer has is a registration-time refusal.

  it('a prompt action that reached dispatch on an unsupported event is inert', async () => {
    // The dispatch-side belt: a stored/runtime-projected config that predates
    // the registration gate must not consult the judge or mint a decision.
    const config = {
      automations: {
        Notification: [{
          id: 'stale', name: 'stale', actions: [
            { type: 'plugin-prompt' as const, prompt: 'judge', timeoutMs: 1000 },
          ],
        }],
      },
    };
    let consulted = 0;

    const result = await executePluginHookAutomations(config, 'Notification', {
      hook_event_name: 'Notification', message: 'hi',
    }, {
      workspaceRootPath: process.cwd(),
      promptRunner: async () => { consulted++; return { ok: false, reason: 'no' }; },
    });

    expect(consulted).toBe(0);
    expect(result.decision).toBeUndefined();
  });

  it('a prompt-hook block on a no-decision event is dropped by the decision contract (R9)', async () => {
    // PermissionDenied supports prompt hooks, but its documented surface
    // carries no decision — the denial already happened. The prompt branch used
    // to bypass `projectHookDecisionForEvent` and mint a block here.
    const promptHook = hook({ event: 'PermissionDenied', type: 'prompt', prompt: 'audit the denial' });
    const config = automationsFor([promptHook]);

    const result = await executePluginHookAutomations(config, 'PermissionDenied', {
      hook_event_name: 'PermissionDenied', tool_name: 'Bash',
    }, {
      workspaceRootPath: process.cwd(),
      promptRunner: async () => ({ ok: false, reason: 'should not decide' }),
    });

    expect(result.matchedCount).toBe(1);
    expect(result.decision).toBeUndefined();
  });

  // --- R9 Step 0: the per-event decision contract un-gates the real path -----

  it('a PermissionRequest command hook allow reaches the caller through the plugin path', async () => {
    // CDP pass 3 (2026-07-27) proved this inert live: the band in pi-agent.ts
    // was written to consume `hookSpecificOutput.decision.behavior` but
    // executePluginHookAutomations dropped every non-PreToolUse decision, so
    // the prompt was raised anyway. Asserted HERE, on the path production uses,
    // not on a stub above it.
    const bandHook = hook({
      event: 'PermissionRequest',
      command: nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "ls -la" } } } }))'),
    });
    const config = automationsFor([bandHook]);

    const result = await executePluginHookAutomations(config, 'PermissionRequest', {
      hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' },
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect(result.decision).toMatchObject({ decision: 'allow', updatedInput: { command: 'ls -la' } });
  }, 15_000);

  it('a PermissionRequest command hook deny carries its message and interrupt', async () => {
    const bandHook = hook({
      event: 'PermissionRequest',
      command: nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: { decision: { behavior: "deny", message: "blocked by policy", interrupt: true } } }))'),
    });
    const config = automationsFor([bandHook]);

    const result = await executePluginHookAutomations(config, 'PermissionRequest', {
      hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' },
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect(result.decision).toMatchObject({ decision: 'deny', reason: 'blocked by policy', interrupt: true });
  }, 15_000);

  it('a stored decision action on PermissionRequest is honoured, on SessionStart it is not', async () => {
    const config = {
      automations: {
        PermissionRequest: [{ id: 'band', actions: [{ type: 'decision' as const, decision: 'deny' as const, reason: 'stored deny' }] }],
        SessionStart: [{ id: 'ctx', actions: [{ type: 'decision' as const, decision: 'deny' as const, reason: 'not my surface', additionalContext: 'hello' }] }],
      },
    };

    expect(await executePluginHookAutomations(config, 'PermissionRequest', {
      hook_event_name: 'PermissionRequest', tool_name: 'Bash',
    }, { workspaceRootPath: process.cwd() })).toEqual({
      matchedCount: 1,
      decision: { decision: 'deny', reason: 'stored deny' },
    });

    expect(await executePluginHookAutomations(config, 'SessionStart', {
      hook_event_name: 'SessionStart', source: 'startup',
    }, { workspaceRootPath: process.cwd() })).toEqual({
      matchedCount: 1,
      decision: { additionalContext: 'hello' },
    });
  });

  it('an exit-code-only event ignores a command hook decision but keeps its context', async () => {
    // TaskCreated has no plugin-facing spelling yet (`PluginHookEventName`
    // omits it), so this exercises the native/stored config shape — and its
    // native exit contract (UB12.70): under the Claude contract
    // (`blockOnNonZero: false`) a `hookSpecificOutput` with no `hookEventName`
    // fails the output schema and applies nothing (`hook-output-schema.test.ts`).
    const config = {
      automations: {
        TaskCreated: [{
          id: 'task',
          actions: [{
            type: 'command' as const,
            command: nodeCommand('process.stdout.write(JSON.stringify({ decision: "block", reason: "nope", hookSpecificOutput: { additionalContext: "noted" } }))'),
          }],
        }],
      },
    };

    const result = await executePluginHookAutomations(config, 'TaskCreated', {
      hook_event_name: 'TaskCreated', task_id: 'task-1',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect(result).toEqual({
      matchedCount: 1,
      decision: { additionalContext: 'noted' },
      // D1.354 — the observation is about the RUN and is deliberately blind to
      // which fields the event's contract then dropped: the hook exited 0 and
      // printed a decision this event may not carry, and the run still happened.
      hookRuns: [{
        runtime: 'host',
        event: 'TaskCreated',
        name: 'task',
        outcome: 'success',
        exitCode: 0,
        stdout: JSON.stringify({ decision: 'block', reason: 'nope', hookSpecificOutput: { additionalContext: 'noted' } }),
      }],
    });
  }, 15_000);

  it('carries the universal output fields out of the execution, on any event', async () => {
    const config = {
      automations: {
        Stop: [{
          id: 'notify',
          actions: [{
            type: 'command' as const,
            command: nodeCommand('process.stdout.write(JSON.stringify({ suppressOutput: true, systemMessage: "hook ran", stopReason: "for the user" }))'),
            blockOnNonZero: false,
          }],
        }],
      },
    };

    const result = await executePluginHookAutomations(config, 'Stop', {
      hook_event_name: 'Stop',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect(result.universal).toEqual({
      suppressOutput: true, systemMessage: 'hook ran', stopReason: 'for the user',
    });
    // `stopReason` is the user-facing half and must never become the reason the
    // model is told.
    expect(result.decision?.reason).toBeUndefined();
  }, 15_000);

  it('continue:false stops an exit-code-only event that has no decision field', async () => {
    const config = {
      automations: {
        TaskCreated: [{
          id: 'rollback',
          actions: [{
            type: 'command' as const,
            command: nodeCommand('process.stdout.write(JSON.stringify({ continue: false, stopReason: "rolled back" }))'),
            blockOnNonZero: false,
          }],
        }],
      },
    };

    const result = await executePluginHookAutomations(config, 'TaskCreated', {
      hook_event_name: 'TaskCreated', task_id: 'task-1',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect(result.universal?.continue).toBe(false);
    expect(result.decision?.decision).toBe('block');
  }, 15_000);

  it('reports a non-blocking hook failure as a named error notice instead of dropping it', async () => {
    // hooks.md § Exit code output: any non-zero exit other than 2 is a
    // non-blocking error whose `<hook name> hook error` notice plus first stderr
    // line reach the transcript, with the full stderr going to the debug log.
    const config = {
      automations: {
        PreToolUse: [{
          id: 'plugin-abc123',
          name: 'acme/secret-guard',
          actions: [{
            type: 'command' as const,
            command: nodeCommand('process.stderr.write("guard crashed: ENOENT\\n  at boot\\n"); process.exit(1)'),
            blockOnNonZero: false,
          }],
        }],
      },
    };

    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' },
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    // The call still proceeds — exit 1 does not block — but the failure is no
    // longer invisible.
    expect(result.decision).toBeUndefined();
    expect(result.hookErrors).toHaveLength(1);
    expect(result.hookErrors?.[0]).toMatchObject({
      hookName: 'acme/secret-guard',
      event: 'PreToolUse',
      exitCode: 1,
      summary: 'guard crashed: ENOENT',
    });
    expect(result.hookErrors?.[0]?.detail).toContain('at boot');
  }, 15_000);

  it('does not report an exit-2 block as a hook error', async () => {
    // Exit 2 already feeds stderr to the model as the blocking reason; a second
    // user-facing notice would double-count one failure.
    const config = {
      automations: {
        PreToolUse: [{
          id: 'plugin-def456',
          name: 'acme/policy',
          actions: [{
            type: 'command' as const,
            command: nodeCommand('process.stderr.write("policy violation\\n"); process.exit(2)'),
            blockOnNonZero: false,
          }],
        }],
      },
    };

    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' },
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect(result.decision?.decision).toBe('block');
    expect(result.hookErrors).toBeUndefined();
  }, 15_000);

  it('reads a WorktreeCreate command hook path from the last stdout line', async () => {
    const config = {
      automations: {
        WorktreeCreate: [{
          id: 'placer',
          actions: [{
            type: 'command' as const,
            command: nodeCommand('process.stdout.write("preparing\\n/repo/worktrees/from-hook\\n")'),
            blockOnNonZero: false,
          }],
        }],
      },
    };

    const result = await executePluginHookAutomations(config, 'WorktreeCreate', {
      hook_event_name: 'WorktreeCreate', agent_id: 'agent-1',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect(result.decision).toEqual({ worktreePath: '/repo/worktrees/from-hook' });
  }, 15_000);

  it('a non-zero WorktreeCreate exit blocks even for an imported three-way hook (hooks.md:699)', async () => {
    // "The exception is `WorktreeCreate`, where any non-zero exit code aborts
    // worktree creation." The three-way contract's exit-1-is-non-blocking rule
    // does not apply on this one event, so the computed action must NOT carry
    // `blockOnNonZero: false` and exit 1 must project as a block.
    const gate = hook({ event: 'WorktreeCreate', command: 'node gate.js', exitCodeContract: 'claude-three-way' });
    const config = automationsFor([gate]);
    expect(config.automations.WorktreeCreate?.[0]?.actions[0]).not.toMatchObject({ blockOnNonZero: false });

    const result = await executePluginHookAutomations(config, 'WorktreeCreate', {
      hook_event_name: 'WorktreeCreate',
    }, {
      workspaceRootPath: process.cwd(),
      runner: async () => ({ type: 'command' as const, command: 'node gate.js', success: false, exitCode: 1, signal: null, durationMs: 1, stdout: '', stderr: 'dirty base', output: 'dirty base' }),
    });
    expect(result.decision).toMatchObject({ decision: 'block' });
  });

  it('an exit-0 WorktreeCreate stdout decision is inert; only the path travels', async () => {
    // The path-return pattern decides through its exit code alone: a hook that
    // prints `{"decision":"block"}` and exits 0 decides nothing.
    const gate = hook({ event: 'WorktreeCreate', command: 'node gate.js' });
    const config = automationsFor([gate]);

    const result = await executePluginHookAutomations(config, 'WorktreeCreate', {
      hook_event_name: 'WorktreeCreate',
    }, {
      workspaceRootPath: process.cwd(),
      runner: async () => ({ type: 'command' as const, command: 'node gate.js', success: true, exitCode: 0, signal: null, durationMs: 1, stdout: JSON.stringify({ decision: 'block', reason: 'not via stdout' }) }),
    });
    expect(result.decision?.decision).toBeUndefined();
  });

  it('registers both a command and a non-command WorktreeCreate hook', () => {
    // Only a command hook can return the worktree path (hooks.md gives no other
    // channel, and our http runner is fire-and-forget), but the non-command one
    // still registers and runs — the path is what it cannot produce, not the hook.
    // The author-facing diagnostic that said so was V1's and retired with it.
    const hooks = [
      hook({ hookId: 'wt-mcp', event: 'WorktreeCreate', type: 'mcp', mcpTool: 'mcp__git__place' }),
      hook({ hookId: 'wt-cmd', event: 'WorktreeCreate', command: 'node place.js' }),
    ];
    const result = automationsFor(hooks);

    expect(result.automations.WorktreeCreate).toHaveLength(2);
  });

  it('keeps stored automations naming McpElicitation loadable after the Elicitation alias', () => {
    // The alias lives in the adapter; the CONTRACT name is unchanged, so a stored
    // automation written against `McpElicitation` still maps and still runs.
    const stored = hook({ hookId: 'elicit', event: 'McpElicitation', command: 'node watch.js' });
    const result = automationsFor([stored]);

    expect(result.automations.McpElicitation).toHaveLength(1);
  });

  it('continueOnBlock is stored but changes nothing today (pinned for R9)', async () => {
    // hooks.md implements continueOnBlock as `continue: true` on the resulting
    // decision:"block". Our automation merge distinguishes only via the
    // decision value, so today the block merges identically whether the field
    // is set or not — R9's per-event matrix work consumes it. This pin fails
    // the moment someone makes the field change merge behaviour without R9.
    const promptHook = hook({ event: 'PreToolUse', type: 'prompt', prompt: 'p', continueOnBlock: true });
    const config = automationsFor([promptHook]);
    const promptRunner = async () => ({ ok: false, reason: 'r' });

    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' },
    }, { workspaceRootPath: process.cwd(), promptRunner });

    expect(result.decision).toMatchObject({ decision: 'block', reason: 'r' });
  });

  // --- R22: async command hooks ---------------------------------------------

  it('an async command hook fires without blocking and cannot decide', async () => {
    const asyncHook = hook({ event: 'PreToolUse', command: 'node guard.js', async: true });
    const config = automationsFor([asyncHook]);
    let resolveRun: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { resolveRun = resolve; });
    let invoked = 0;
    const slowRunner = async () => {
      invoked++;
      await gate;
      return { type: 'command' as const, command: 'node guard.js', success: true, exitCode: 0, signal: null, durationMs: 1, stdout: JSON.stringify({ decision: 'block' }) };
    };

    // Resolves without waiting for the gate: the run stays in the background.
    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' },
    }, { workspaceRootPath: process.cwd(), runner: slowRunner });

    expect(result.matchedCount).toBe(1);
    expect(result.decision).toBeUndefined();
    expect(invoked).toBe(1);
    resolveRun!(); // let the background run finish; no unhandled rejection
  });

  it('an async hook result is never parsed for a decision even after completion', async () => {
    const asyncHook = hook({ event: 'PreToolUse', command: 'node guard.js', async: true });
    const config = automationsFor([asyncHook]);
    // Exit 2 would block under the sync imported-hook contract; async discards it.
    const runner = async () => ({ type: 'command' as const, command: 'node guard.js', success: false, exitCode: 2, signal: null, durationMs: 1, stdout: '', stderr: 'blocked!', output: 'blocked!' });

    const result = await executePluginHookAutomations(config, 'PreToolUse', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' },
    }, { workspaceRootPath: process.cwd(), runner });

    expect(result.decision).toBeUndefined();
  });

  it('registers a hook that declares once, asyncRewake or a valid if rule (R22)', () => {
    // All three are carried-and-not-honoured (or, for `if`, honoured at
    // dispatch): none of them may stop the hook registering. The info
    // diagnostics that named each deferred half were the V1 bridge's and
    // retired with it (F4).
    const hooks = [
      hook({ hookId: 'once-hook', event: 'PostToolUse', command: nodeCommand('process.exit(0)'), once: true }),
      hook({ hookId: 'if-hook', event: 'PreToolUse', command: nodeCommand('process.exit(0)'), ifRule: 'Bash(git *)' }),
      hook({ hookId: 'rewake-hook', event: 'PostToolUse', command: nodeCommand('process.exit(0)'), async: true, asyncRewake: true }),
    ];

    const result = automationsFor(hooks);

    expect(result.automations.PostToolUse).toHaveLength(2);
    expect(result.automations.PreToolUse).toHaveLength(1);
    expect(result.automations.PreToolUse?.[0]?.ifRule).toBe('Bash(git *)');
  });

  describe('hook if filter evaluation (R1, hooks.md)', () => {
    const countingRunner = () => {
      const state = { invoked: 0 };
      const runner = async () => {
        state.invoked++;
        return { type: 'command' as const, command: 'node x', success: true, exitCode: 0, signal: null, durationMs: 1, stdout: '' };
      };
      return { state, runner };
    };
    const preToolUse = (toolName: string, toolInput: Record<string, unknown>) => ({
      hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput,
    });

    it('a Bash if filter gates on the documented any-subcommand semantics and fails open', async () => {
      const ifHook = hook({ hookId: 'if-hook', event: 'PreToolUse', command: nodeCommand('process.exit(0)'), ifRule: 'Bash(git *)' });
      const config = automationsFor([ifHook]);
      const { state, runner } = countingRunner();
      const run = (command: string) => executePluginHookAutomations(
        config, 'PreToolUse', preToolUse('Bash', { command }),
        { workspaceRootPath: process.cwd(), runner },
      );

      expect((await run('git status')).matchedCount).toBe(1);
      expect(state.invoked).toBe(1);
      // No subcommand matches: the hook does not run.
      expect((await run('npm test')).matchedCount).toBe(0);
      expect(state.invoked).toBe(1);
      // ANY matching subcommand runs the hook (hooks.md matching table).
      expect((await run('npm test && git push')).matchedCount).toBe(1);
      expect(state.invoked).toBe(2);
      // An unparseable command fails open.
      expect((await run('git "status')).matchedCount).toBe(1);
      expect(state.invoked).toBe(3);
    });

    it('a file-tool if filter evaluates through the one-rule DSL with allow depth', async () => {
      const ifHook = hook({ hookId: 'edit-if', event: 'PreToolUse', command: nodeCommand('process.exit(0)'), ifRule: 'Edit(*.ts)' });
      const config = automationsFor([ifHook]);
      const { state, runner } = countingRunner();
      const run = (toolInput: Record<string, unknown>) => executePluginHookAutomations(
        config, 'PreToolUse', preToolUse('Edit', toolInput),
        { workspaceRootPath: process.cwd(), runner },
      );

      expect((await run({ file_path: 'a.ts' })).matchedCount).toBe(1);
      expect(state.invoked).toBe(1);
      expect((await run({ file_path: 'a.md' })).matchedCount).toBe(0);
      // v2.1.214 depth: Edit(*.ts) anchors to the working directory.
      expect((await run({ file_path: 'src/deep/a.ts' })).matchedCount).toBe(0);
      expect(state.invoked).toBe(1);
    });

    it('a hook with if on a non-tool event never runs (hooks.md)', async () => {
      const ifHook = hook({ hookId: 'session-if', event: 'SessionStart', command: nodeCommand('process.exit(0)'), ifRule: 'Bash(git *)' });
      const result = automationsFor([ifHook]);
      expect(result.automations.SessionStart ?? []).toHaveLength(0);
      const { state, runner } = countingRunner();
      const executed = await executePluginHookAutomations(result, 'SessionStart', {
        hook_event_name: 'SessionStart',
      }, { workspaceRootPath: process.cwd(), runner });
      expect(executed.matchedCount).toBe(0);
      expect(state.invoked).toBe(0);
    });

    it('a source-anchored if filter resolves against the plugin bundle instead of failing open', async () => {
      // `ClaudeHookIfCall.sourceRoot` was consumed inside the module and never
      // supplied, so `compilePermissionDslV1` could not compile a `/x` anchor
      // and every source-anchored filter returned `{ run: true }` — the hook
      // ran on every tool call across the five TOOL_HOOK_EVENTS, and the
      // registration diagnostic stayed silent because the rule PARSES.
      //
      // Owner decision 2026-07-29: a plugin hook's `if` anchors to the plugin's
      // own bundle, the settings source that defines it, not the project root.
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-if-root-')));
      try {
        const ifHook = hook({
          hookId: 'scoped-if', event: 'PreToolUse', command: nodeCommand('process.exit(0)'),
          ifRule: 'Edit(/scripts/**)', executionRoot: root,
        });
        const result = automationsFor([ifHook]);
        expect(result.automations.PreToolUse?.[0]?.ifSourceRoot).toBe(root);

        const { state, runner } = countingRunner();
        const run = (filePath: string) => executePluginHookAutomations(
          result, 'PreToolUse', preToolUse('Edit', { file_path: filePath }),
          { workspaceRootPath: process.cwd(), runner },
        );

        expect((await run(join(root, 'scripts', 'fix.ts'))).matchedCount).toBe(1);
        expect(state.invoked).toBe(1);
        // The project's own `scripts/` is a different directory and no longer
        // matches; before the anchor existed, this ran too.
        expect((await run(join(process.cwd(), 'scripts', 'fix.ts'))).matchedCount).toBe(0);
        expect((await run(join(root, 'other', 'fix.ts'))).matchedCount).toBe(0);
        expect(state.invoked).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('registers a source-anchored if filter with and without a bundle root to anchor at', () => {
      // A rule that PARSES but names a `/x` source anchor cannot compile without
      // a root, so it fails open at execution and the hook runs on every tool
      // call. Either way it registers — a best-effort filter that cannot decide
      // runs the hook, it does not drop it. The registration-time
      // `plugin.hooks.if_unparseable_fail_open` report that distinguished the two
      // was the V1 bridge's and retired with it (F4); the execution-time half is
      // `evaluateClaudeHookIfFilter`'s own `unparseableRule`, pinned below.
      const rooted = hook({
        hookId: 'rooted-if', event: 'PreToolUse', command: nodeCommand('process.exit(0)'),
        ifRule: 'Edit(/scripts/**)', executionRoot: '/plugins/toolkit',
      });
      const rootless = hook({
        hookId: 'rootless-if', event: 'PreToolUse', command: nodeCommand('process.exit(0)'),
        ifRule: 'Edit(/scripts/**)',
      });

      expect(automationsFor([rooted]).automations.PreToolUse).toHaveLength(1);
      expect(automationsFor([rootless]).automations.PreToolUse).toHaveLength(1);
    });

    it('a garbage if rule fails open with a diagnostic and the hook always runs', async () => {
      const ifHook = hook({ hookId: 'garbage-if', event: 'PreToolUse', command: nodeCommand('process.exit(0)'), ifRule: '???' });
      const result = automationsFor([ifHook]);
      const { state, runner } = countingRunner();
      const executed = await executePluginHookAutomations(result, 'PreToolUse', preToolUse('Read', { file_path: 'x' }), {
        workspaceRootPath: process.cwd(), runner,
      });
      expect(executed.matchedCount).toBe(1);
      expect(state.invoked).toBe(1);
      // P2.277: the title of this test promised a diagnostic for a year and the
      // body asserted only the fail-open, because there WAS none — the producer
      // set `unparseableRule` and the dispatch loop read `.run` and dropped it.
      // The direction stays open (hooks.md: the filter is best-effort); what
      // changes is that the operator is told the hook is running on a rule that
      // never compiled, and the rule is quoted so it can be found and fixed.
      expect(executed.hookErrors).toHaveLength(1);
      expect(executed.hookErrors?.[0]).toMatchObject({ hookName: 'toolkit/garbage-if', event: 'PreToolUse' });
      expect(executed.hookErrors?.[0]?.summary).toContain('"???"');
      expect(executed.hookErrors?.[0]?.summary).toContain('failed open');
    });

    it('a fail-open if rule keeps the hook running but drops its session-widening updatedPermissions', async () => {
      // P6.570. The fail-open direction is the page's and is unchanged
      // (`hooks.md#bash-if-matching`: "Because the `if` filter is best-effort,
      // use the permission system rather than a hook to enforce a hard allow or
      // deny"). What that sentence cannot license is the ONE output that widens:
      // `updatedPermissions` is allow-only per `hooks.md#permissionrequest` and
      // asks the host to hand the session a permission it did not have. A rule
      // that never compiled cannot be the authority for granting one, so the
      // grant is dropped while everything else the hook said survives.
      const widenScript = 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest",'
        + ' decision: { behavior: "allow", updatedInput: { command: "ls -la" },'
        + ' updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] } } }))';
      const permissionRequest = {
        hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' },
      };

      // NEGATIVE — `???` compiles to nothing, the filter fails open, the hook
      // runs on a call its author scoped away, and the widening does not apply.
      const failedOpen = automationsFor([hook({
        hookId: 'widening-garbage-if', event: 'PermissionRequest', ifRule: '???', command: nodeCommand(widenScript),
      })]);
      const denied = await executePluginHookAutomations(
        failedOpen, 'PermissionRequest', permissionRequest,
        { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true },
      );
      expect(denied.matchedCount).toBe(1);
      expect(denied.decision).toMatchObject({ decision: 'allow', updatedInput: { command: 'ls -la' } });
      expect(denied.decision?.updatedPermissions).toBeUndefined();
      // The operator is told why, on the notice the fail-open already carries.
      expect(denied.hookErrors?.[0]?.detail).toContain('`updatedPermissions` are the one exception');

      // POSITIVE — the same hook under a rule that COMPILES and MATCHES keeps
      // its grant, so this guards the direction rather than deleting the field.
      const scoped = automationsFor([hook({
        hookId: 'widening-good-if', event: 'PermissionRequest', ifRule: 'Bash(ls *)', command: nodeCommand(widenScript),
      })]);
      const granted = await executePluginHookAutomations(
        scoped, 'PermissionRequest', permissionRequest,
        { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true },
      );
      expect(granted.matchedCount).toBe(1);
      expect(granted.hookErrors).toBeUndefined();
      expect(granted.decision?.updatedPermissions)
        .toEqual([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }]);
    }, 20_000);

    it('reports the source-anchored fail-open too, and still runs the hook', async () => {
      // The SECOND unparseable route, and the one that reaches ordinary configs:
      // a rule that PARSES but names a `/x` source anchor with no root to
      // resolve against compiles to `invalid-policy` inside the DSL. This is the
      // branch P2.270 measured on the permission side — flipping it closed would
      // stop such hooks running altogether, which is why the row is surfacing
      // only. `Edit(/scripts/**)` with no `executionRoot` is exactly the
      // `rootless-if` registration pinned above.
      const ifHook = hook({ hookId: 'rootless-if', event: 'PreToolUse', command: nodeCommand('process.exit(0)'), ifRule: 'Edit(/scripts/**)' });
      const result = automationsFor([ifHook]);
      expect(result.automations.PreToolUse?.[0]?.ifSourceRoot).toBeUndefined();
      const { state, runner } = countingRunner();
      const executed = await executePluginHookAutomations(
        result, 'PreToolUse', preToolUse('Edit', { file_path: join(process.cwd(), 'nowhere', 'x.ts') }),
        { workspaceRootPath: process.cwd(), runner },
      );
      expect(executed.matchedCount).toBe(1);
      expect(state.invoked).toBe(1);
      expect(executed.hookErrors?.[0]?.summary).toContain('"Edit(/scripts/**)"');
    });

    it('says nothing when the if rule parses, whether it matches or not', async () => {
      // The negative half. A filter that compiled is silent on BOTH outcomes —
      // otherwise every ordinary gated hook would warn on every tool call, and
      // the notice would carry no information at all.
      const ifHook = hook({ hookId: 'good-if', event: 'PreToolUse', command: nodeCommand('process.exit(0)'), ifRule: 'Bash(git *)' });
      const config = automationsFor([ifHook]);
      const { state, runner } = countingRunner();
      const run = (command: string) => executePluginHookAutomations(
        config, 'PreToolUse', preToolUse('Bash', { command }),
        { workspaceRootPath: process.cwd(), runner },
      );

      const matched = await run('git status');
      expect(matched.matchedCount).toBe(1);
      expect(matched.hookErrors).toBeUndefined();
      const missed = await run('npm test');
      expect(missed.matchedCount).toBe(0);
      expect(missed.hookErrors).toBeUndefined();
      expect(state.invoked).toBe(1);

      // Boundary: an unparseable Bash COMMAND under a parseable rule is the one
      // fail-open hooks.md spells out, and it is NOT a rule fault — the hook
      // runs and the channel stays quiet.
      const unparseableCommand = await run('git status "unterminated');
      expect(unparseableCommand.matchedCount).toBe(1);
      expect(unparseableCommand.hookErrors).toBeUndefined();
    });

    it('reports an unparseable if rule once per matcher, not once per tool call', async () => {
      // A fail-open filter fires on every call across the five tool events. The
      // notice is an authoring fact about the rule, so a second dispatch of the
      // same matcher adds nothing — without this the transcript would carry a
      // warning bubble beside every tool call in the session.
      const ifHook = hook({ hookId: 'noisy-if', event: 'PreToolUse', command: nodeCommand('process.exit(0)'), ifRule: '???' });
      const config = automationsFor([ifHook]);
      const { state, runner } = countingRunner();
      const run = () => executePluginHookAutomations(
        config, 'PreToolUse', preToolUse('Read', { file_path: 'x' }),
        { workspaceRootPath: process.cwd(), runner },
      );

      expect((await run()).hookErrors).toHaveLength(1);
      expect((await run()).hookErrors).toBeUndefined();
      expect((await run()).hookErrors).toBeUndefined();
      // The hook itself never stops running — the diagnostic is deduplicated,
      // the fail-open is not.
      expect(state.invoked).toBe(3);

      // A separate load of the same broken rule is a separate matcher object and
      // gets its own notice: the dedupe is per config, never per process.
      const reloaded = automationsFor([ifHook]);
      expect((await executePluginHookAutomations(
        reloaded, 'PreToolUse', preToolUse('Read', { file_path: 'x' }),
        { workspaceRootPath: process.cwd(), runner },
      )).hookErrors).toHaveLength(1);
    });
  });

  it('fails closed instead of directly spawning a command when no runner authority exists', async () => {
    const marker = join(process.cwd(), `must-not-run-${Date.now()}`);
    const config = {
      automations: {
        PreToolUse: [{
          matcher: 'Bash',
          actions: [{ type: 'command' as const, command: nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`) }],
        }],
      },
    };
    try {
      const result = await executePluginHookAutomations(config, 'PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash',
      }, { workspaceRootPath: process.cwd() });
      expect(result).toMatchObject({
        matchedCount: 1,
        decision: { decision: 'block', reason: 'command-hook-execution-authority-unavailable' },
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it('exposes trusted plugin PreToolUse hooks through the Claude SDK hooks path', async () => {
    const blockHook = hook({
      hookId: 'blocker',
      event: 'PreToolUse',
      command: nodeCommand('process.stdout.write(JSON.stringify({ decision: "block", reason: "policy" }))'),
    });
    const modifyHook = hook({
      hookId: 'modifier',
      event: 'PreToolUse',
      command: nodeCommand('process.stdout.write(JSON.stringify({ updatedInput: { command: "echo safe" }, additionalContext: "rewritten" }))'),
    });
    const config = automationsFor([blockHook, modifyHook]);
    const scoped = new PluginScopedAutomationSystem({
      pluginHookConfig: config,
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
    });

    const sdkHooks = scoped.buildSdkHooks().PreToolUse ?? [];
    expect(sdkHooks).toHaveLength(2);
    await expect(sdkHooks[0]?.hooks[0]?.({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/nope' },
      tool_use_id: 'tool-1',
    }, 'tool-1', {})).resolves.toEqual({
      // P3.176 · the block leaves through the field the page names for this
      // event. P3.195 · and the turn now CONTINUES, which is what made that move
      // more than cosmetic: `continue: false` outranks `permissionDecision`, so
      // while this read `false` the deny still ended the turn.
      // hooks.md#response-schema calls `continueOnBlock: true` — "return the
      // reason to Claude as the tool error so it can adjust and continue" —
      // "equivalent to a command hook's `permissionDecision: "deny"`", and this
      // is a command hook.
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'policy',
      },
    });
    await expect(sdkHooks[1]?.hooks[0]?.({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
      tool_use_id: 'tool-2',
    }, 'tool-2', {})).resolves.toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { command: 'echo safe' },
        additionalContext: 'rewritten',
      },
    });
  });

  // --- P3.163: four fields the SDK translator discarded ---------------------

  /** One plugin-scoped system holding a single command hook, SDK path only. */
  const sdkCallbackFor = (event: string, script: string, options: { exitCodeContract?: 'claude-three-way' } = {}) => {
    const scoped = new PluginScopedAutomationSystem({
      pluginHookConfig: automationsFor([hook({
        hookId: 'sdk-translator',
        event,
        command: nodeCommand(script),
        ...(options.exitCodeContract ? { exitCodeContract: options.exitCodeContract } : {}),
      })]),
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
    });
    const matchers = scoped.buildSdkHooks()[event as keyof ReturnType<typeof scoped.buildSdkHooks>] ?? [];
    expect(matchers).toHaveLength(1);
    return (input: Record<string, unknown>) => matchers[0]!.hooks[0]!(
      { hook_event_name: event, ...input } as never,
      'tool-1',
      {},
    );
  };

  it('a PostToolUse block feeds its reason back without ending the turn (P3.163)', async () => {
    // hooks.md#posttooluse-decision-control: `decision` `"block"` "adds the
    // `reason` next to the tool result. Claude still sees the original output"
    // — the conversation continues, which is also what this fork's own
    // `hookBlockEndsTurn('PostToolUse')` has always answered. The translator
    // returned `continue: false` on EVERY block, and hooks.md#json-output makes
    // that terminal: "If `false`, Claude stops processing entirely after the
    // hook runs."
    const call = sdkCallbackFor('PostToolUse', 'process.stdout.write(JSON.stringify({ decision: "block", reason: "tests failed" }))');
    await expect(call({
      tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_response: 'fail', tool_use_id: 'tool-1',
    })).resolves.toEqual({ continue: true, decision: 'block', reason: 'tests failed' });
  });

  it('reads the universal `continue: true` a command hook printed (P3.163, P3.195)', async () => {
    // The shape `continueOnBlock` compiles to, which the translator never read —
    // so the block stood AND the turn ended.
    //
    // P3.195 · after the contract was decided this is a NO-OP for a command
    // hook's PreToolUse deny, because that deny no longer ends the turn on its
    // own. The test is kept rather than deleted: it pins that
    // `result.universal` is still read (the P3.163 defect) and that an explicit
    // `continue: true` never turns into `false` on the way out. The case where
    // the field DOES decide is a prompt hook's block, pinned in
    // `hook-block-decisions.test.ts`.
    const call = sdkCallbackFor('PreToolUse', 'process.stdout.write(JSON.stringify({ decision: "block", reason: "policy", continue: true }))');
    await expect(call({
      tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 'tool-1',
    })).resolves.toEqual({
      continue: true,
      // P3.176 moved the decision itself onto `permissionDecision`; the
      // `continue: true` this test exists for is untouched.
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'policy',
      },
    });
  });

  it('forwards the other three universal fields (P3.163)', async () => {
    // `SyncHookJSONOutput` declares all five; `HookUniversalOutput` parses all
    // five; the translator carried `continue` alone, so `stopReason`,
    // `suppressOutput` and `systemMessage` were parsed, merged and thrown away.
    const call = sdkCallbackFor('PostToolUse', 'process.stdout.write(JSON.stringify({ stopReason: "shown to the user", suppressOutput: true, systemMessage: "heads up" }))');
    await expect(call({
      tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_response: 'ok', tool_use_id: 'tool-1',
    })).resolves.toEqual({
      continue: true,
      stopReason: 'shown to the user',
      suppressOutput: true,
      systemMessage: 'heads up',
    });
  });

  it('surfaces a non-blocking hook failure as a systemMessage (P3.163)', async () => {
    // `SessionManager.reportHookErrors` is the host-path consumer and it never
    // runs for a hook dispatched through `buildSdkHooks` — the callback's
    // return value is the only channel out. hooks.md#json-output gives
    // `systemMessage` as the "Warning message shown to the user", which in the
    // Agent SDK "can arrive as an `SDKInformationalMessage`". Before this a
    // crashed hook on claude-runtime left no trace anywhere.
    const call = sdkCallbackFor(
      'PostToolUse',
      'process.stderr.write("scanner unavailable\\nstack line"); process.exit(3)',
      { exitCodeContract: 'claude-three-way' },
    );
    const result = await call({
      tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_response: 'ok', tool_use_id: 'tool-1',
    });
    expect(result.continue).toBe(true);
    expect(result.systemMessage).toBe('toolkit/sdk-translator hook error: scanner unavailable');
  });

  it('forwards PostToolUse and PostToolUseFailure additionalContext (P3.163)', async () => {
    // hooks.md#add-context-for-claude: "PreToolUse, PostToolUse,
    // PostToolUseFailure, and PostToolBatch: next to the tool result". The
    // translator named three events inline and neither of these was among them,
    // so the field reached the SDK on none of them — and on PostToolUse the
    // `updatedToolOutput` branch returned first, dropping a context string
    // returned alongside a rewrite.
    const both = sdkCallbackFor('PostToolUse', 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "[redacted]", additionalContext: "output was redacted" } }))');
    await expect(both({
      tool_name: 'Bash', tool_input: { command: 'env' }, tool_response: 'SECRET=1', tool_use_id: 'tool-1',
    })).resolves.toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: '[redacted]',
        additionalContext: 'output was redacted',
      },
    });

    const failure = sdkCallbackFor('PostToolUseFailure', 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "the daemon is down" } }))');
    await expect(failure({
      tool_name: 'Bash', tool_input: { command: 'systemctl status' }, error: 'exit 1', tool_use_id: 'tool-1',
    })).resolves.toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: 'the daemon is down',
      },
    });
  });

  it('frames a PostToolUse classifierContext and gives PostToolUseFailure none (P7.14)', async () => {
    // `hooks.md#annotate-a-result-for-the-auto-mode-classifier`, the page's own
    // example note. Two facts in one run: the field survives parse → contract
    // table → translator (it reached the SDK on no event before the lift to
    // `0.3.247` declared it), and it arrives FRAMED — every configured hook on
    // this fork returns through an in-process SDK callback, the tier whose note
    // the classifier "may weigh … as user intent", so an unframed relay would
    // promote a plugin's sentence to the host's own weight.
    const note = 'This query ran against the staging database, not production.';
    const annotated = sdkCallbackFor('PostToolUse', `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", classifierContext: ${JSON.stringify(note)} } }))`);
    await expect(annotated({
      tool_name: 'Bash', tool_input: { command: 'psql -c "select 1"' }, tool_response: 'ok', tool_use_id: 'tool-1',
    })).resolves.toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        classifierContext: `A hook configured in this workspace reports: ${note}`,
      },
    });

    // The boundary, and it is the vendored declaration's rather than a
    // preference: `PostToolUseFailureHookSpecificOutput` is `{ hookEventName;
    // additionalContext? }` and carries no note at all.
    const failure = sdkCallbackFor('PostToolUseFailure', `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", classifierContext: ${JSON.stringify(note)} } }))`);
    await expect(failure({
      tool_name: 'Bash', tool_input: { command: 'psql -c "select 1"' }, error: 'exit 1', tool_use_id: 'tool-1',
    })).resolves.toEqual({ continue: true });
  });

  // --- P3.176/P3.177: the PreToolUse permission half -----------------------

  it('carries ask and defer, and withholds allow, on PreToolUse (P3.176)', async () => {
    // hooks.md#pretooluse-decision-control: PreToolUse "returns its decision
    // inside a `hookSpecificOutput` object … four outcomes (allow, deny, ask, or
    // defer)". The translator discarded `allow` and `ask` entirely and had no
    // representation for `defer` at all.
    const ask = sdkCallbackFor('PreToolUse', 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "a human should look" } }))');
    await expect(ask({
      tool_name: 'Bash', tool_input: { command: 'git push --force' }, tool_use_id: 'tool-1',
    })).resolves.toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'a human should look',
      },
    });

    // `defer` "exits gracefully so the tool can be resumed later", and since
    // P2.525 it leaves here saying exactly that. It used to leave as `ask`,
    // matching the live claude gate's degrade — this translator has no live
    // reader (the merge drops this event's non-internal matchers), so its whole
    // job is to answer the same question the reachable path answers. P2.525
    // closed the receive side and the live gate now emits the runtime's own
    // value, so the degrade left both sides in one commit.
    //
    // The three companion fields stay dropped because the page says each is
    // ignored for the value the HOOK wrote — `permissionDecisionReason` "For
    // `"defer"`, ignored", `updatedInput` the same, `additionalContext`
    // "Ignored when `permissionDecision` is `"defer"`". `updatedInput` is the
    // sharp one: it is the input the gate revalidates, so resurrecting it here
    // would let a defer rewrite the very command it was trying to hold.
    const defer = sdkCallbackFor('PreToolUse', 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer", permissionDecisionReason: "waiting on the operator", additionalContext: "ignored", updatedInput: { command: "echo ignored" } } }))');
    await expect(defer({
      tool_name: 'Bash', tool_input: { command: 'deploy' }, tool_use_id: 'tool-2',
    })).resolves.toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' },
    });

    // The NEGATIVE, and the one that is deliberate rather than incidental: an
    // `allow` still travels as NO `permissionDecision` at all. P3.93 measured a
    // PreToolUse allow silencing the SDK auto-mode classifier completely, so
    // granting a plugin-authored hook that power is the owner's call; the
    // fall-through is arm A4, the shape that lets the classifier run.
    const allow = sdkCallbackFor('PreToolUse', 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "echo safe" } } }))');
    await expect(allow({
      tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'tool-3',
    })).resolves.toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'echo safe' } },
    });
  });

  it('never emits the top-level decision pair the page deprecates for PreToolUse (P3.176)', async () => {
    // hooks.md#pretooluse-decision-control's note: "PreToolUse previously used
    // top-level `decision` and `reason` fields, but these are deprecated for
    // this event. Use `hookSpecificOutput.permissionDecision` and
    // `hookSpecificOutput.permissionDecisionReason` instead." The paired
    // positive control is the PostToolUse block above, which still uses the
    // top-level pair because for that event it IS the current format.
    const denied = await sdkCallbackFor('PreToolUse', 'process.stdout.write(JSON.stringify({ decision: "deny", reason: "policy" }))')({
      tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 'tool-1',
    });
    expect(denied.decision).toBeUndefined();
    expect(denied.reason).toBeUndefined();
    expect(denied.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'policy',
    });
  });

  it('gives defer its documented rank so a second hook cannot outrank it (P3.176)', async () => {
    // hooks.md#pretooluse-decision-control: "When multiple PreToolUse hooks
    // return different decisions, precedence is `deny` > `defer` > `ask` >
    // `allow`." The plugin-side merge omitted `defer` from its rank table, so it
    // scored 0 — below `allow` — and a later allow erased it before the
    // translator was ever reached.
    const deferThenAllow = {
      automations: {
        PreToolUse: [{
          matcher: 'Bash',
          actions: [
            { type: 'decision' as const, decision: 'defer' as const },
            { type: 'decision' as const, decision: 'allow' as const },
          ],
        }],
      },
    };
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash' };
    expect(await executePluginHookAutomations(deferThenAllow, 'PreToolUse', input, {
      workspaceRootPath: '/workspace',
    })).toMatchObject({ decision: { decision: 'defer' } });

    // And a deny still outranks a defer, in either order.
    const deferThenDeny = {
      automations: {
        PreToolUse: [{
          matcher: 'Bash',
          actions: [
            { type: 'decision' as const, decision: 'defer' as const },
            { type: 'decision' as const, decision: 'deny' as const, reason: 'no' },
          ],
        }],
      },
    };
    expect(await executePluginHookAutomations(deferThenDeny, 'PreToolUse', input, {
      workspaceRootPath: '/workspace',
    })).toMatchObject({ decision: { decision: 'deny' } });
  });

  it('applies the documented precedence with NO policy asked for, on every ordered pair (P3.193)', async () => {
    // hooks.md#pretooluse-decision-control: "When multiple PreToolUse hooks
    // return different decisions, precedence is `deny` > `defer` > `ask` >
    // `allow`."
    //
    // This asserts the ONLY ordering there is — the `decisionMergePolicy`
    // option is gone (P3.256); it used to say "the DEFAULT" — because
    // that is what a `claude-runtime` and a `codex` session got: `'strict'` was
    // requested only inside `SessionManager`'s `provider === 'pi'` arm, so the
    // page's rule held on one runtime of three and the other two ran
    // last-writer-wins-except-deny. Each PAIR is its own case on purpose: a
    // single assertion over the whole chain passes while one pair is inverted.
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash' };
    const twoHooks = (first: string, second: string) => ({
      automations: {
        PreToolUse: [{
          matcher: 'Bash',
          actions: [
            { type: 'decision' as const, decision: first as never, reason: `r-${first}` },
            { type: 'decision' as const, decision: second as never, reason: `r-${second}` },
          ],
        }],
      },
    });
    // [earlier, later, winner] — every ordered pair of distinct ranks, both ways
    // round, so `defer` vs `ask` cannot be right while `ask` vs `allow` is wrong.
    const pairs: Array<[string, string, string]> = [
      ['deny', 'defer', 'deny'], ['defer', 'deny', 'deny'],
      ['deny', 'ask', 'deny'], ['ask', 'deny', 'deny'],
      ['deny', 'allow', 'deny'], ['allow', 'deny', 'deny'],
      ['defer', 'ask', 'defer'], ['ask', 'defer', 'defer'],
      ['defer', 'allow', 'defer'], ['allow', 'defer', 'defer'],
      ['ask', 'allow', 'ask'], ['allow', 'ask', 'ask'],
    ];
    for (const [first, second, winner] of pairs) {
      const merged = await executePluginHookAutomations(twoHooks(first, second), 'PreToolUse', input, {
        workspaceRootPath: '/workspace',
      });
      expect({ first, second, decision: String(merged.decision?.decision) }).toEqual({ first, second, decision: winner });
      // The reason belongs to the decision that won. Both former merges took
      // the LATER hook's reason unconditionally, so an outranking earlier deny
      // was shown to Claude with an unrelated hook's sentence.
      expect({ first, second, reason: merged.decision?.reason }).toEqual({ first, second, reason: `r-${winner}` });
    }
    // Equal rank stays last-writer-wins, which is the pre-`defer` behaviour the
    // page's `>` does not overturn.
    const askThenAsk = await executePluginHookAutomations(twoHooks('ask', 'ask'), 'PreToolUse', input, {
      workspaceRootPath: '/workspace',
    });
    expect(askThenAsk.decision).toMatchObject({ decision: 'ask', reason: 'r-ask' });
  });

  it('orders across all four hook tiers, and asking for a policy changes nothing (P3.193)', async () => {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash' };
    const allowConfig = {
      automations: {
        PreToolUse: [{
          matcher: 'Bash',
          actions: [{ type: 'decision' as const, decision: 'allow' as const }],
        }],
      },
    };
    const nativeSystem = {
      async executeAgentEvent() {
        return { matchedCount: 1, decision: { decision: 'ask' as const, reason: 'native review' } };
      },
    };
    // Native `ask` first, then three tiers of `allow`: the ask has to survive
    // all three. This is the shape the four-way `mergeExecutionResults` nest
    // produces on every event.
    const acrossLayers = new PluginScopedAutomationSystem({
      nativeSystem,
      userGlobalHookConfig: allowConfig,
      projectHookConfig: allowConfig,
      pluginHookConfig: allowConfig,
      workspaceRootPath: '/workspace',
    });
    expect(await acrossLayers.executeAgentEvent('PreToolUse', input)).toMatchObject({
      matchedCount: 4,
      decision: { decision: 'ask', reason: 'native review' },
    });

    // The `decisionMergePolicy: 'strict'` twin of the rig above is GONE with the
    // field (P3.256). Once the option selected nothing, that assertion compared
    // a construction to an identical construction — a dead control that passes
    // by construction and can never catch the regression it named.

    const scoped = new PluginScopedAutomationSystem({
      nativeSystem,
      userGlobalHookConfig: allowConfig,
      projectHookConfig: allowConfig,
      pluginHookConfig: {
        automations: {
          PreToolUse: [{
            matcher: 'Bash',
            actions: [{ type: 'decision', decision: 'deny', reason: 'deny floor' }],
          }],
        },
      },
      workspaceRootPath: '/workspace',
    });
    expect(await scoped.executeAgentEvent('PreToolUse', input)).toMatchObject({
      matchedCount: 4,
      decision: { decision: 'deny', reason: 'deny floor' },
    });
  });

  it('declares no second hook-decision vocabulary in the plugin-facing types (P3.196)', () => {
    // `plugins/types.ts` carried a fourth `permissionDecision` union — three
    // valued, `'allow' | 'deny' | 'ask'`, read by nothing, and re-exported
    // wholesale by `plugins/index.ts`. It was the type surface of the deleted
    // `hooks-runtime.ts` executor, and its missing member was `defer` — the one
    // P3.176/P3.193 spent two rows restoring. The live vocabulary is
    // `PreToolUseDecisionValue` in `automations/types.ts`.
    const source = readFileSync(new URL('../types.ts', import.meta.url), 'utf-8');
    // Positive control: this read really does see the file's declarations.
    expect(source).toContain('export interface PluginHookDescriptor');
    expect(source).not.toMatch(/^\s*permissionDecision\??:/m);
    expect(source).not.toContain('PluginHookOutputDecision {');
  });

  // --- R64: the merge carries every decision field, not a hand-written list ---

  it('two SessionStart layers merge without losing a single documented field', async () => {
    // The whole reason `reloadSkills` could demo perfectly and do nothing:
    // `mergeExecutionResults` nests four sources on EVERY event, so a decision
    // survived untouched only while exactly one source produced one. One
    // imported plugin bundle plus one user-global hook — the ordinary case —
    // rebuilt the object from an explicit seven-field list and dropped the rest.
    const userGlobal = {
      automations: {
        SessionStart: [{
          id: 'global',
          actions: [{
            type: 'command' as const,
            command: emitHookJson({
              hookEventName: 'SessionStart',
              additionalContext: 'from global',
              reloadSkills: true,
              watchPaths: ['/repo/skills'],
            }),
            blockOnNonZero: false,
          }],
        }],
      },
    };
    const pluginHookConfig = {
      automations: {
        SessionStart: [{
          id: 'bundle',
          actions: [{
            type: 'command' as const,
            command: emitHookJson({
              hookEventName: 'SessionStart',
              additionalContext: 'from bundle',
              sessionTitle: 'auth-refactor',
              initialUserMessage: 'review the diff',
            }),
            blockOnNonZero: false,
          }],
        }],
      },
    };
    const scoped = new PluginScopedAutomationSystem({
      userGlobalHookConfig: userGlobal,
      pluginHookConfig,
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
    });

    const result = await scoped.executeAgentEvent('SessionStart', {
      hook_event_name: 'SessionStart',
      source: 'startup',
    });

    expect(result.matchedCount).toBe(2);
    expect(result.decision).toEqual({
      // hooks.md:918 — "When several hooks return `additionalContext` for the
      // same event, Claude receives all of the values."
      additionalContext: 'from global\n\nfrom bundle',
      reloadSkills: true,
      watchPaths: ['/repo/skills'],
      sessionTitle: 'auth-refactor',
      initialUserMessage: 'review the diff',
    });
  }, 20_000);

  it('honours reloadSkills from a SessionStart hook that wrote to stderr and exited 0', async () => {
    // hooks.md:1087, the second sentence of the page's own worked example —
    // "Stderr from a SessionStart hook that exits 0 is informational only, so
    // the `reloadSkills` request still applies." The example's `git clone`
    // fails and prints `fatal:` on purpose.
    const config = {
      automations: {
        SessionStart: [{
          id: 'team-skills',
          actions: [{
            type: 'command' as const,
            command: nodeCommand('process.stderr.write("fatal: repository not found"); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: true } }))'),
            blockOnNonZero: false,
          }],
        }],
      },
    };

    const result = await executePluginHookAutomations(config, 'SessionStart', {
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect(result.decision).toEqual({ reloadSkills: true });
  }, 20_000);

  it('two WorktreeCreate hooks still yield a path (the pre-fix merge yielded none)', async () => {
    // Measured on the pre-fix code: `{}`. Both paths were dropped, so the
    // worktree got no path at all — a live loss with no new field involved.
    const config = {
      automations: {
        WorktreeCreate: [
          {
            id: 'first',
            actions: [{
              type: 'command' as const,
              command: nodeCommand('process.stdout.write("/repo/worktrees/first")'),
              blockOnNonZero: false,
            }],
          },
          {
            id: 'second',
            actions: [{
              type: 'command' as const,
              command: nodeCommand('process.stdout.write("/repo/worktrees/second")'),
              blockOnNonZero: false,
            }],
          },
        ],
      },
    };

    const result = await executePluginHookAutomations(config, 'WorktreeCreate', {
      hook_event_name: 'WorktreeCreate',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    // Last writer wins, the same rule `updatedInput`/`updatedToolOutput` had.
    expect(result.decision).toEqual({ worktreePath: '/repo/worktrees/second' });
  }, 20_000);

  it('an elicitation accept survives a second hook that only adds context', async () => {
    // Also measured on the pre-fix code: the accept and its form values were
    // gone and only `additionalContext` came back, so the dialog opened anyway.
    const config = {
      automations: {
        McpElicitation: [
          {
            id: 'answers',
            actions: [{
              type: 'command' as const,
              // UB12.99 — a Claude-contract hook reads and prints Claude's spelling.
              command: emitHookJson({ hookEventName: 'Elicitation', action: 'accept', content: { branch: 'main' } }),
              blockOnNonZero: false,
            }],
          },
          {
            // UB12.101 — a NATIVE hook: Claude's Elicitation branch carries
            // `action` and `content` only, so a Claude-contract hook's
            // `additionalContext` there is not applied. The fork's own contract
            // keeps it (the McpElicitation surface), which is the merge this
            // test is about.
            id: 'annotates',
            actions: [{
              type: 'command' as const,
              command: emitHookJson({ hookEventName: 'McpElicitation', additionalContext: 'answered by policy' }),
            }],
          },
        ],
      },
    };

    const result = await executePluginHookAutomations(config, 'McpElicitation', {
      hook_event_name: 'McpElicitation',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect(result.decision).toEqual({
      elicitationAction: 'accept',
      elicitationContent: { branch: 'main' },
      additionalContext: 'answered by policy',
    });
  }, 20_000);

  it('a decline that wins the merge does not carry the accepting hook values', async () => {
    // The parser keeps `content` accept-only; the merge has to keep that true or
    // a decline ships the other hook's form values to the MCP server.
    const config = {
      automations: {
        McpElicitation: [
          {
            id: 'accepts',
            actions: [{
              type: 'command' as const,
              // UB12.99 — a Claude-contract hook reads and prints Claude's spelling.
              command: emitHookJson({ hookEventName: 'Elicitation', action: 'accept', content: { branch: 'main' } }),
              blockOnNonZero: false,
            }],
          },
          {
            id: 'declines',
            actions: [{
              type: 'command' as const,
              command: emitHookJson({ hookEventName: 'Elicitation', action: 'decline' }),
              blockOnNonZero: false,
            }],
          },
        ],
      },
    };

    const result = await executePluginHookAutomations(config, 'McpElicitation', {
      hook_event_name: 'McpElicitation',
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect(result.decision).toEqual({ elicitationAction: 'decline' });
  }, 20_000);

  it('drops a SessionStart sessionTitle on the two sources the page excludes', async () => {
    // hooks.md:1060 — "Applies when `source` is `"startup"`, `"resume"`, or
    // `"fork"`; ignored on `"clear"` and `"compact"`".
    const config = {
      automations: {
        SessionStart: [{
          id: 'namer',
          actions: [{
            type: 'command' as const,
            command: emitHookJson({
              hookEventName: 'SessionStart', sessionTitle: 'auth-refactor', additionalContext: 'branch info',
            }),
            blockOnNonZero: false,
          }],
        }],
      },
    };
    const run = (source: string) => executePluginHookAutomations(config, 'SessionStart', {
      hook_event_name: 'SessionStart',
      source,
    }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

    expect((await run('resume')).decision).toMatchObject({ sessionTitle: 'auth-refactor' });
    expect((await run('compact')).decision).toEqual({ additionalContext: 'branch info' });
    expect((await run('clear')).decision).toEqual({ additionalContext: 'branch info' });
  }, 30_000);

  // "keeps untrusted plugin hooks out of the Claude SDK hooks path" retired with
  // the V1 registration gate (F4): it asserted that an untrusted hook produced no
  // config, so `buildSdkHooks` had nothing to expose. On the one remaining path a
  // registration only exists after the resolver granted trust, so the "untrusted"
  // input no longer has a representation here; the gate is the resolver's and the
  // trust store's, and `runtime-automations.test.ts` pins the live half.

  it('runs relative plugin hook cwd from the installed plugin execution root', async () => {
    const executionRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-hook-root-'));
    try {
      mkdirSync(join(executionRoot, 'hooks'), { recursive: true });
      const hookRecord = hook({
        event: 'PreToolUse',
        command: nodeCommand('process.stdout.write(JSON.stringify({ additionalContext: process.cwd() }))'),
        cwd: './hooks/',
        executionRoot,
      });
      const config = automationsFor([hookRecord]);

      const result = await executePluginHookAutomations(config, 'PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      }, { workspaceRootPath: '/workspace', allowDirectCommandRunner: true });

      expect(result).toEqual({
        matchedCount: 1,
        decision: {
          additionalContext: realpathSync(join(executionRoot, 'hooks')),
        },
        // D1.354 — the run, with the stdout the decision above was read from.
        hookRuns: [{
          runtime: 'host',
          event: 'PreToolUse',
          name: 'toolkit/hook',
          outcome: 'success',
          exitCode: 0,
          stdout: JSON.stringify({ additionalContext: realpathSync(join(executionRoot, 'hooks')) }),
        }],
      });
    } finally {
      rmSync(executionRoot, { recursive: true, force: true });
    }
  });

  it('rejects plugin hook cwd that escapes the execution root', () => {
    const hookRecord = hook({
      event: 'PreToolUse',
      command: nodeCommand('process.exit(0)'),
      cwd: '../outside',
      executionRoot: '/cache/internal/toolkit/1.0.0/normalized',
    });

    const result = automationsFor([hookRecord]);

    expect(result.automations.PreToolUse).toBeUndefined();
  });

  // W6 Step 6: the workspace-hook exactly-once invariant — STRUCTURAL since F1.10.
  //
  // PluginScopedAutomationSystem.buildSdkHooks() merges the native system's
  // buildSdkHooks() AND its own separately-loaded workspaceHookConfig. This
  // tripwire used to pin the workspace facade's buildSdkHooks() as an empty
  // stub, because a filled one would have registered every workspace hook
  // twice. F1.10 (D1.366) removed that stub and the rest of the agent-event
  // surface from the facade, so it is no longer an AgentAutomationSystem and
  // cannot be handed in as a `nativeSystem` at all: the workspace hooks come
  // from exactly one source (workspaceHookConfig). The guard is now the type
  // (the `@ts-expect-error` below fails typecheck the day the facade becomes
  // assignable again) plus the same fact read off the object at runtime.
  it('the workspace AutomationSystem cannot be a nativeSystem, so workspace hooks cannot double-register (W6, F1.10)', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-native-hooks-'));
    try {
      const system = new AutomationSystem({ workspaceRootPath, workspaceId: 'ws-native' });
      // @ts-expect-error — F1.10: the workspace facade carries no agent-event method.
      const asNative: AgentAutomationSystem = system;
      expect(['executeAgentEvent', 'hasAgentEventMatchers', 'buildSdkHooks'].filter(name => name in asNative)).toEqual([]);
      await system.dispose();
    } finally {
      rmSync(workspaceRootPath, { recursive: true, force: true });
    }
  });

  it('wraps native automations without rerouting them', async () => {
    const hookRecord = hook({
      event: 'PreToolUse',
      command: nodeCommand('process.stdout.write(JSON.stringify({ decision: "block", reason: "plugin" }))'),
    });
    const config = automationsFor([hookRecord]);
    const nativeSystem: AgentAutomationSystem = {
      async executeAgentEvent() {
        return { matchedCount: 2, decision: { additionalContext: 'native' } };
      },
      buildSdkHooks() {
        return { PreToolUse: [] };
      },
    };
    const scoped = new PluginScopedAutomationSystem({
      nativeSystem,
      pluginHookConfig: config,
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
    });

    expect(scoped.buildSdkHooks().PreToolUse).toHaveLength(1);
    await expect(scoped.executeAgentEvent('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    })).resolves.toEqual({
      matchedCount: 3,
      decision: {
        decision: 'block',
        additionalContext: 'native',
        reason: 'plugin',
      },
      // D1.354 — and the MERGE carries it: the native arm above publishes no
      // runs at all and the plugin tier publishes one, so a `mergeExecutionResults`
      // that dropped the field would answer with no `hookRuns` key here while
      // every other field of this exact-shape comparison stayed right.
      hookRuns: [{
        runtime: 'host',
        event: 'PreToolUse',
        name: 'toolkit/hook',
        outcome: 'success',
        exitCode: 0,
        stdout: JSON.stringify({ decision: 'block', reason: 'plugin' }),
      }],
    });
  });

  /**
   * D6/D8 — the two runners that fired and dropped the answer.
   *
   * hooks.md § HTTP response handling and § MCP tool hook fields both say the
   * body is read as command-hook stdout, so these assert the verdict lands on
   * the SAME decision surface a command hook's stdout lands on.
   */
  describe('the http and mcp_tool runners return a decision', () => {
    const httpConfig = (event: string, url = 'https://example.invalid/policy') => ({
      automations: { [event]: [{ id: 'policy', actions: [{ type: 'plugin-http' as const, http: { url } }] }] },
    });
    const mcpConfig = (event: string) => ({
      automations: { [event]: [{ id: 'scan', actions: [{ type: 'plugin-mcp-tool' as const, mcpTool: 'mcp__policy__check' }] }] },
    });

    it('blocks a tool call when an http hook answers deny', async () => {
      const result = await executePluginHookAutomations(httpConfig('PreToolUse'), 'PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl evil' },
      }, {
        workspaceRootPath: process.cwd(),
        httpRunner: async () => ({
          body: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'egress is not allowed from this workspace',
            },
          }),
        }),
      });
      expect(result.decision?.decision).toBe('deny');
      expect(result.decision?.reason).toBe('egress is not allowed from this workspace');
      expect(result.hookErrors).toBeUndefined();
    });

    it('carries an mcp_tool hook context into the turn', async () => {
      const result = await executePluginHookAutomations(mcpConfig('PostToolUse'), 'PostToolUse', {
        hook_event_name: 'PostToolUse', tool_name: 'Write',
      }, {
        workspaceRootPath: process.cwd(),
        mcpToolRunner: async () => ({
          body: JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'This file is generated.' },
          }),
        }),
      });
      expect(result.decision?.additionalContext).toBe('This file is generated.');
    });

    it('stays inert on an event whose documented surface carries no decision', async () => {
      const result = await executePluginHookAutomations(httpConfig('Notification'), 'Notification', {
        hook_event_name: 'Notification', notification_type: 'idle_prompt',
      }, {
        workspaceRootPath: process.cwd(),
        httpRunner: async () => ({ body: JSON.stringify({ decision: 'block', reason: 'no' }) }),
      });
      expect(result.decision).toBeUndefined();
      expect(result.hookErrors).toBeUndefined();
    });

    it('reports a failed call as the documented non-blocking error', async () => {
      const result = await executePluginHookAutomations(httpConfig('PreToolUse'), 'PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash',
      }, {
        workspaceRootPath: process.cwd(),
        httpRunner: async () => ({ failed: true, code: 'http-hook-error' }),
      });
      expect(result.decision).toBeUndefined();
      expect(result.hookErrors).toEqual([
        { hookName: 'policy', event: 'PreToolUse', exitCode: null, summary: 'http-hook-error' },
      ]);
    });

    it('fails closed on a decision event when the answer cannot be read, and is inert elsewhere', async () => {
      const truncated = '{"decision":"block","reason":"partial';
      const deciding = await executePluginHookAutomations(httpConfig('PreToolUse'), 'PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash',
      }, { workspaceRootPath: process.cwd(), httpRunner: async () => ({ body: truncated }) });
      expect(deciding.decision?.decision).toBe('block');
      expect(deciding.hookErrors?.[0]?.summary).toBe('http-hook-response-unreadable');

      const observational = await executePluginHookAutomations(mcpConfig('Notification'), 'Notification', {
        hook_event_name: 'Notification', notification_type: 'idle_prompt',
      }, { workspaceRootPath: process.cwd(), mcpToolRunner: async () => ({ body: truncated }) });
      expect(observational.decision).toBeUndefined();
      expect(observational.hookErrors?.[0]?.summary).toBe('mcp_tool-hook-response-unreadable');
    });

    /**
     * UB12.51 — hooks.md § HTTP response handling: "2xx with any other body,
     * such as plain text: non-blocking error, handled the same as a non-2xx
     * status. Claude Code doesn't add the text to Claude's context". This arm
     * used to assert the opposite (the text became `additionalContext`).
     */
    it('reports an http plain-text body as the non-2xx notice and adds nothing to the context', async () => {
      const promptInput = { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' } as const;
      for (const body of ['ok', 'The deployment target is staging.', '["a JSON array is plain text"]', '"a quoted string"']) {
        const result = await executePluginHookAutomations(httpConfig('UserPromptSubmit'), 'UserPromptSubmit', promptInput, {
          workspaceRootPath: process.cwd(), httpRunner: async () => ({ body }),
        });
        expect(result.decision).toBeUndefined();
        expect(result.hookErrors).toEqual([
          { hookName: 'policy', event: 'UserPromptSubmit', exitCode: null, summary: 'http-hook-error' },
        ]);
        // `/hooks` agrees with the transcript: the run is an error with the same code.
        expect(result.hookRuns).toEqual([
          { runtime: 'host', event: 'UserPromptSubmit', name: 'policy', outcome: 'error', stderr: 'http-hook-error' },
        ]);
      }

      // The same on an event that never took stdout as context: no silent drop.
      const observational = await executePluginHookAutomations(httpConfig('PostToolUse'), 'PostToolUse', {
        hook_event_name: 'PostToolUse', tool_name: 'Write',
      }, { workspaceRootPath: process.cwd(), httpRunner: async () => ({ body: 'just a log line' }) });
      expect(observational.decision).toBeUndefined();
      expect(observational.hookErrors?.map(notice => notice.summary)).toEqual(['http-hook-error']);
    });

    it('still lands an http JSON body\'s additionalContext, and a blank body stays a clean run', async () => {
      const promptInput = { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' } as const;
      const answered = await executePluginHookAutomations(httpConfig('UserPromptSubmit'), 'UserPromptSubmit', promptInput, {
        workspaceRootPath: process.cwd(),
        httpRunner: async () => ({
          body: JSON.stringify({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'The deployment target is staging.' },
          }),
        }),
      });
      expect(answered.decision?.additionalContext).toBe('The deployment target is staging.');
      expect(answered.hookErrors).toBeUndefined();

      // "2xx with an empty body: success" — whitespace is still empty, not plain text.
      const blank = await executePluginHookAutomations(httpConfig('UserPromptSubmit'), 'UserPromptSubmit', promptInput, {
        workspaceRootPath: process.cwd(), httpRunner: async () => ({ body: ' \n' }),
      });
      expect(blank.decision).toBeUndefined();
      expect(blank.hookErrors).toBeUndefined();
    });

    it('keeps an mcp_tool hook\'s plain text on the stdout-context gate', async () => {
      // hooks.md § MCP tool hook fields: the tool's text is read "the same way
      // it reads command-hook stdout" — the http change above is http's alone.
      const contextual = await executePluginHookAutomations(mcpConfig('UserPromptSubmit'), 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit', prompt: 'ship it',
      }, { workspaceRootPath: process.cwd(), mcpToolRunner: async () => ({ body: 'The deployment target is staging.' }) });
      expect(contextual.decision?.additionalContext).toBe('The deployment target is staging.');
      expect(contextual.hookErrors).toBeUndefined();

      const quiet = await executePluginHookAutomations(mcpConfig('PostToolUse'), 'PostToolUse', {
        hook_event_name: 'PostToolUse', tool_name: 'Write',
      }, { workspaceRootPath: process.cwd(), mcpToolRunner: async () => ({ body: 'just a log line' }) });
      expect(quiet.decision).toBeUndefined();
      expect(quiet.hookErrors).toBeUndefined();
    });

    it('honors universal continue: false from either runner', async () => {
      const result = await executePluginHookAutomations(mcpConfig('PreToolUse'), 'PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash',
      }, {
        workspaceRootPath: process.cwd(),
        mcpToolRunner: async () => ({ body: JSON.stringify({ continue: false, stopReason: 'policy stop' }) }),
      });
      expect(result.universal).toEqual({ continue: false, stopReason: 'policy stop' });
      expect(result.decision?.decision).toBe('block');
    });

    it('lets a non-Pi command hook read the documented payload on stdin', async () => {
      // The `allowDirectCommandRunner` wiring — every provider except Pi,
      // nestor-cloud included. hooks.md's own blocking example is `input=$(cat)`
      // plus a `.tool_input.command` read, so that is what this runs.
      const config = {
        automations: {
          PreToolUse: [{
            id: 'validator',
            actions: [{
              type: 'command' as const,
              command: process.execPath,
              args: ['-e', `
                let raw = '';
                process.stdin.on('data', chunk => { raw += chunk; });
                process.stdin.on('end', () => {
                  const input = JSON.parse(raw);
                  if (String(input.tool_input.command).startsWith('rm')) {
                    console.log(JSON.stringify({
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: 'rm is not allowed',
                      },
                    }));
                  }
                });
              `],
            }],
          }],
        },
      };

      const result = await executePluginHookAutomations(config, 'PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' },
      }, { workspaceRootPath: process.cwd(), allowDirectCommandRunner: true });

      expect(result.decision).toEqual({ decision: 'deny', reason: 'rm is not allowed' });
    });

    it('keeps a runner that answers nothing observational', async () => {
      const result = await executePluginHookAutomations(httpConfig('PreToolUse'), 'PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash',
      }, { workspaceRootPath: process.cwd(), httpRunner: async () => { /* no answer */ } });
      expect(result).toEqual({ matchedCount: 1, hookRuns: [{ runtime: 'host', event: 'PreToolUse', name: 'policy', outcome: 'success' }] }); // F1.9: an answer of nothing is a run that worked
    });
  });
});

/**
 * `profiles` maps a plugin id to the runtime-compatibility profiles its
 * installed manifest declares. The plan's `activeCapabilities` is where that
 * survives to (the hook record does not carry it), so a test that cares about
 * the plugin's dialect has to populate it — the default is a plan with none,
 * which reads as the stricter Claude budgets.
 */
/**
 * Build the plugin tier's automations config from hook registrations, through
 * the ONE production builder (`capabilities/runtime-automations.ts`). This used
 * to go through the projection-path twin `buildTrustedPluginHookAutomations`,
 * which F4 deleted along with the V1 plan it read.
 */
function automationsFor(hooks: RuntimeHookRegistration[]): AutomationsConfig {
  return buildPluginHookAutomations(hooks);
}

function hook(options: {
  pluginId?: string;
  hookId?: string;
  event: string;
  type?: RuntimeHookRegistration['type'];
  command?: string;
  args?: string[];
  statusMessage?: string;
  cwd?: string;
  timeoutMs?: number;
  matcher?: string;
  executionRoot?: string;
  profile?: PluginRuntimeCompatibilityProfile;
  async?: boolean;
  asyncRewake?: boolean;
  exitCodeContract?: 'claude-three-way';
  shell?: 'bash' | 'powershell';
  once?: boolean;
  ifRule?: string;
  model?: string;
  continueOnBlock?: boolean;
  prompt?: string;
  agentName?: string;
  mcpTool?: string;
  mcpArgs?: Record<string, unknown>;
  http?: RuntimeHookRegistration['http'];
}): RuntimeHookRegistration {
  const pluginId = options.pluginId ?? 'toolkit';
  const hookId = options.hookId ?? 'hook';
  const version = '1.0.0';
  const pluginInstanceId = `plugin://internal/${pluginId}@${version}#${'a'.repeat(64)}`;
  return {
    key: `${pluginId}/${hookId}`,
    pluginInstanceId,
    resource: { pluginInstanceId, relativePath: `hooks/${hookId}.json`, contentHash: 'c'.repeat(64) },
    executableHash: 'e'.repeat(64),
    event: options.event,
    type: options.type ?? 'command',
    ...(options.executionRoot
      ? {
          pluginRuntime: {
            rootPath: options.executionRoot,
            dataPath: join(options.executionRoot, '.data'),
            profile: options.profile ?? 'claude-plugin-env-v1',
          },
        }
      : options.profile
        ? { pluginRuntime: { rootPath: '/plugins/bundle', dataPath: '/plugins/data', profile: options.profile } }
        : {}),
    ...(options.matcher ? { matcher: options.matcher } : {}),
    ...(options.command ? { command: options.command } : {}),
    ...(options.args ? { args: options.args } : {}),
    ...(options.statusMessage ? { statusMessage: options.statusMessage } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.async ? { async: true } : {}),
    ...(options.asyncRewake ? { asyncRewake: true } : {}),
    ...(options.exitCodeContract ? { exitCodeContract: options.exitCodeContract } : {}),
    ...(options.shell ? { shell: options.shell } : {}),
    ...(options.once ? { once: true } : {}),
    ...(options.ifRule ? { ifRule: options.ifRule } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.continueOnBlock !== undefined ? { continueOnBlock: options.continueOnBlock } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(options.agentName ? { agentName: options.agentName } : {}),
    ...(options.mcpTool ? { mcpTool: options.mcpTool } : {}),
    ...(options.mcpArgs ? { mcpArgs: options.mcpArgs } : {}),
    ...(options.http ? { http: options.http } : {}),
  };
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/**
 * A command hook that prints one documented `hookSpecificOutput` object.
 *
 * The script must stay on ONE line: `nodeCommand` JSON-escapes it, and a shell
 * hands the escaped `\n` to the interpreter verbatim, which is a syntax error
 * rather than a newline. A multi-line script therefore produces a hook that
 * exits non-zero and decides nothing — which reads exactly like a merge that
 * dropped the field.
 */
function emitHookJson(hookSpecificOutput: Record<string, unknown>): string {
  return nodeCommand(`process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput }))})`);
}
