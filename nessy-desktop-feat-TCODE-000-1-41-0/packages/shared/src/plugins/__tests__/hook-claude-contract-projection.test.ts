/**
 * UB12.101 — a Claude-contract hook's JSON output applies the schema's fields
 * only (the top-level ones, and the FIRED event's `hookSpecificOutput` branch),
 * and a `hookSpecificOutput` naming another event is the non-blocking error.
 *
 * The contract: hooks.md § JSON output (curl'd 2026-10-17) — `hookSpecificOutput`
 * "requires a `hookEventName` field set to the event name", and § Add context
 * for Claude — "Return `additionalContext` inside `hookSpecificOutput` alongside
 * the event name". The 2.1.280 CLI (the vendored native binary, read as the
 * measurement) strips keys its schema does not know and logs "Hook JSON output
 * had unrecognized keys (ignored)", with the hint "Did you mean
 * hookSpecificOutput.additionalContext (with a hookEventName)?" for a top-level
 * one; it reads only the named branch's fields, and throws "Hook returned
 * incorrect event name" (caught as a non-blocking error) when that name is not
 * the fired event.
 *
 * The premise at HEAD (`006e33438`), measured through `executePluginHookAutomations`
 * with `blockOnNonZero: false`: a top-level `updatedInput` on PreToolUse was
 * applied; a top-level `additionalContext` on SessionStart was applied; a
 * `continue: true` on PreToolUse was an allow; a PreToolUse branch carrying a
 * PermissionRequest `decision.behavior: "allow"` was an allow; a PreToolUse hook
 * printing the PermissionRequest branch was an allow; a PostToolUse hook
 * printing the PreToolUse branch had its context applied, with no notice.
 */
import { describe, expect, it } from 'bun:test';
import { hookStdoutJsonFailure, parseHookCommandOutput } from '../../automations/hook-command.ts';
import { executePluginHookAutomations, type PluginAsyncHookNote } from '../hooks-automation.ts';
import type { AgentEvent, AutomationsConfig, HookCommandAction, HookCommandActionResult } from '../../automations/types.ts';

const workspaceRootPath = process.cwd();
const CLAUDE_CONTRACT: Partial<HookCommandAction> = { blockOnNonZero: false };
const NATIVE: Partial<HookCommandAction> = {};

function commandConfig(event: AgentEvent, action: Partial<HookCommandAction>): AutomationsConfig {
  return {
    automations: {
      [event]: [{ id: 'policy/guard', name: 'policy/guard', actions: [{ type: 'command', command: './guard.sh', ...action }] }],
    },
  } as unknown as AutomationsConfig;
}

function exit0(stdout: string): HookCommandActionResult {
  return { type: 'command', command: './guard.sh', success: true, exitCode: 0, signal: null, durationMs: 1, stdout };
}

function inputFor(event: AgentEvent) {
  return ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure'].includes(event)
    ? { hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'ls' } }
    : { hook_event_name: event };
}

async function fireCommand(event: AgentEvent, action: Partial<HookCommandAction>, output: object) {
  return executePluginHookAutomations(commandConfig(event, action), event, inputFor(event), {
    workspaceRootPath,
    runner: async () => exit0(JSON.stringify(output)),
  });
}

const RM = { command: 'rm -rf ./build' };

