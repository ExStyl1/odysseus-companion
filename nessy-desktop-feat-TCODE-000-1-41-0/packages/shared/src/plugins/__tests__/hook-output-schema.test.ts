/**
 * UB12.70 — hook JSON output that fails the documented schema is a
 * non-blocking error, not a lenient read.
 *
 * hooks.md § Exit code 0 (curl'd 2026-10-16), verbatim: "When Claude Code
 * tries to parse your stdout as JSON and can't, or the parsed object fails
 * schema validation, the run is a non-blocking error. The `<hook name> hook
 * error` notice carries the parse or validation message. On the events that add
 * plain-text stdout as context, Claude Code doesn't add stdout it failed to
 * parse." § HTTP response handling: "A body that fails schema validation is a
 * non-blocking error".
 *
 * The premise at HEAD (`8e02ce6b0`): `parseHookCommandOutput` and
 * `parseHookOutputForEvent` read each field they know with a `typeof` and
 * dropped the rest, so `{"decision": 42}` gave no candidate and no notice, and a
 * deny beside a wrong-typed field still denied.
 *
 * The schema's MEMBERSHIP is the bundle's (`SyncHookJSONOutput` in
 * `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts`); the first describe re-reads
 * that file, so a branch or a field the bundle adds or drops fails here.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  HOOK_OUTPUT_PARSE_FAILURE,
  HOOK_OUTPUT_TOP_LEVEL_FIELDS,
  HOOK_SPECIFIC_OUTPUT_BRANCHES,
  hookJsonOutputSchemaError,
  hookStdoutJsonFailure,
  type HookOutputFieldSpec,
} from '../../automations/hook-command.ts';
import { executePluginHookAutomations } from '../hooks-automation.ts';
import type { AgentEvent, AutomationsConfig, HookCommandAction, HookCommandActionResult } from '../../automations/types.ts';

// ---------------------------------------------------------------------------
// The bundle is the denominator.
// ---------------------------------------------------------------------------

function readSdkTypings(): string {
  return readFileSync(require.resolve('@anthropic-ai/claude-agent-sdk').replace(/sdk\.mjs$/, 'sdk.d.ts'), 'utf8');
}

/** `name?: TYPE;` lines of one `export declare type X = { … };` block, comments removed. */
function declaredFields(typings: string, typeName: string): Map<string, string> {
  const match = new RegExp(`export declare type ${typeName} = \\{([\\s\\S]*?)\\n\\};`).exec(typings);
  if (!match) throw new Error(`sdk.d.ts declares no ${typeName}`);
  const body = match[1]!.replace(/\/\*\*[\s\S]*?\*\//g, '');
  const fields = new Map<string, string>();
  // Top-level members only: a member's type may span lines (the PermissionRequest
  // decision union), so split on `;` at brace depth 0.
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ';' && depth === 0) {
      const member = /^\s*(\w+)\??:\s*([\s\S]+)$/.exec(current);
      if (member) fields.set(member[1]!, member[2]!.replace(/\s+/g, ' ').trim());
      current = '';
      continue;
    }
    current += char;
  }
  return fields;
}

/** Our spec for one d.ts type, or `undefined` when the d.ts type is one this mapping does not know. */
function specOfDeclaredType(type: string, typings: string): HookOutputFieldSpec | undefined {
  if (type === 'boolean') return 'boolean';
  if (type === 'string') return 'string';
  if (type === 'unknown') return 'any';
  if (type === 'string[]') return 'string-array';
  if (type === 'Record<string, unknown>') return 'object';
  if (/^'[^']*'( \| '[^']*')*$/.test(type)) return { oneOf: type.split(' | ').map(entry => entry.slice(1, -1)) };
  if (/behavior: 'allow'/.test(type) && /behavior: 'deny'/.test(type)) return 'permission-request-decision';
  if (!/^\w+$/.test(type)) return undefined;
  // A named alias (`HookPermissionDecision`): read through to what it names.
  const alias = new RegExp(`export declare type ${type} = ([^;]+);`).exec(typings);
  return alias ? specOfDeclaredType(alias[1]!.trim(), typings) : undefined;
}

