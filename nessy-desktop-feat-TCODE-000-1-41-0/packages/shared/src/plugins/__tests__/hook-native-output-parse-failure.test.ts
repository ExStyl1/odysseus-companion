/**
 * UB12.100 — a native command hook's exit-0 stdout that opens `{` and cannot be
 * parsed is the documented non-blocking error, and is never context.
 *
 * hooks.md § Exit code 0 (`hooks.md#exit-code-0`, curl'd 2026-10-17), verbatim:
 * "Unless the hook is one whose failure blocks the action, a parse failure or a
 * parsed object that fails schema validation is a non-blocking error. The
 * `<hook name> hook error` notice carries the parse or validation message. On
 * the events that add plain-text stdout as context, Claude Code doesn't add
 * stdout it failed to parse."
 *
 * UB12.70 gave a Claude-contract hook both halves (parse and schema). A native
 * `actions` hook (no `blockOnNonZero: false`) got neither, so at `cf592edec` a
 * native `UserPromptSubmit` hook printing `{broken` was a clean success with no
 * notice and its bytes reached the model as `additionalContext` (measured
 * through `executePluginHookAutomations`, on all four context events). This row
 * gives it the PARSE half only: the schema half would refuse the native
 * contract's own top-level `allow`/`deny`/`updatedInput`.
 */
import { describe, expect, it } from 'bun:test';
import {
  HOOK_OUTPUT_PARSE_FAILURE,
  hookCommandStdoutContext,
  hookStdoutParseFailure,
} from '../../automations/hook-command.ts';
import { executePluginHookAutomations } from '../hooks-automation.ts';
import type { AgentEvent, AutomationsConfig, HookCommandAction, HookCommandActionResult } from '../../automations/types.ts';

const workspaceRootPath = process.cwd();

function commandConfig(event: AgentEvent, action: Partial<HookCommandAction> = {}): AutomationsConfig {
  return {
    automations: {
      [event]: [{ id: 'native/ctx', name: 'native/ctx', actions: [{ type: 'command', command: './ctx.sh', ...action }] }],
    },
  } as unknown as AutomationsConfig;
}

function exit0(stdout: string): HookCommandActionResult {
  return { type: 'command', command: './ctx.sh', success: true, exitCode: 0, signal: null, durationMs: 1, stdout };
}

function inputFor(event: AgentEvent) {
  if (event === 'PreToolUse') return { hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'ls' } };
  if (event === 'SessionStart') return { hook_event_name: event, source: 'startup' };
  return { hook_event_name: event, prompt: 'hello' };
}

async function fireNative(event: AgentEvent, stdout: string, action: Partial<HookCommandAction> = {}) {
  return executePluginHookAutomations(commandConfig(event, action), event, inputFor(event), {
    workspaceRootPath,
    runner: async () => exit0(stdout),
  });
}

const CONTEXT_EVENTS: AgentEvent[] = ['UserPromptSubmit', 'UserPromptExpansion', 'SessionStart', 'PostModelSwitch'];

