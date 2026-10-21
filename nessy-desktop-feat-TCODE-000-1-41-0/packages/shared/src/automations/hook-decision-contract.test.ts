import { describe, expect, it } from 'bun:test';
import {
  applySessionStartTitleSourceGate,
  hookDecisionPattern,
  hookEventCanDecide,
  hookEventDecisionSurface,
  hookEventStdoutCanDecide,
  mergePreToolUseDecisionObjects,
  projectHookDecisionForEvent,
  resolveHookToolOutputRewrite,
} from './hook-decision-contract.ts';
import { parseHookOutputForEvent } from './hook-command.ts';
import { mergePreToolUseDecisions } from '../plugins/hooks-automation.ts';
import { getMatchValueForSdkInput } from './utils.ts';
import { AGENT_EVENTS, type AgentEvent } from './types.ts';

describe('per-event hook decision contract', () => {
  it.each([
    ['UserPromptSubmit', 'top-level'],
    ['UserPromptExpansion', 'top-level'],
    ['PostToolUse', 'top-level'],
    ['PostToolUseFailure', 'top-level'],
    ['PostToolBatch', 'top-level'],
    ['Stop', 'top-level'],
    ['SubagentStop', 'top-level'],
    ['ConfigChange', 'top-level'],
    ['PreCompact', 'top-level'],
    ['PreToolUse', 'hook-specific'],
    ['PermissionRequest', 'hook-specific'],
    ['PermissionDenied', 'hook-specific'],
    ['McpElicitation', 'hook-specific'],
    ['ElicitationResult', 'hook-specific'],
    ['TaskCreated', 'exit-code-only'],
    ['TaskCompleted', 'exit-code-only'],
    ['WorktreeCreate', 'path-return'],
    ['SessionStart', 'context-only'],
    ['SubagentStart', 'context-only'],
  ] as const)('%s speaks the %s pattern', (event, pattern) => {
    expect(hookDecisionPattern(event)).toBe(pattern);
  });

  it('assigns exactly one pattern to every emitted agent event', () => {
    for (const event of AGENT_EVENTS) {
      expect(hookDecisionPattern(event)).toBeString();
    }
    // The nine top-level events are the documented denominator; nothing else
    // may drift into that pattern.
    expect(AGENT_EVENTS.filter(event => hookDecisionPattern(event) === 'top-level').sort()).toEqual([
      'ConfigChange', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreCompact',
      'Stop', 'SubagentStop', 'UserPromptExpansion', 'UserPromptSubmit',
    ]);
  });

  it('gives only the decision-capable events a decision surface', () => {
    const deciding = AGENT_EVENTS.filter(hookEventCanDecide).sort();
    // R20 added TaskCompleted/TaskCreated: hooks.md:708-709 gives their exit 2
    // real authority ("Rolls back the task creation" / "Prevents the task from
    // being marked as completed"), so their surface has to carry a block value
    // for that exit-code-derived decision to survive projection.
    //
    // R24 added McpElicitation/ElicitationResult for the same reason: hooks.md
    // §Elicitation "Exit 2: blocks the elicitation (action becomes decline)".
    //
    // P3.374 added PreModelSwitch, which is the strongest of them: hooks.md
    // #premodelswitch-decision-control gives it allow/ask/deny with `deny > ask
    // > allow` precedence AND a top-level `decision: "block"` that cancels the
    // switch. PostModelSwitch is deliberately NOT here — "It can't block,
    // because the model has already changed."
    expect(deciding).toEqual([
      'ConfigChange', 'ElicitationResult', 'McpElicitation', 'PermissionRequest', 'PostToolBatch',
      'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreModelSwitch', 'PreToolUse', 'Stop',
      'SubagentStop', 'TaskCompleted', 'TaskCreated', 'UserPromptExpansion', 'UserPromptSubmit',
      'WorktreeCreate',
    ]);
    expect(hookEventCanDecide('PostModelSwitch')).toBe(false);
    // PermissionDenied is hook-specific but its documented output cannot
    // reverse the denial — only `{retry: true}`.
    expect(hookEventCanDecide('PermissionDenied')).toBe(false);
    // hooks.md:699 — "Any non-zero exit code causes worktree creation to
    // fail": the path-return event decides through its EXIT CODE.
    expect(hookEventCanDecide('WorktreeCreate')).toBe(true);
    expect(hookEventStdoutCanDecide('WorktreeCreate')).toBe(false);
    expect(hookEventCanDecide('SessionStart')).toBe(false);
  });

  it('keeps a top-level event to block only — allow and ask are not its surface', () => {
    expect(projectHookDecisionForEvent('Stop', { decision: 'block', reason: 'keep going' }))
      .toEqual({ decision: 'block', reason: 'keep going' });
    expect(projectHookDecisionForEvent('Stop', { decision: 'allow', reason: 'nope' })).toBeUndefined();
    expect(projectHookDecisionForEvent('UserPromptSubmit', { decision: 'ask' })).toBeUndefined();
  });

  it('keeps the full PermissionRequest band surface and nothing more', () => {
    expect(projectHookDecisionForEvent('PermissionRequest', {
      decision: 'allow',
      updatedInput: { command: 'ls' },
      updatedPermissions: [{ type: 'addRules', destination: 'session' }],
      additionalContext: 'ctx',
      updatedToolOutput: 'not on this event',
    })).toEqual({
      decision: 'allow',
      updatedInput: { command: 'ls' },
      updatedPermissions: [{ type: 'addRules', destination: 'session' }],
      additionalContext: 'ctx',
    });
    expect(projectHookDecisionForEvent('PermissionRequest', {
      decision: 'deny', reason: 'denied by policy', interrupt: true,
    })).toEqual({ decision: 'deny', reason: 'denied by policy', interrupt: true });
  });

  it('drops a decision field on a context-only event', () => {
    for (const event of ['SessionStart', 'FileChanged'] as AgentEvent[]) {
      expect(projectHookDecisionForEvent(event, { decision: 'block', reason: 'nope' })).toBeUndefined();
      expect(projectHookDecisionForEvent(event, { decision: 'block', additionalContext: 'ctx' }))
        .toEqual({ additionalContext: 'ctx' });
    }
  });

  it('gives SessionStart the four extra output fields and no other event any of them', () => {
    // hooks.md:947 — "SessionStart also accepts [`initialUserMessage`,
    // `watchPaths`, `sessionTitle`, and `reloadSkills`]".
    const full = {
      decision: 'block' as const,
      reason: 'nope',
      additionalContext: 'ctx',
      initialUserMessage: 'review the diff',
      sessionTitle: 'auth-refactor',
      watchPaths: ['/repo/skills'],
      reloadSkills: true,
    };
    expect(projectHookDecisionForEvent('SessionStart', full)).toEqual({
      additionalContext: 'ctx',
      initialUserMessage: 'review the diff',
      sessionTitle: 'auth-refactor',
      watchPaths: ['/repo/skills'],
      reloadSkills: true,
    });
    // The negative half, and the whole reason SessionStart got an explicit case
    // instead of a widened context-only fallback: :947 gives the four to
    // SessionStart alone, so the other event in its row keeps the bare
    // `additionalContext` surface. (`Setup` is the third name in that row and is
    // no longer an event here — R73 · f001.)
    for (const event of ['SubagentStart', 'FileChanged', 'CwdChanged'] as AgentEvent[]) {
      expect(projectHookDecisionForEvent(event, full)).toEqual({ additionalContext: 'ctx' });
    }
  });

  it('gives UserPromptSubmit sessionTitle without handing it to the other top-level events', () => {
    // hooks.md:1266 — "`sessionTitle` | Sets the session title. Use to name
    // sessions automatically based on the prompt content".
    expect(projectHookDecisionForEvent('UserPromptSubmit', {
      decision: 'block', reason: 'blocked', additionalContext: 'ctx', sessionTitle: 'from the prompt',
    })).toEqual({ decision: 'block', reason: 'blocked', additionalContext: 'ctx', sessionTitle: 'from the prompt' });
    // A rename is not part of the shared top-level surface; widening the
    // fallback would have handed it to all nine.
    for (const event of ['Stop', 'PostToolUse', 'ConfigChange', 'PreCompact', 'UserPromptExpansion'] as AgentEvent[]) {
      expect(projectHookDecisionForEvent(event, { sessionTitle: 'from the prompt' })).toBeUndefined();
    }
    // Nor is `initialUserMessage`/`reloadSkills`/`watchPaths` — SessionStart only.
    expect(projectHookDecisionForEvent('UserPromptSubmit', { reloadSkills: true })).toBeUndefined();
  });

  it('ignores a SessionStart title on the two sources hooks.md:1060 excludes', () => {
    const decision = { sessionTitle: 'auth-refactor', additionalContext: 'ctx' };
    for (const source of ['startup', 'resume', 'fork']) {
      expect(applySessionStartTitleSourceGate('SessionStart', source, decision)).toEqual(decision);
    }
    for (const source of ['clear', 'compact']) {
      expect(applySessionStartTitleSourceGate('SessionStart', source, decision)).toEqual({ additionalContext: 'ctx' });
    }
    // A title-only decision on an excluded source leaves nothing behind.
    expect(applySessionStartTitleSourceGate('SessionStart', 'compact', { sessionTitle: 'x' })).toBeUndefined();
    // An emitter that sends no `source` keeps the title: the exclusion is what
    // the page states, and a missing payload field is not one of the two.
    expect(applySessionStartTitleSourceGate('SessionStart', undefined, decision)).toEqual(decision);
    // The gate is SessionStart's; UserPromptSubmit has no source rule.
    expect(applySessionStartTitleSourceGate('UserPromptSubmit', 'compact', decision)).toEqual(decision);
  });

  it('keeps an exit-code-derived block on the path-return event (hooks.md:699)', () => {
    expect(projectHookDecisionForEvent('WorktreeCreate', { decision: 'block', reason: 'dirty base' }))
      .toEqual({ decision: 'block', reason: 'dirty base' });
    // The path still travels, and allow/ask remain outside the surface.
    expect(projectHookDecisionForEvent('WorktreeCreate', { decision: 'allow', worktreePath: '/repo/wt' }))
      .toEqual({ worktreePath: '/repo/wt' });
  });

  it('keeps an exit-code-only block, but gives it no stdout decision field', () => {
    // R20. The block reaching a task hook's consumer is synthesised from the
    // exit code, so it must survive projection...
    for (const event of ['TaskCreated', 'TaskCompleted'] as AgentEvent[]) {
      expect(projectHookDecisionForEvent(event, { decision: 'block', reason: 'nope' }))
        .toEqual({ decision: 'block', reason: 'nope' });
      // ...but `allow`/`ask` are not the pattern's vocabulary.
      expect(projectHookDecisionForEvent(event, { decision: 'allow' })).toBeUndefined();
      // ...and stdout still carries no `decision` field for these events; that
      // is enforced one layer up, in parseHookOutputForEvent.
      expect(parseHookOutputForEvent('{"decision":"block","reason":"nope"}', event).payload).toEqual({});
    }
  });

  it('keeps classifierContext on PostToolUse alone, where the vendored type declares it (P7.14)', () => {
    // `PostToolUseHookSpecificOutput` declares `classifierContext` since
    // `0.3.247`; `PostToolUseFailureHookSpecificOutput` is `{ hookEventName;
    // additionalContext? }`. So the two events, one wire for `updatedToolOutput`
    // below, part company here.
    expect(projectHookDecisionForEvent('PostToolUse', { classifierContext: 'ran against staging' }))
      .toEqual({ classifierContext: 'ran against staging' });
    expect(projectHookDecisionForEvent('PostToolUseFailure', { classifierContext: 'ran against staging' }))
      .toBeUndefined();
    expect(projectHookDecisionForEvent('PreToolUse', { classifierContext: 'ran against staging' }))
      .toBeUndefined();
    expect(hookEventDecisionSurface('PostToolUse').fields).toContain('classifierContext');
    expect(hookEventDecisionSurface('PostToolUseFailure').fields).not.toContain('classifierContext');
  });

  it('keeps updatedToolOutput on the post-tool events only', () => {
    expect(projectHookDecisionForEvent('PostToolUse', { updatedToolOutput: 'redacted' }))
      .toEqual({ updatedToolOutput: 'redacted' });
    expect(projectHookDecisionForEvent('PostToolUseFailure', { updatedToolOutput: 'redacted' }))
      .toEqual({ updatedToolOutput: 'redacted' });
    expect(projectHookDecisionForEvent('FileChanged', { updatedToolOutput: 'redacted' })).toBeUndefined();
    expect(hookEventDecisionSurface('PostToolUse').fields).toContain('updatedToolOutput');
  });

  it('never returns a bare reason without the decision it explains', () => {
    expect(projectHookDecisionForEvent('Stop', { reason: 'unexplained' })).toBeUndefined();
  });

  it('gives retry to PermissionDenied only and worktreePath to WorktreeCreate only', () => {
    expect(projectHookDecisionForEvent('PermissionDenied', { retry: true })).toEqual({ retry: true });
    expect(projectHookDecisionForEvent('PreToolUse', { retry: true })).toBeUndefined();
    expect(projectHookDecisionForEvent('WorktreeCreate', { worktreePath: '/repo/wt' }))
      .toEqual({ worktreePath: '/repo/wt' });
    expect(projectHookDecisionForEvent('PostToolUse', { worktreePath: '/repo/wt' })).toBeUndefined();
  });
});