describe('UB12.70 — the schema tables are the bundle\'s SyncHookJSONOutput', () => {
  const typings = readSdkTypings();
  const syncFields = declaredFields(typings, 'SyncHookJSONOutput');

  it('the top-level fields and their types match, hookSpecificOutput apart', () => {
    const declared = Object.fromEntries(
      [...syncFields].filter(([name]) => name !== 'hookSpecificOutput').map(([name, type]) => [name, specOfDeclaredType(type, typings)]),
    );
    expect(declared).toEqual({ ...HOOK_OUTPUT_TOP_LEVEL_FIELDS });
  });

  it('every hookSpecificOutput branch, its fields, their types and the required ones match', () => {
    const union = syncFields.get('hookSpecificOutput')!.split(' | ').map(name => name.trim());
    // Positive control on the instrument: the union is not empty and names real types.
    expect(union.length).toBeGreaterThan(20);
    const declared: Record<string, { fields: Record<string, HookOutputFieldSpec | undefined>; required: string[] }> = {};
    for (const typeName of union) {
      const fields = declaredFields(typings, typeName);
      const eventName = /^'(\w+)'$/.exec(fields.get('hookEventName') ?? '')?.[1];
      expect(eventName).toBeDefined();
      const block = new RegExp(`export declare type ${typeName} = \\{([\\s\\S]*?)\\n\\};`).exec(typings)![1]!;
      declared[eventName!] = {
        fields: Object.fromEntries([...fields].filter(([name]) => name !== 'hookEventName').map(([name, type]) => [name, specOfDeclaredType(type, typings)])),
        required: [...fields.keys()].filter(name => name !== 'hookEventName' && new RegExp(`\\n\\s*${name}:`).test(block)),
      };
    }
    const ours: Record<string, { fields: Record<string, HookOutputFieldSpec | undefined>; required: string[] }> = Object.fromEntries(
      Object.entries(HOOK_SPECIFIC_OUTPUT_BRANCHES).map(([name, branch]) => [
        name, { fields: { ...branch.fields }, required: [...(branch.required ?? [])] },
      ]),
    );
    expect(ours).toEqual(declared);
  });
});

// ---------------------------------------------------------------------------
// The validator.
// ---------------------------------------------------------------------------