describe('UB12.101 — keys outside the schema are not applied on the Claude contract', () => {
  it('POSITIVE: a Claude plugin hook\'s top-level updatedInput is ignored; its nested allow still decides, with no notice', async () => {
    const result = await fireCommand('PreToolUse', CLAUDE_CONTRACT, {
      updatedInput: RM,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    expect(result.decision?.decision).toBe('allow');
    expect(result.decision?.updatedInput).toBeUndefined();
    expect(result.hookErrors).toBeUndefined();
    // Control on the same instrument: the documented nested spelling applies.
    const nested = await fireCommand('PreToolUse', CLAUDE_CONTRACT, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: RM },
    });
    expect(nested.decision?.updatedInput).toEqual(RM);
  });

  it('NEGATIVE: a native hook\'s top-level updatedInput still applies — the fork\'s documented decision format', async () => {
    const result = await fireCommand('PreToolUse', NATIVE, { decision: 'allow', updatedInput: RM });
    expect(result.decision?.decision).toBe('allow');
    expect(result.decision?.updatedInput).toEqual(RM);
  });

  it('a top-level additionalContext (SessionStart) and updatedToolOutput (PostToolUse) are ignored; the nested ones apply', async () => {
    const topContext = await fireCommand('SessionStart', CLAUDE_CONTRACT, { additionalContext: 'top-level context' });
    expect(topContext.decision?.additionalContext).toBeUndefined();
    const nestedContext = await fireCommand('SessionStart', CLAUDE_CONTRACT, {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'nested context' },
    });
    expect(nestedContext.decision?.additionalContext).toBe('nested context');

    const topRewrite = await fireCommand('PostToolUse', CLAUDE_CONTRACT, { updatedToolOutput: 'rewritten' });
    expect(topRewrite.decision?.updatedToolOutput).toBeUndefined();
    const nestedRewrite = await fireCommand('PostToolUse', CLAUDE_CONTRACT, {
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'rewritten' },
    });
    expect(nestedRewrite.decision?.updatedToolOutput).toBe('rewritten');
  });

  it('a field from another event\'s branch, under the fired event\'s own name, is not applied', async () => {
    // PermissionRequest's `decision.behavior` inside the PreToolUse branch.
    const band = await fireCommand('PreToolUse', CLAUDE_CONTRACT, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', decision: { behavior: 'allow' } },
    });
    expect(band.decision?.decision).toBeUndefined();
    expect(band.hookErrors).toBeUndefined();
    // PreToolUse's `updatedInput` inside the PermissionRequest branch: the
    // branch's own `decision.updatedInput` is the one applied.
    const permission = await fireCommand('PermissionRequest', CLAUDE_CONTRACT, {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        updatedInput: RM,
        decision: { behavior: 'allow', updatedInput: { command: 'ls -la' } },
      },
    });
    expect(permission.decision?.decision).toBe('allow');
    expect(permission.decision?.updatedInput).toEqual({ command: 'ls -la' });
    // PostToolUse's rewrite under PostToolUseFailure, whose branch is
    // `additionalContext` alone.
    const failure = await fireCommand('PostToolUseFailure', CLAUDE_CONTRACT, {
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', updatedToolOutput: 'rewritten', additionalContext: 'why it failed' },
    });
    expect(failure.decision?.updatedToolOutput).toBeUndefined();
    expect(failure.decision?.additionalContext).toBe('why it failed');
  });

  it('a top-level continue: true decides nothing on the Claude contract; a native one is still an allow', async () => {
    const claude = await fireCommand('PreToolUse', CLAUDE_CONTRACT, { continue: true });
    expect(claude.decision?.decision).toBeUndefined();
    const native = await fireCommand('PreToolUse', NATIVE, { continue: true });
    expect(native.decision?.decision).toBe('allow');
  });

  it('BOUNDARY: the parser reads the fork\'s wider vocabulary without a reading, and the schema\'s with one', () => {
    const stdout = JSON.stringify({ decision: 'deny', additionalContext: 'top', updatedInput: RM });
    expect(parseHookCommandOutput(stdout)).toEqual({ decision: 'deny', additionalContext: 'top', updatedInput: RM });
    expect(parseHookCommandOutput(stdout, { event: 'PreToolUse', claudeContract: true })).toBeUndefined();
  });
});