describe('PostToolUse output rewriting (built-in schema constraint)', () => {
  it('accepts a plain-text replacement for a plain-text result', () => {
    expect(resolveHookToolOutputRewrite({
      toolName: 'bash', originalOutput: 'lots of output', updatedToolOutput: 'compressed',
    })).toEqual({ output: 'compressed' });
  });

  it('ignores a replacement that breaks a built-in JSON result, keeping the original', () => {
    // "For built-in tools, a value that doesn't match the tool's output schema is
    // ignored and the original output is used."
    expect(resolveHookToolOutputRewrite({
      toolName: 'read', originalOutput: '{"content":"hello"}', updatedToolOutput: 'not json any more',
    })).toEqual({ ignoredReason: 'schema-mismatch' });
    expect(resolveHookToolOutputRewrite({
      toolName: 'read', originalOutput: '{"content":"hello"}', updatedToolOutput: '["wrong","kind"]',
    })).toEqual({ ignoredReason: 'schema-mismatch' });
    // Same JSON kind is a legitimate redaction.
    expect(resolveHookToolOutputRewrite({
      toolName: 'read', originalOutput: '{"content":"secret"}', updatedToolOutput: '{"content":"[REDACTED]"}',
    })).toEqual({ output: '{"content":"[REDACTED]"}' });
  });

  it('does not apply the built-in constraint to MCP tool results', () => {
    expect(resolveHookToolOutputRewrite({
      toolName: 'mcp__github__list_prs', originalOutput: '{"prs":[]}', updatedToolOutput: 'plain text',
    })).toEqual({ output: 'plain text' });
  });

  it('ignores a non-string replacement', () => {
    expect(resolveHookToolOutputRewrite({
      toolName: 'bash', originalOutput: 'out', updatedToolOutput: { not: 'a string' },
    })).toEqual({ ignoredReason: 'not-a-string' });
  });
});