describe('UB12.70 — hookJsonOutputSchemaError', () => {
  it('POSITIVE: a wrong type, a value outside an enum, null, and a bad hookSpecificOutput each fail, by path', () => {
    expect(hookJsonOutputSchemaError({ decision: 42 })).toBe('Hook output failed schema validation: decision must be one of "approve", "block"');
    expect(hookJsonOutputSchemaError({ continue: 'false' })).toContain('continue must be true or false');
    expect(hookJsonOutputSchemaError({ reason: null })).toContain('reason must be a string');
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: [] })).toContain('hookSpecificOutput must be an object');
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { permissionDecision: 'deny' } }))
      .toContain('hookSpecificOutput is missing its required field hookEventName');
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { hookEventName: 'PreCompact' } }))
      .toContain('hookSpecificOutput.hookEventName names no event that takes hookSpecificOutput');
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { hookEventName: 'PermissionRequest' } }))
      .toContain('hookSpecificOutput.decision is required for this event');
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'maybe' } } }))
      .toContain('hookSpecificOutput.decision.behavior must be "allow" or "deny"');
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', interrupt: 'yes' } } }))
      .toContain('hookSpecificOutput.decision.interrupt must be true or false');
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { hookEventName: 'SessionStart', watchPaths: ['/a', 3] } }))
      .toContain('hookSpecificOutput.watchPaths must be an array of strings');
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'defer' } }))
      .toContain('hookSpecificOutput.permissionDecision must be one of "allow", "deny", "ask"');
  });

  it('every problem is listed, and a misplaced permission decision gets its way out', () => {
    const message = hookJsonOutputSchemaError({ decision: 'deny', stopReason: 3 })!;
    expect(message).toContain('stopReason must be a string; decision must be one of "approve", "block"');
    expect(message).toContain('hookSpecificOutput.permissionDecision on PreToolUse');
    expect(hookJsonOutputSchemaError({ decision: 7 })).not.toContain('permissionDecision on PreToolUse');
  });

  it('NEGATIVE: valid output passes — unknown keys, the legacy "approve", an any-typed field', () => {
    expect(hookJsonOutputSchemaError({ decision: 'block', reason: 'tests must pass' })).toBeUndefined();
    expect(hookJsonOutputSchemaError({ decision: 'approve' })).toBeUndefined();
    expect(hookJsonOutputSchemaError({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no', updatedInput: { a: 1 } },
    })).toBeUndefined();
    expect(hookJsonOutputSchemaError({ unknown: 1, hookSpecificOutput: { hookEventName: 'Stop', extra: true } })).toBeUndefined();
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: 'x' } } })).toBeUndefined();
    expect(hookJsonOutputSchemaError({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [], message: 'ignored' } },
    })).toBeUndefined();
  });

  it('UB12.99: our McpElicitation spelling is no longer an alias — the hook reads Claude\'s Elicitation on its stdin and must print it', () => {
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { hookEventName: 'McpElicitation', action: 'accept', content: { branch: 'main' } } }))
      .toBe('Hook output failed schema validation: hookSpecificOutput.hookEventName must be "Elicitation", Claude Code\'s name for this event');
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept' } })).toBeUndefined();
    // Control: Claude's spelling selects the branch, so the branch's types still apply.
    expect(hookJsonOutputSchemaError({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'maybe' } }))
      .toContain('hookSpecificOutput.action must be one of "accept", "decline", "cancel"');
  });

  it('BOUNDARY: the message names paths, never a value the hook printed', () => {
    const secret = 'sk_live_0123456789abcdefghijklmnop';
    const message = hookJsonOutputSchemaError({ reason: { token: secret }, hookSpecificOutput: { hookEventName: secret } })!;
    expect(message).toContain('reason must be a string');
    expect(message).not.toContain(secret);
  });

  it('hookStdoutJsonFailure: plain text passes, an object that will not parse fails, a valid one passes', () => {
    expect(hookStdoutJsonFailure('all good')).toBeUndefined();
    expect(hookStdoutJsonFailure('[1, 2]')).toBeUndefined();
    expect(hookStdoutJsonFailure('')).toBeUndefined();
    expect(hookStdoutJsonFailure('{"decision": ')).toBe(HOOK_OUTPUT_PARSE_FAILURE);
    expect(hookStdoutJsonFailure('{not json}')).toBe(HOOK_OUTPUT_PARSE_FAILURE);
    expect(hookStdoutJsonFailure('  {"decision":"block"}\n')).toBeUndefined();
    expect(hookStdoutJsonFailure('{"decision":42}')).toContain('decision must be one of');
  });
});

// ---------------------------------------------------------------------------
// The executor: command (Claude contract), http, mcp_tool.
// ---------------------------------------------------------------------------

const workspaceRootPath = process.cwd();

function commandConfig(event: AgentEvent, action: Partial<HookCommandAction> = {}): AutomationsConfig {
  return {
    automations: {
      [event]: [{ id: 'policy/guard', name: 'policy/guard', actions: [{ type: 'command', command: './guard.sh', ...action }] }],
    },
  } as unknown as AutomationsConfig;
}

const CLAUDE_CONTRACT: Partial<HookCommandAction> = { blockOnNonZero: false };

function exit0(stdout: string): HookCommandActionResult {
  return { type: 'command', command: './guard.sh', success: true, exitCode: 0, signal: null, durationMs: 1, stdout };
}