describe('UB12.100 — a native command hook\'s unparseable exit-0 JSON', () => {
  it('POSITIVE: `{broken` on UserPromptSubmit raises the parse notice and adds no context', async () => {
    const result = await fireNative('UserPromptSubmit', '{broken');
    expect(result.decision?.additionalContext).toBeUndefined();
    expect(result.decision).toBeUndefined();
    expect(result.hookErrors).toEqual([{ hookName: 'native/ctx', event: 'UserPromptSubmit', exitCode: 0, summary: HOOK_OUTPUT_PARSE_FAILURE }]);
    expect(result.hookRunFailed).toBe(true);
    expect(result.hookRuns?.map(run => [run.outcome, run.stderr])).toEqual([['error', HOOK_OUTPUT_PARSE_FAILURE]]);
  });

  it('on every context event, closed or unclosed, the broken object is a notice and never context', async () => {
    for (const event of CONTEXT_EVENTS) {
      for (const stdout of ['{broken', '{branch: main}', '{"a":1}\n{"b":2}']) {
        const result = await fireNative(event, stdout);
        expect(result.decision?.additionalContext, `${event} ${JSON.stringify(stdout)}`).toBeUndefined();
        expect(result.hookErrors?.map(notice => notice.summary), `${event} ${JSON.stringify(stdout)}`).toEqual([HOOK_OUTPUT_PARSE_FAILURE]);
      }
    }
  });

  it('NEGATIVE: native plain text is still context, with no notice', async () => {
    const result = await fireNative('UserPromptSubmit', 'branch is main');
    expect(result.decision?.additionalContext).toBe('branch is main');
    expect(result.hookErrors).toBeUndefined();
    expect(result.hookRuns?.map(run => run.outcome)).toEqual(['success']);
    // A JSON array and prose that only CONTAINS an object do not open `{`: plain text, as before.
    expect((await fireNative('SessionStart', '["a","b"]')).decision?.additionalContext).toBe('["a","b"]');
    expect((await fireNative('SessionStart', 'Open PRs: {"id":4211}')).decision?.additionalContext).toBe('Open PRs: {"id":4211}');
  });

  it('BOUNDARY: only the parse half — a native object the Claude schema would refuse still decides, with no notice', async () => {
    const deny = await fireNative('PreToolUse', JSON.stringify({ decision: 'deny', reason: 'no' }));
    expect(deny.decision).toMatchObject({ decision: 'deny', reason: 'no' });
    expect(deny.hookErrors).toBeUndefined();
    const block = await fireNative('UserPromptSubmit', JSON.stringify({ decision: 'block', reason: 'frozen', systemMessage: 42 }));
    expect(block.decision?.decision).toBe('block');
    expect(block.hookErrors).toBeUndefined();
  });

  it('on PreToolUse the broken object is the notice and decides nothing', async () => {
    const result = await fireNative('PreToolUse', '{"decision": "deny"');
    expect(result.decision).toBeUndefined();
    expect(result.hookErrors?.map(notice => notice.summary)).toEqual([HOOK_OUTPUT_PARSE_FAILURE]);
  });

  it('with onFailure "block" it blocks with the parse message, and its bytes are still not context', async () => {
    const result = await fireNative('UserPromptSubmit', '{broken', { onFailure: 'block' });
    expect(result.decision?.decision).toBe('block');
    expect(result.decision?.reason).toBe(`[./ctx.sh]: failed; blocking because onFailure is "block"\n${HOOK_OUTPUT_PARSE_FAILURE}`);
    expect(result.decision?.additionalContext).toBeUndefined();
    expect(result.hookErrors?.map(notice => notice.summary)).toEqual([HOOK_OUTPUT_PARSE_FAILURE]);
  });
});

describe('UB12.100 — the readers', () => {
  it('hookStdoutParseFailure: the parse half alone, no schema', () => {
    expect(hookStdoutParseFailure('{broken')).toBe(HOOK_OUTPUT_PARSE_FAILURE);
    expect(hookStdoutParseFailure('  {not json}\n')).toBe(HOOK_OUTPUT_PARSE_FAILURE);
    expect(hookStdoutParseFailure('plain text')).toBeUndefined();
    expect(hookStdoutParseFailure('[1, 2]')).toBeUndefined();
    expect(hookStdoutParseFailure('')).toBeUndefined();
    // A native top-level allow fails Claude's schema, not the parse.
    expect(hookStdoutParseFailure('{"decision":"allow","updatedInput":{"command":"ls"}}')).toBeUndefined();
  });

  it('hookCommandStdoutContext never returns stdout it failed to parse; prose still passes', () => {
    expect(hookCommandStdoutContext('UserPromptSubmit', { success: true, stdout: '{broken' })).toBeUndefined();
    expect(hookCommandStdoutContext('SessionStart', { success: true, stdout: '{branch: main}' })).toBeUndefined();
    expect(hookCommandStdoutContext('UserPromptSubmit', { success: true, stdout: 'branch is main' })).toBe('branch is main');
  });
});
