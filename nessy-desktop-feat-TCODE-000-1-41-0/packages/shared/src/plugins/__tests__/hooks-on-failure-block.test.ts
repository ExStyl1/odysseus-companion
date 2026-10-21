/**
 * UB12.67 — `onFailure: "block"` on a `command` or `http` hook.
 *
 * `hooks.md#block-the-action-when-a-hook-fails` (curl'd 2026-10-16), verbatim:
 * "To block the action instead, set `"onFailure": "block"` on a `command` or
 * `http` hook. The default value is `"continue"`." — "With `"block"` set, a
 * failure does what exit code 2 does on that event, except on
 * `PermissionRequest`, where it denies the request." — and "The field has no
 * effect on these hooks: `Stop`, `SubagentStop`, `TaskCompleted`, and
 * `TeammateIdle` hooks … Background command hooks".
 *
 * The premise at HEAD (`ca0e496d8`): the field was read nowhere — not by the
 * Claude adapter, the plugin manifest reader, the action builder, the native
 * hooks schema or the executor — so every such hook failed OPEN on the host
 * executor. Each describe below holds one of those stops, with a control that
 * fails if the stop goes back to dropping the field. The real-runner arm
 * (a loopback sink answering 503) is in server-core's
 * `SessionManager.plugin-hook-runners.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePluginHookAutomations, type PluginHttpHookRunner } from '../hooks-automation.ts';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import { buildPluginHookAutomations } from '../../capabilities/runtime-automations.ts';
import { parseHooksConfigContent } from '../../automations/hooks-config.ts';
import type { AgentEvent, AutomationsConfig, HookCommandAction, HookCommandActionResult, PluginHttpHookAction } from '../../automations/types.ts';
import type { RuntimeHookRegistration } from '../../capabilities/resolver.ts';
import type { PluginOrigin } from '../types.ts';

const workspaceRootPath = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), 'nessy-ub12-67-'));
afterAll(() => { rmSync(tempDir, { recursive: true, force: true }); });

const HEADLINE = 'blocking because onFailure is "block"';

function commandConfig(event: AgentEvent, action: Partial<HookCommandAction>): AutomationsConfig {
  return {
    automations: {
      [event]: [{ id: 'policy/guard', name: 'policy/guard', actions: [{ type: 'command', command: './guard.sh', blockOnNonZero: false, ...action }] }],
    },
  } as unknown as AutomationsConfig;
}

function httpConfig(event: AgentEvent, action: Partial<PluginHttpHookAction>): AutomationsConfig {
  return {
    automations: {
      [event]: [{ id: 'policy/gate', name: 'policy/gate', actions: [{ type: 'plugin-http', http: { url: 'https://policy.example.test/gate' }, ...action }] }],
    },
  } as unknown as AutomationsConfig;
}

function run(over: Partial<HookCommandActionResult>): HookCommandActionResult {
  return { type: 'command', command: './guard.sh', success: true, exitCode: 0, signal: null, durationMs: 1, ...over };
}

const exit1 = run({ success: false, exitCode: 1, stderr: 'guard crashed' });

function inputFor(event: AgentEvent) {
  return event === 'PreToolUse' || event === 'PermissionRequest'
    ? { hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'ls' } }
    : { hook_event_name: event };
}

async function fireCommand(event: AgentEvent, action: Partial<HookCommandAction>, result: HookCommandActionResult, signal?: AbortSignal) {
  return executePluginHookAutomations(commandConfig(event, action), event, inputFor(event), {
    workspaceRootPath,
    runner: async () => result,
    ...(signal ? { signal } : {}),
  });
}

async function fireHttp(event: AgentEvent, action: Partial<PluginHttpHookAction>, httpRunner?: PluginHttpHookRunner) {
  return executePluginHookAutomations(httpConfig(event, action), event, inputFor(event), {
    workspaceRootPath,
    ...(httpRunner ? { httpRunner } : {}),
  });
}

describe('UB12.67 — the executor: a failed command hook with onFailure "block"', () => {
  it('POSITIVE: an exit-1 PreToolUse hook blocks the tool call with the page\'s message, and its notice stays', async () => {
    const result = await fireCommand('PreToolUse', { onFailure: 'block' }, exit1);
    expect(result.decision?.decision).toBe('block');
    expect(result.decision?.reason).toBe(`[./guard.sh]: failed; ${HEADLINE}\nguard crashed`);
    expect(result.hookErrors?.map(notice => notice.summary)).toEqual(['guard crashed']);
  });

  it('NEGATIVE: without the field the same exit 1 is the non-blocking error it always was', async () => {
    const result = await fireCommand('PreToolUse', {}, exit1);
    expect(result.decision?.decision).toBeUndefined();
    expect(result.hookErrors?.map(notice => notice.summary)).toEqual(['guard crashed']);
  });

  it('a timeout says "timed out", and the exec-form args are part of the subject', async () => {
    const result = await fireCommand('PreToolUse', { command: 'node', args: ['check-command.js'], onFailure: 'block' },
      run({ success: false, exitCode: null, timedOut: true, error: 'Hook command timed out after 5000ms.' }));
    expect(result.decision?.decision).toBe('block');
    expect(result.decision?.reason).toStartWith(`[node check-command.js]: timed out; ${HEADLINE}`);
  });

  it('BOUNDARY: exit 2 is the blocking error, not a failure — its own stderr stays the reason', async () => {
    const result = await fireCommand('PreToolUse', { onFailure: 'block' }, run({ success: false, exitCode: 2, stderr: 'rm is not allowed' }));
    expect(result.decision).toMatchObject({ decision: 'block', reason: 'rm is not allowed' });
  });

  it('exit 0 with JSON that cannot be parsed is a failure; exit 0 with plain text is not', async () => {
    const unreadable = await fireCommand('PreToolUse', { onFailure: 'block' }, run({ stdout: '{"decision": ' }));
    expect(unreadable.decision?.decision).toBe('block');
    expect(unreadable.decision?.reason).toStartWith(`[./guard.sh]: failed; ${HEADLINE}`);
    const plain = await fireCommand('PreToolUse', { onFailure: 'block' }, run({ stdout: 'all good' }));
    expect(plain.decision?.decision).toBeUndefined();
  });

  it('a hook its runner refused to start blocks a UserPromptSubmit prompt (F1.863 would let it through)', async () => {
    const refused = run({ success: false, exitCode: null, refusedBeforeStart: true, error: 'Command hook not run: denied by rule' });
    const blocked = await fireCommand('UserPromptSubmit', { onFailure: 'block' }, refused);
    expect(blocked.decision?.decision).toBe('block');
    const control = await fireCommand('UserPromptSubmit', {}, refused);
    expect(control.decision?.decision).toBeUndefined();
  });

  it('PermissionRequest is DENIED, the page\'s one exception to "what exit 2 does"', async () => {
    const result = await fireCommand('PermissionRequest', { onFailure: 'block' }, exit1);
    expect(result.decision?.decision).toBe('deny');
  });

  it('no effect on Stop, on a background hook, on a context-only event, or on a stopped turn', async () => {
    expect((await fireCommand('Stop', { onFailure: 'block' }, exit1)).decision?.decision).toBeUndefined();
    expect((await fireCommand('PreToolUse', { onFailure: 'block', async: true }, exit1)).decision?.decision).toBeUndefined();
    const sessionStart = await fireCommand('SessionStart', { onFailure: 'block' }, exit1);
    expect(sessionStart.decision?.decision).toBeUndefined();
    expect(sessionStart.hookErrors?.length).toBe(1);
    const aborted = new AbortController();
    aborted.abort();
    expect((await fireCommand('PreToolUse', { onFailure: 'block' }, exit1, aborted.signal)).decision?.decision).toBeUndefined();
  });
});

describe('UB12.67 — the executor: a failed http hook with onFailure "block"', () => {
  it('a host refusal (UB12.50) blocks a UserPromptSubmit prompt; without the field it does not', async () => {
    const refusing: PluginHttpHookRunner = async () => ({ refused: 'permission-denied' });
    const blocked = await fireHttp('UserPromptSubmit', { onFailure: 'block' }, refusing);
    expect(blocked.decision?.decision).toBe('block');
    expect(blocked.decision?.reason).toStartWith(`[http hook]: failed; ${HEADLINE}`);
    expect((await fireHttp('UserPromptSubmit', {}, refusing)).decision?.decision).toBeUndefined();
  });

  it('a timeout says "timed out"; a 2xx plain-text body is a failure too', async () => {
    const timedOut = await fireHttp('PreToolUse', { onFailure: 'block' }, async () => ({ failed: true, code: 'http-hook-timeout' }));
    expect(timedOut.decision?.reason).toStartWith(`[http hook]: timed out; ${HEADLINE}`);
    const plain = await fireHttp('PreToolUse', { onFailure: 'block' }, async () => ({ body: 'ok' }));
    expect(plain.decision?.decision).toBe('block');
    const empty = await fireHttp('PreToolUse', { onFailure: 'block' }, async () => ({ body: '' }));
    expect(empty.decision?.decision).toBeUndefined();
  });

  it('a hook that never started — no runner, or a guard refused its URL — blocks too', async () => {
    const noRunner = await fireHttp('PreToolUse', { onFailure: 'block' });
    expect(noRunner.decision?.decision).toBe('block');
    let sent = 0;
    const unsafe = await fireHttp('PreToolUse', { onFailure: 'block', http: { url: 'file:///etc/hosts' } }, async () => { sent++; return { body: '' }; });
    expect(sent).toBe(0);
    expect(unsafe.decision?.decision).toBe('block');
    expect((await fireHttp('PreToolUse', {})).decision?.decision).toBeUndefined();
  });
});

describe('UB12.67 — the field reaches the executor from every tier that declares it', () => {
  function origin(): PluginOrigin {
    return { source: 'local-path', localPath: tempDir, resolvedAt: 1 };
  }

  it('the Claude adapter keeps "block" on command and http hooks, drops the default, and refuses a typo', async () => {
    const bundle = join(tempDir, 'claude-on-failure');
    mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
    mkdirSync(join(bundle, 'hooks'), { recursive: true });
    writeFileSync(join(bundle, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'on-failure', version: '1.0.0' }));
    writeFileSync(join(bundle, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [
          { type: 'command', id: 'gate', command: 'node', args: ['check.js'], onFailure: 'block' },
          { type: 'http', id: 'remote', url: 'https://policy.example.test/gate', onFailure: 'block' },
          { type: 'command', id: 'lenient', command: './lenient.sh', onFailure: 'continue' },
          { type: 'command', id: 'typo', command: './typo.sh', onFailure: 'Block' },
        ] }],
      },
    }));
    const normalized = await normalizeClaudePluginBundle(bundle, origin());
    expect(normalized.ok).toBe(true);
    const hooks = (normalized.value?.capabilities ?? [])
      .filter((capability): capability is Extract<typeof capability, { kind: 'hook' }> => capability.kind === 'hook')
      .map(capability => capability.hook);
    expect(hooks.find(hook => hook.id === 'gate')?.onFailure).toBe('block');
    expect(hooks.find(hook => hook.id === 'remote')?.onFailure).toBe('block');
    expect(hooks.find(hook => hook.id === 'lenient')).toBeDefined();
    expect(hooks.find(hook => hook.id === 'lenient')?.onFailure).toBeUndefined();
    // A policy hook whose author meant "block" is refused rather than read as "continue".
    expect(hooks.find(hook => hook.id === 'typo')).toBeUndefined();
    expect(normalized.diagnostics.some(diagnostic => diagnostic.message.includes('onFailure must be "continue" or "block"'))).toBe(true);
  });

  it('the action builder carries it onto command and http actions, and not where it was never declared', () => {
    const registrations = [
      { key: 'plugin://p/hook.gate@workspace', event: 'PreToolUse', type: 'command', command: 'node', args: ['check.js'], onFailure: 'block' },
      { key: 'plugin://p/hook.remote@workspace', event: 'PreToolUse', type: 'http', http: { url: 'https://policy.example.test/gate' }, onFailure: 'block' },
      { key: 'plugin://p/hook.plain@workspace', event: 'PreToolUse', type: 'command', command: './plain.sh' },
    ] as unknown as RuntimeHookRegistration[];
    const actions = buildPluginHookAutomations(registrations).automations.PreToolUse?.flatMap(matcher => matcher.actions) ?? [];
    expect(actions.map(action => (action as { onFailure?: string }).onFailure)).toEqual(['block', 'block', undefined]);
  });

  it('a Claude-shape hooks file keeps it on a command handler and refuses a typo by path', () => {
    const parsed = parseHooksConfigContent(JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh', onFailure: 'block' }] }] },
    }), 'hooks.json');
    expect(parsed.errors).toEqual([]);
    const action = parsed.config.automations.PreToolUse?.[0]?.actions[0] as HookCommandAction | undefined;
    expect(action?.onFailure).toBe('block');
    const typo = parseHooksConfigContent(JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh', onFailure: 'Block' }] }] },
    }), 'hooks.json');
    expect(typo.errors.some(error => error.includes('onFailure'))).toBe(true);
  });
});