function inputFor(event: AgentEvent) {
  return event === 'PreToolUse'
    ? { hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'ls' } }
    : { hook_event_name: event, prompt: 'hello' };
}

async function fireCommand(event: AgentEvent, action: Partial<HookCommandAction>, stdout: string) {
  return executePluginHookAutomations(commandConfig(event, action), event, inputFor(event), {
    workspaceRootPath,
    runner: async () => exit0(stdout),
  });
}

const DENY = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'policy says no' };

describe('UB12.70 — a Claude-contract command hook\'s exit 0', () => {
  it('POSITIVE: a wrong-typed field beside a deny raises the notice and adds nothing', async () => {
    const result = await fireCommand('PreToolUse', CLAUDE_CONTRACT, JSON.stringify({ hookSpecificOutput: DENY, systemMessage: 42 }));
    expect(result.decision).toBeUndefined();
    expect(result.universal).toBeUndefined();
    expect(result.hookErrors).toEqual([{
      hookName: 'policy/guard',
      event: 'PreToolUse',
      exitCode: 0,
      summary: 'Hook output failed schema validation: systemMessage must be a string',
    }]);
    expect(result.hookRunFailed).toBe(true);
    expect(result.hookRuns?.map(run => [run.outcome, run.stderr])).toEqual([
      ['error', 'Hook output failed schema validation: systemMessage must be a string'],
    ]);
  });

  it('NEGATIVE: the same object without the wrong field still decides, with no notice', async () => {
    const result = await fireCommand('PreToolUse', CLAUDE_CONTRACT, JSON.stringify({ hookSpecificOutput: DENY }));
    expect(result.decision).toMatchObject({ decision: 'deny', reason: 'policy says no' });
    expect(result.hookErrors).toBeUndefined();
    expect(result.hookRuns?.map(run => run.outcome)).toEqual(['success']);
  });

  it('a top-level "deny" is the bundle\'s schema failure on a Claude hook, and the notice says where it goes', async () => {
    const result = await fireCommand('PreToolUse', CLAUDE_CONTRACT, JSON.stringify({ decision: 'deny', reason: 'no' }));
    expect(result.decision).toBeUndefined();
    expect(result.hookErrors?.[0]?.summary).toContain('hookSpecificOutput.permissionDecision on PreToolUse');
  });

  it('on a context event neither the fields nor the stdout reach the context: a schema failure and a parse failure', async () => {
    const invalid = await fireCommand('UserPromptSubmit', CLAUDE_CONTRACT, JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'branch is main' },
      continue: 'yes',
    }));
    expect(invalid.decision).toBeUndefined();
    expect(invalid.hookErrors?.[0]?.summary).toBe('Hook output failed schema validation: continue must be true or false');

    const unparsable = await fireCommand('UserPromptSubmit', CLAUDE_CONTRACT, '{branch: main}');
    expect(unparsable.decision).toBeUndefined();
    expect(unparsable.hookErrors?.[0]?.summary).toBe(HOOK_OUTPUT_PARSE_FAILURE);

    // Control: plain text is still context, and valid JSON's context still lands.
    const plain = await fireCommand('UserPromptSubmit', CLAUDE_CONTRACT, 'branch is main');
    expect(plain.decision?.additionalContext).toBe('branch is main');
    expect(plain.hookErrors).toBeUndefined();
    const valid = await fireCommand('UserPromptSubmit', CLAUDE_CONTRACT, JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'branch is main' },
    }));
    expect(valid.decision?.additionalContext).toBe('branch is main');
  });

  it('with onFailure "block" the invalid output is a failure that blocks, its notice kept', async () => {
    const result = await fireCommand('PreToolUse', { ...CLAUDE_CONTRACT, onFailure: 'block' }, JSON.stringify({ decision: 42 }));
    expect(result.decision?.decision).toBe('block');
    expect(result.decision?.reason).toBe(
      '[./guard.sh]: failed; blocking because onFailure is "block"\nHook output failed schema validation: decision must be one of "approve", "block"',
    );
    expect(result.hookErrors?.map(notice => notice.summary)).toEqual([
      'Hook output failed schema validation: decision must be one of "approve", "block"',
    ]);
  });

  it('BOUNDARY: a native actions hook keeps its own documented reading — no schema, no notice', async () => {
    const lenient = await fireCommand('PreToolUse', {}, JSON.stringify({ hookSpecificOutput: DENY, systemMessage: 42 }));
    expect(lenient.decision).toMatchObject({ decision: 'deny', reason: 'policy says no' });
    expect(lenient.hookErrors).toBeUndefined();
    const topLevel = await fireCommand('PreToolUse', {}, JSON.stringify({ decision: 'deny', reason: 'no' }));
    expect(topLevel.decision).toMatchObject({ decision: 'deny', reason: 'no' });
    expect(topLevel.hookErrors).toBeUndefined();
  });
});