/**
 * hooks.md §Elicitation / §ElicitationResult (R24). The whole documented
 * output is `hookSpecificOutput.{action, content}`; before R24 both events
 * shared the deferred/context-only fallback and dropped it entirely.
 */
describe('the elicitation events decision surface', () => {
  it.each(['McpElicitation', 'ElicitationResult'] as const)('carries %s action and content', (event) => {
    expect(hookEventDecisionSurface(event).fields).toEqual([
      'reason', 'additionalContext', 'elicitationAction', 'elicitationContent',
    ]);
    expect(projectHookDecisionForEvent(event, {
      elicitationAction: 'accept',
      elicitationContent: { user: 'ada' },
    })).toEqual({ elicitationAction: 'accept', elicitationContent: { user: 'ada' } });
  });

  it.each(['McpElicitation', 'ElicitationResult'] as const)('parses the documented %s output', (event) => {
    expect(parseHookOutputForEvent(JSON.stringify({
      hookSpecificOutput: { hookEventName: event, action: 'accept', content: { user: 'ada' } },
    }), event).payload).toEqual({ elicitationAction: 'accept', elicitationContent: { user: 'ada' } });
  });

  it('drops content on a decline — a refusal has no values to send', () => {
    expect(parseHookOutputForEvent(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'McpElicitation', action: 'decline', content: { user: 'ada' } },
    }), 'McpElicitation').payload).toEqual({ elicitationAction: 'decline' });
  });

  it('projects the elicitation fields away on every other event', () => {
    expect(projectHookDecisionForEvent('PreToolUse', {
      elicitationAction: 'accept',
      elicitationContent: { user: 'ada' },
    })).toBeUndefined();
    expect(parseHookOutputForEvent(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', action: 'accept', content: { a: 1 } },
    }), 'PermissionRequest').payload).toEqual({});
  });
});