describe('UB12.101 — hookEventName must be the event that fired', () => {
  it('POSITIVE: a PostToolUse hook naming PreToolUse is the non-blocking error and applies nothing', async () => {
    const result = await fireCommand('PostToolUse', CLAUDE_CONTRACT, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'from the wrong branch' },
    });
    expect(result.decision).toBeUndefined();
    expect(result.hookErrors?.map(error => error.summary)).toEqual([
      'Hook output failed schema validation: hookSpecificOutput.hookEventName must be "PostToolUse", the event that fired',
    ]);
    expect(result.hookRuns?.map(run => run.outcome)).toEqual(['error']);
  });

  it('a PreToolUse hook printing PermissionRequest\'s allow does not allow', async () => {
    const result = await fireCommand('PreToolUse', CLAUDE_CONTRACT, {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(result.decision?.decision).toBeUndefined();
    expect(result.hookErrors).toHaveLength(1);
  });

  it('an http body naming another event is the same error', async () => {
    const config = {
      automations: { PreToolUse: [{ id: 'policy', actions: [{ type: 'plugin-http', http: { url: 'https://example.invalid/policy' } }] }] },
    } as unknown as AutomationsConfig;
    const result = await executePluginHookAutomations(config, 'PreToolUse', inputFor('PreToolUse'), {
      workspaceRootPath,
      httpRunner: async () => ({ body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'x' } }) }),
    });
    expect(result.decision).toBeUndefined();
    expect(result.hookErrors?.[0]?.summary).toContain('must be "PreToolUse", the event that fired');
  });

  it('NEGATIVE: Claude\'s Elicitation answers our McpElicitation; our own spelling is the error since UB12.99', async () => {
    const claude = await fireCommand('McpElicitation', CLAUDE_CONTRACT, {
      hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { project_key: 'DOCS' } },
    });
    expect({ errors: claude.hookErrors, action: claude.decision?.elicitationAction }).toEqual({ errors: undefined, action: 'accept' });
    const ours = await fireCommand('McpElicitation', CLAUDE_CONTRACT, {
      hookSpecificOutput: { hookEventName: 'McpElicitation', action: 'accept', content: { project_key: 'DOCS' } },
    });
    expect(ours.decision?.elicitationAction).toBeUndefined();
    expect(ours.hookErrors?.[0]?.summary).toContain('must be "Elicitation", Claude Code\'s name for this event');
    // Control on the same instrument: ElicitationResult is another branch.
    expect(hookStdoutJsonFailure(JSON.stringify({ hookSpecificOutput: { hookEventName: 'ElicitationResult', action: 'accept' } }), 'McpElicitation'))
      .toContain('must be "Elicitation", the event that fired');
  });

  it('NEGATIVE: a native hook is not checked, and without the event the check is UB12.70\'s', async () => {
    const native = await fireCommand('PostToolUse', NATIVE, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'native context' },
    });
    expect(native.hookErrors).toBeUndefined();
    expect(native.decision?.additionalContext).toBe('native context');
    expect(hookStdoutJsonFailure(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse' } }))).toBeUndefined();
  });
});

describe('UB12.101 — a background Claude-contract hook delivers its fired branch only', () => {
  it('a top-level additionalContext is not delivered; the nested one is; a native hook\'s top-level one still is', async () => {
    const deliver = async (action: Partial<HookCommandAction>, output: object): Promise<string[]> => {
      const notes: PluginAsyncHookNote[] = [];
      await executePluginHookAutomations(commandConfig('Stop', { async: true, ...action }), 'Stop', { hook_event_name: 'Stop' }, {
        workspaceRootPath,
        runner: async () => exit0(JSON.stringify(output)),
        asyncNoteEmitter: note => { notes.push(note); },
      });
      await new Promise(resolve => { setTimeout(resolve, 0); });
      return notes.map(note => note.text);
    };
    expect(await deliver(CLAUDE_CONTRACT, { additionalContext: 'top' })).toEqual([]);
    expect(await deliver(CLAUDE_CONTRACT, { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'nested' } })).toEqual(['nested']);
    expect(await deliver(CLAUDE_CONTRACT, { hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: 'wrong branch' } })).toEqual([]);
    expect(await deliver(NATIVE, { additionalContext: 'top' })).toEqual(['top']);
  });
});