describe('UB12.70 — http and mcp_tool bodies', () => {
  const httpConfig = (event: string) => ({
    automations: { [event]: [{ id: 'policy', actions: [{ type: 'plugin-http' as const, http: { url: 'https://example.invalid/policy' } }] }] },
  }) as unknown as AutomationsConfig;
  const mcpConfig = (event: string) => ({
    automations: { [event]: [{ id: 'scan', actions: [{ type: 'plugin-mcp-tool' as const, mcpTool: 'mcp__policy__check' }] }] },
  }) as unknown as AutomationsConfig;

  it('POSITIVE: an http body that fails the schema is the non-blocking error and its allow is not applied', async () => {
    const result = await executePluginHookAutomations(httpConfig('PreToolUse'), 'PreToolUse', inputFor('PreToolUse'), {
      workspaceRootPath,
      httpRunner: async () => ({ body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }, suppressOutput: 'yes' }) }),
    });
    expect(result.decision).toBeUndefined();
    expect(result.hookErrors).toEqual([{
      hookName: 'policy', event: 'PreToolUse', exitCode: null, summary: 'Hook output failed schema validation: suppressOutput must be true or false',
    }]);
    expect(result.hookRuns?.map(run => [run.outcome, run.stderr])).toEqual([
      ['error', 'Hook output failed schema validation: suppressOutput must be true or false'],
    ]);
  });

  it('NEGATIVE: a valid http body still decides', async () => {
    const result = await executePluginHookAutomations(httpConfig('PreToolUse'), 'PreToolUse', inputFor('PreToolUse'), {
      workspaceRootPath,
      httpRunner: async () => ({ body: JSON.stringify({ hookSpecificOutput: DENY }) }),
    });
    expect(result.decision).toMatchObject({ decision: 'deny', reason: 'policy says no' });
    expect(result.hookErrors).toBeUndefined();
  });

  it('an mcp_tool text that fails the schema adds no context; its plain text still does', async () => {
    const invalid = await executePluginHookAutomations(mcpConfig('UserPromptSubmit'), 'UserPromptSubmit', inputFor('UserPromptSubmit'), {
      workspaceRootPath,
      mcpToolRunner: async () => ({ body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 7 } }) }),
    });
    expect(invalid.decision).toBeUndefined();
    expect(invalid.hookErrors?.[0]?.summary).toBe('Hook output failed schema validation: hookSpecificOutput.additionalContext must be a string');

    const plain = await executePluginHookAutomations(mcpConfig('UserPromptSubmit'), 'UserPromptSubmit', inputFor('UserPromptSubmit'), {
      workspaceRootPath,
      mcpToolRunner: async () => ({ body: 'The deployment target is staging.' }),
    });
    expect(plain.decision?.additionalContext).toBe('The deployment target is staging.');
    expect(plain.hookErrors).toBeUndefined();
  });
});