/**
 * `hooks.md:2692` / `:2762` — "The matcher field matches against the MCP server
 * name". The documented field is `mcp_server_name`.
 */
describe('the elicitation server-name matcher', () => {
  it.each(['McpElicitation', 'ElicitationResult'] as const)('matches %s on mcp_server_name', (event) => {
    expect(getMatchValueForSdkInput(event, {
      hook_event_name: event,
      mcp_server_name: 'my-mcp-server',
    })).toBe('my-mcp-server');
  });

  // The lifecycle-bridge's separate per-tool-call emission still spells it
  // `mcp_server`; it names the same server, so it keeps matching.
  it('falls back to the lifecycle-bridge mcp_server spelling', () => {
    expect(getMatchValueForSdkInput('McpElicitation', {
      hook_event_name: 'McpElicitation',
      mcp_server: 'linear',
    })).toBe('linear');
  });

  it('is empty when neither is present, rather than matching everything', () => {
    expect(getMatchValueForSdkInput('McpElicitation', { hook_event_name: 'McpElicitation' })).toBe('');
  });
});

describe('mergePreToolUseDecisionObjects — the one decision merge (P3.193/P3.194)', () => {
  const RANKED = ['deny', 'defer', 'ask', 'allow'] as const;

  it('honours every ordered pair of the documented precedence, separately', () => {
    // hooks.md#pretooluse-decision-control: "When multiple PreToolUse hooks
    // return different decisions, precedence is `deny` > `defer` > `ask` >
    // `allow`." Pair by pair, because one wrong pair hides inside a chain
    // assertion.
    for (let i = 0; i < RANKED.length; i++) {
      for (let j = i + 1; j < RANKED.length; j++) {
        const stronger = RANKED[i]!;
        const weaker = RANKED[j]!;
        expect({ first: stronger, later: weaker, won: mergePreToolUseDecisionObjects(
          { decision: stronger }, { decision: weaker },
        )?.decision }).toEqual({ first: stronger, later: weaker, won: stronger });
        expect({ first: weaker, later: stronger, won: mergePreToolUseDecisionObjects(
          { decision: weaker }, { decision: stronger },
        )?.decision }).toEqual({ first: weaker, later: stronger, won: stronger });
      }
    }
  });

  it('ranks `block` with `deny`, and lets an equal rank go to the later hook', () => {
    expect(mergePreToolUseDecisionObjects({ decision: 'block' }, { decision: 'defer' })?.decision).toBe('block');
    expect(mergePreToolUseDecisionObjects({ decision: 'defer' }, { decision: 'block' })?.decision).toBe('block');
    expect(mergePreToolUseDecisionObjects({ decision: 'deny' }, { decision: 'block' })?.decision).toBe('block');
    expect(mergePreToolUseDecisionObjects({ decision: 'ask', reason: 'a' }, { decision: 'ask', reason: 'b' }))
      .toMatchObject({ decision: 'ask', reason: 'b' });
  });

  it('gives the reason to the decision that WON, not to the later hook', () => {
    // `permissionDecisionReason` on a deny is "shown to Claude"
    // (hooks.md#pretooluse-decision-control), so a mis-attributed reason is a
    // wrong denial message. Both former merges took `next.reason` even when an
    // outranking `current` kept the decision.
    expect(mergePreToolUseDecisionObjects({ decision: 'deny', reason: 'blocked by policy' }, { decision: 'ask', reason: 'please confirm' }))
      .toMatchObject({ decision: 'deny', reason: 'blocked by policy' });
    expect(mergePreToolUseDecisionObjects({ decision: 'ask', reason: 'please confirm' }, { decision: 'deny', reason: 'blocked by policy' }))
      .toMatchObject({ decision: 'deny', reason: 'blocked by policy' });
    // A winner with no reason of its own still falls back rather than dropping one.
    expect(mergePreToolUseDecisionObjects({ decision: 'deny' }, { decision: 'allow', reason: 'fallback' }))
      .toMatchObject({ decision: 'deny', reason: 'fallback' });
  });

  it('keeps every other field instead of rebuilding from a hand-written list', () => {
    const merged = mergePreToolUseDecisionObjects(
      { worktreePath: '/repo/a', sessionTitle: 'T', reloadSkills: true, watchPaths: ['/w'] },
      { additionalContext: 'ctx' },
    );
    expect(merged).toEqual({
      worktreePath: '/repo/a', sessionTitle: 'T', reloadSkills: true, watchPaths: ['/w'], additionalContext: 'ctx',
    });
    expect(mergePreToolUseDecisionObjects({ additionalContext: 'A' }, { additionalContext: 'B' })?.additionalContext)
      .toBe('A\n\nB');
  });

  it('JOINS two hooks\' classifier notes instead of letting the later one erase the first (P7.14)', () => {
    // `hooks.md#annotate-a-result-for-the-auto-mode-classifier`: "The cap is
    // shared across every hook that responds to that call", and a note from
    // both hook groups is delivered as one "combined note" — the vendor
    // combines. Under the generic copy this merge does for unlisted fields the
    // second note would silently replace the first.
    expect(mergePreToolUseDecisionObjects(
      { classifierContext: 'ran against staging' },
      { classifierContext: 'the file was already tracked' },
    )?.classifierContext).toBe('ran against staging\n\nthe file was already tracked');
    // One note alone is untouched — the join must not add a separator to it.
    expect(mergePreToolUseDecisionObjects({ classifierContext: 'ran against staging' }, {})?.classifierContext)
      .toBe('ran against staging');
  });

  it('never leaves an explicit `undefined` key behind for a later spread to erase', () => {
    const merged = mergePreToolUseDecisionObjects({ decision: 'ask', reason: 'keep' }, { decision: 'ask', reason: undefined });
    expect(Object.keys(merged ?? {}).sort()).toEqual(['decision', 'reason']);
    expect(merged?.reason).toBe('keep');
  });

  it('holds the allow-only / deny-only / accept-only field gates across the merge', () => {
    // `interrupt` is deny-only, `updatedPermissions` allow-only
    // (hooks.md#permissionrequest); `elicitationContent` accept-only
    // (hooks.md § Elicitation).
    expect(mergePreToolUseDecisionObjects({ decision: 'allow', interrupt: true }, { decision: 'allow' })?.interrupt)
      .toBeUndefined();
    expect(mergePreToolUseDecisionObjects({ decision: 'deny', interrupt: true }, { decision: 'allow' })?.interrupt)
      .toBe(true);
    expect(mergePreToolUseDecisionObjects({ decision: 'allow', updatedPermissions: [{ p: 1 }] }, { decision: 'deny' })?.updatedPermissions)
      .toBeUndefined();
    expect(mergePreToolUseDecisionObjects({ elicitationAction: 'accept', elicitationContent: { f: 1 } }, { elicitationAction: 'decline' })?.elicitationContent)
      .toBeUndefined();
  });

  it('answers identically through the native adapter, which is the collapse', () => {
    // `automations/automation-system.ts` used to carry a near-copy of this
    // function; it is now a two-line adapter. Same inputs, same answer.
    for (const first of RANKED) {
      for (const second of RANKED) {
        expect({ first, second, via: mergePreToolUseDecisions({ decision: first, reason: `r-${first}` }, {
          type: 'decision', decision: second, reason: `r-${second}`,
        }) }).toEqual({ first, second, via: mergePreToolUseDecisionObjects(
          { decision: first, reason: `r-${first}` }, { decision: second, reason: `r-${second}` },
        ) as never });
      }
    }
  });
});
