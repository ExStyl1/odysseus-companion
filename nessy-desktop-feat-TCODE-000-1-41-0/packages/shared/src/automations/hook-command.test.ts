/**
 * Tests for hook-command.ts — the live hook-output parser and the PreToolUse
 * decision derived from a hook command's exit status.
 *
 * This is the ONLY hook-output parser, full stop. It used to be merely the only
 * one reachable from production — `plugins/hooks-runtime.ts` held a second,
 * unreachable executor with its own vocabulary — and F4 deleted that one.
 */

import { describe, expect, it } from 'bun:test';
import { automationHookName, buildHookCommandEnv, buildHookErrorNotice, getHookCommandPreToolDecision, hookCommandBudgetMs, hookCommandStdinPayload, MAX_HOOK_TIMEOUT_MS, parseHookCommandOutput, parseHookOutputForEvent, readClaudeContractExitAsDocumented, resolveExecFormHookInvocation, resolveImportedHookTimeoutMs, runHookCommand } from './hook-command.ts';
import { executePluginHookAutomations, mergePreToolUseDecisions } from '../plugins/hooks-automation.ts';
import type { AgentEvent, HookCommandAction, HookCommandActionResult } from './types.ts';

function commandResult(overrides: Partial<HookCommandActionResult> = {}): HookCommandActionResult {
  return {
    type: 'command',
    command: 'x',
    success: true,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    ...overrides,
  };
}

const nativeAction: HookCommandAction = { type: 'command', command: 'x' };
/** What `pluginHookAction` builds for an imported plugin hook. */
const importedAction: HookCommandAction = { type: 'command', command: 'x', blockOnNonZero: false };

describe('parseHookCommandOutput', () => {
  it('blocks on the documented nested permissionDecision deny', () => {
    const decision = parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Secrets file is off limits',
      },
    }));

    expect(decision?.decision).toBe('deny');
    expect(decision?.reason).toContain('off limits');
  });

  it('parses the SessionStart quartet and the sessionTitle it shares with UserPromptSubmit', () => {
    // hooks.md:1067-1071's own example, extended with the other three fields
    // from the same table (:1059-1062).
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Current branch: feat/auth-refactor',
        sessionTitle: 'auth-refactor',
        initialUserMessage: 'review the diff',
        reloadSkills: true,
        watchPaths: ['/repo/skills', '/repo/commands'],
      },
    }))).toEqual({
      additionalContext: 'Current branch: feat/auth-refactor',
      sessionTitle: 'auth-refactor',
      initialUserMessage: 'review the diff',
      reloadSkills: true,
      watchPaths: ['/repo/skills', '/repo/commands'],
    });
    // hooks.md:1272-1278 — the UserPromptSubmit example nests it identically.
    expect(parseHookCommandOutput(JSON.stringify({
      decision: 'block',
      reason: 'Explanation for decision',
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'My session title' },
    }))).toMatchObject({ decision: 'block', sessionTitle: 'My session title' });
  });

  it('rejects the wrong shape and the wrong nesting for the SessionStart quartet', () => {
    // Nested ONLY: every documented example puts all five under
    // `hookSpecificOutput`, unlike additionalContext/updatedInput which the page
    // also shows at the top level.
    expect(parseHookCommandOutput(JSON.stringify({
      sessionTitle: 'top-level', reloadSkills: true, initialUserMessage: 'nope', watchPaths: ['/repo'],
    }))).toBeUndefined();
    // A non-string title, the string "true", and a relative path are each the
    // wrong shape for their documented type.
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        sessionTitle: 42,
        initialUserMessage: { text: 'no' },
        reloadSkills: 'true',
        watchPaths: ['relative/path', 7],
      },
    }))).toBeUndefined();
    // "Array of absolute paths": the absolute entries survive, the rest do not.
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', watchPaths: ['relative', '/repo/skills'] },
    }))).toEqual({ watchPaths: ['/repo/skills'] });
    // The documented 10,000-character per-field cap applies to both strings.
    const long = 'a'.repeat(10_050);
    const capped = parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: long, initialUserMessage: long },
    }));
    expect(capped?.sessionTitle).toHaveLength(10_000);
    expect(capped?.initialUserMessage).toHaveLength(10_000);
  });

  it('maps nested allow and ask', () => {
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    }))?.decision).toBe('allow');
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    }))?.decision).toBe('ask');
  });

  it('lets deny win over a top-level allow, in both orders', () => {
    // Claude: "If any hook returns deny, the operation is blocked regardless of
    // other hooks." A single hook emitting both must not resolve to allow.
    expect(parseHookCommandOutput(JSON.stringify({
      continue: true,
      decision: 'allow',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    }))?.decision).toBe('deny');
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
      decision: 'allow',
    }))?.decision).toBe('deny');
  });

  it('permissionDecision defer is a real decision (R7 Task 5), never read as deny', () => {
    // hooks.md defer-a-tool-call-for-later: `defer` suspends the call for a
    // later resume. Both documented spellings parse to the decision value.
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' },
    }))?.decision).toBe('defer');
    expect(parseHookCommandOutput(JSON.stringify({ decision: 'defer' }))?.decision).toBe('defer');
  });

  it('ranks the documented precedence deny > defer > ask > allow', () => {
    const table: Array<[Record<string, unknown>, string]> = [
      // deny beats defer
      [{ decision: 'deny', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } }, 'deny'],
      [{ decision: 'defer', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }, 'deny'],
      // defer beats ask
      [{ decision: 'defer', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }, 'defer'],
      [{ decision: 'ask', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } }, 'defer'],
      // defer beats allow
      [{ decision: 'allow', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } }, 'defer'],
      // ask beats allow (unchanged)
      [{ decision: 'allow', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }, 'ask'],
    ];
    for (const [payload, expected] of table) {
      expect(parseHookCommandOutput(JSON.stringify(payload))?.decision, JSON.stringify(payload)).toBe(expected as never);
    }
  });

  it('merges the same precedence across multiple hooks', () => {
    const defer = { type: 'decision' as const, decision: 'defer' as const };
    expect(mergePreToolUseDecisions({ decision: 'deny' }, defer).decision).toBe('deny');
    expect(mergePreToolUseDecisions({ decision: 'defer' }, { type: 'decision', decision: 'ask' }).decision).toBe('defer');
    expect(mergePreToolUseDecisions({ decision: 'ask' }, defer).decision).toBe('defer');
    expect(mergePreToolUseDecisions({ decision: 'allow' }, defer).decision).toBe('defer');
    expect(mergePreToolUseDecisions({ decision: 'defer' }, { type: 'decision', decision: 'deny' }).decision).toBe('deny');
  });

  it('defer alongside additionalContext keeps the context in the parse', () => {
    const out = parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer', additionalContext: 'ctx' },
    }));
    expect(out?.decision).toBe('defer');
    expect(out?.additionalContext).toBe('ctx');
  });

  it('keeps the top-level decision vocabulary and reason working', () => {
    const decision = parseHookCommandOutput(JSON.stringify({ decision: 'block', reason: 'policy' }));
    expect(decision).toEqual({ decision: 'block', reason: 'policy' });
    expect(parseHookCommandOutput(JSON.stringify({ continue: false }))?.decision).toBe('block');
    expect(parseHookCommandOutput(JSON.stringify({ continue: true }))?.decision).toBe('allow');
  });

  it('parses the PermissionRequest decision shape: allow with updatedInput', () => {
    // hooks.md#permissionrequest: hookSpecificOutput.decision =
    // { behavior, updatedInput (allow only), message/interrupt (deny only) }.
    const decision = parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { command: 'npm ci' } },
      },
    }));
    expect(decision).toEqual({ decision: 'allow', updatedInput: { command: 'npm ci' } });
  });

  it('parses the PermissionRequest decision shape: deny with message and interrupt', () => {
    const decision = parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'not on my watch', interrupt: true },
      },
    }));
    expect(decision).toEqual({ decision: 'deny', reason: 'not on my watch', interrupt: true });
  });

  it('enforces the allow-only/deny-only field pairing on PermissionRequest decisions', () => {
    // message/interrupt on allow are ignored; updatedInput/updatedPermissions
    // on deny are ignored.
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', message: 'noise', interrupt: true },
      },
    }))).toEqual({ decision: 'allow' });
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          updatedInput: { command: 'sneaky' },
          updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }],
        },
      },
    }))).toEqual({ decision: 'deny' });
  });

  it('captures updatedPermissions on a PermissionRequest allow', () => {
    const entries = [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'git:*' }] }];
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: entries },
      },
    }))).toEqual({ decision: 'allow', updatedPermissions: entries });
  });

  it('redacts a nested permissionDecisionReason like every other hook output path', () => {
    const decision = parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'rejected: api_key=abcdefghijklmnopqrstuvwxyz012345',
      },
    }));
    expect(decision?.reason).toContain('[REDACTED]');
    expect(decision?.reason).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });
});

describe('getHookCommandPreToolDecision', () => {
  it('blocks on exit 2 and reports stderr, per the documented contract', () => {
    const decision = getHookCommandPreToolDecision(importedAction, commandResult({
      success: false,
      exitCode: 2,
      stderr: 'policy violation',
      output: 'policy violation',
    }));

    expect(decision?.decision).toBe('block');
    expect(decision?.reason).toContain('policy violation');
  });

  it('does NOT block on other non-zero exits, but the failure is reported', () => {
    // hooks.md § Exit code output: "Any other exit code is a non-blocking error
    // for most hook events. The transcript shows a `<hook name> hook error`
    // notice followed by the first line of stderr [...] Execution continues and
    // the full stderr is written to the debug log."
    //
    // This test previously asserted ONLY `toBeUndefined()`, which pinned the
    // half of the contract that lets a crashed hook pass silently. The
    // no-block half is still asserted; the notice is what makes the other half
    // true instead of aspirational.
    const result = commandResult({
      success: false,
      exitCode: 1,
      stderr: 'transient\nstack frame 1\nstack frame 2',
      output: 'transient\nstack frame 1\nstack frame 2',
    });
    expect(getHookCommandPreToolDecision(importedAction, result)).toBeUndefined();

    const notice = buildHookErrorNotice({ event: 'PreToolUse', hookName: 'acme/guard', result, blocked: false });
    expect(notice).toEqual({
      hookName: 'acme/guard',
      event: 'PreToolUse',
      exitCode: 1,
      summary: 'transient',
      detail: 'transient\nstack frame 1\nstack frame 2',
    });
  });

  it('reports no notice for a success or for a failure that blocked', () => {
    // Exit 2 feeds stderr to the model as the blocking reason; reporting it a
    // second time as a user-facing hook error would double-count one failure.
    expect(buildHookErrorNotice({
      event: 'PreToolUse',
      hookName: 'acme/guard',
      result: commandResult({ success: false, exitCode: 2, stderr: 'policy violation' }),
      blocked: true,
    })).toBeUndefined();
    expect(buildHookErrorNotice({
      event: 'PreToolUse',
      hookName: 'acme/guard',
      result: commandResult({ stdout: '{}' }),
      blocked: false,
    })).toBeUndefined();
  });

  /**
   * P6.449, the Pi arm. This runner IS Pi's hook mechanism, so the two facts
   * below were reported on no surface at all for a Pi session. Each case kills
   * one of the two selections the old `stderr || error || output` made.
   */
  it('says a hook TIMED OUT even when it also wrote to stderr', () => {
    // The shadowing arm: the runner puts its own sentence in `error`, and any
    // byte on stderr used to win, so the budget kill vanished. The timeout
    // leads, which makes it the `summary` the transcript renders.
    const notice = buildHookErrorNotice({
      event: 'PostToolUse',
      hookName: 'acme/slow',
      result: commandResult({
        success: false,
        exitCode: null,
        timedOut: true,
        stderr: 'warming up',
        error: 'Hook command timed out after 5000ms.',
      }),
      blocked: false,
    });

    expect(notice?.summary).toBe('Hook command timed out after 5000ms.');
    expect(notice?.detail).toBe('Hook command timed out after 5000ms.\nwarming up');
  });

  it('does not say the timeout twice when that is all there was', () => {
    // The boundary of the case above: with no streams, `error` is reached as the
    // last resort AND is the timeout note, and one failure must read as one.
    const notice = buildHookErrorNotice({
      event: 'PostToolUse',
      hookName: 'acme/slow',
      result: commandResult({
        success: false,
        exitCode: null,
        timedOut: true,
        error: 'Hook command timed out after 5000ms.',
        output: 'Hook command timed out after 5000ms.',
      }),
      blocked: false,
    });

    expect(notice?.summary).toBe('Hook command timed out after 5000ms.');
    expect(notice?.detail).toBeUndefined();
  });

  it('keeps stdout when stderr also has text, each stream labelled', () => {
    // The dropping arm: a hook that diagnoses on stdout and prints a generic
    // line to stderr showed only the generic line. Same defect and same fix as
    // the claude arm's, which is why one function answers it for all three.
    const notice = buildHookErrorNotice({
      event: 'PreToolUse',
      hookName: 'acme/guard',
      result: commandResult({
        success: false,
        exitCode: 1,
        stdout: 'rule "no-curl-pipe-sh" matched at line 3',
        stderr: 'guard failed',
        output: 'rule "no-curl-pipe-sh" matched at line 3\nguard failed',
      }),
      blocked: false,
    });

    expect(notice?.detail).toBe('stderr: guard failed\nstdout: rule "no-curl-pipe-sh" matched at line 3');
    expect(notice?.summary).toBe('stderr: guard failed');
  });

  it('reports a stdout-only failure, with no stderr and no error at all', () => {
    const notice = buildHookErrorNotice({
      event: 'PostToolUse',
      hookName: 'acme/audit',
      result: commandResult({ success: false, exitCode: 3, stdout: 'audit rejected the write' }),
      blocked: false,
    });

    expect(notice?.summary).toBe('audit rejected the write');
  });

  it('falls back to the exit code when a failing hook printed nothing', () => {
    const notice = buildHookErrorNotice({
      event: 'PostToolUse',
      hookName: 'acme/audit',
      result: commandResult({ success: false, exitCode: 127 }),
      blocked: false,
    });
    expect(notice?.summary).toBe('Hook command exited with code 127.');
    expect(notice?.detail).toBeUndefined();
  });

  it('selects exec form on args presence and substitutes only path placeholders', () => {
    // hooks.md § Exec form and shell form. Presence of `args` selects the form,
    // so the empty vector is exec form and an absent one is shell form. Inside
    // exec form the documented substitution is the PATH PLACEHOLDER set only:
    // "special characters such as apostrophes, `$`, and backticks pass through
    // verbatim because there is no shell to interpret them".
    const env = { NESSY_PLUGIN_ROOT: '/bundles/acme', HOME: '/home/user' };
    expect(resolveExecFormHookInvocation({ command: 'node' }, env)).toBeUndefined();
    expect(resolveExecFormHookInvocation({ command: 'node', args: [] }, env)).toEqual({
      command: 'node',
      args: [],
    });
    expect(resolveExecFormHookInvocation({
      command: '${NESSY_PLUGIN_ROOT}/bin/lint',
      args: ['${NESSY_PLUGIN_ROOT}/rules.json', '$HOME/notes `id`', '${UNKNOWN_TOKEN}'],
    }, env)).toEqual({
      command: '/bundles/acme/bin/lint',
      args: ['/bundles/acme/rules.json', '$HOME/notes `id`', '${UNKNOWN_TOKEN}'],
    });
  });

  it('names the hook from the matcher name, then its id, then a generic label', () => {
    expect(automationHookName({ name: 'acme/guard', id: 'abc123' })).toBe('acme/guard');
    expect(automationHookName({ id: 'abc123' })).toBe('abc123');
    expect(automationHookName({ name: '  ' })).toBe('Automation');
  });

  it('does not parse stdout on a failed exit under Claude semantics', () => {
    // Exit 2 "blocks regardless of JSON content". An exit 1 that printed JSON
    // is read as exit 0 BEFORE this function sees it (UB12.93, the executor's
    // `readClaudeContractExitAsDocumented`; its arms are at the end of the file).
    expect(getHookCommandPreToolDecision(importedAction, commandResult({
      success: false,
      exitCode: 1,
      stdout: JSON.stringify({ decision: 'allow' }),
    }))).toBeUndefined();
    expect(getHookCommandPreToolDecision(importedAction, commandResult({
      success: false,
      exitCode: 2,
      stdout: JSON.stringify({ decision: 'allow' }),
      stderr: 'blocked',
    }))?.decision).toBe('block');
  });

  it('keeps native automations blocking on any non-zero exit', () => {
    expect(getHookCommandPreToolDecision(nativeAction, commandResult({
      success: false,
      exitCode: 1,
      output: 'boom',
    }))?.decision).toBe('block');
    expect(getHookCommandPreToolDecision(nativeAction, commandResult({
      success: false,
      exitCode: 2,
      output: 'boom',
    }))?.decision).toBe('block');
  });

  it('parses stdout on exit 0', () => {
    const decision = getHookCommandPreToolDecision(nativeAction, commandResult({
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' },
      }),
    }));
    expect(decision).toEqual({ decision: 'deny', reason: 'nope' });
  });

  /**
   * C3.350 — a stalled hook produces no words of its own, so the block reason is
   * the only thing the person meets and it has to carry all three facts: the
   * hook, the budget, and the way out. The POSTURE is unchanged — a native
   * command hook that fails still blocks, and a timed-out run has failed.
   */
  describe('a TIMEOUT block says whose budget ran out (C3.350)', () => {
    const timedOut = commandResult({
      success: false,
      exitCode: null,
      timedOut: true,
      error: 'Hook command timed out after 30000ms.',
    });

    it('names the hook, the event, the budget and both documented ways out', () => {
      const decision = getHookCommandPreToolDecision(nativeAction, timedOut, {
        hookName: 'acme/guard',
        event: 'UserPromptSubmit',
      });
      // Read into a local FIRST — the reason is asserted four ways and
      // `toMatchObject` mutates what it is handed (AGENTS.md §Traps).
      const reason = decision?.reason ?? '';
      expect(decision?.decision).toBe('block');
      expect(reason).toContain('"acme/guard"');
      expect(reason).toContain('UserPromptSubmit');
      // The runner's own words, not a re-derived number: a host-injected runner
      // enforces its own budget and states it.
      expect(reason).toContain('timed out after 30000ms');
      expect(reason).toContain('`timeout`');
      expect(reason).toContain('`async: true`');
      // C4.47 — and the clause that stops the sentence above being misleading.
      // `async: true` stops a hook BLOCKING; this host still cancels it, where
      // `hooks.md#run-hooks-in-the-background` says the vendor does not. The
      // person meeting this string on `UserPromptSubmit` gets no second surface.
      expect(reason).toContain('still cancelled here');
      expect(reason).toContain(`${MAX_HOOK_TIMEOUT_MS}ms`);
    });

    it('falls back to the action\'s own budget when the runner stated none', () => {
      const reason = getHookCommandPreToolDecision(
        { type: 'command', command: 'x', timeoutMs: 5_000 },
        commandResult({ success: false, exitCode: null, timedOut: true }),
        { event: 'PreToolUse' },
      )?.reason ?? '';
      expect(reason).toContain('5000ms');
      // No name to give, so it does not invent one.
      expect(reason).toContain('A hook on PreToolUse');
    });

    /**
     * C4.47 (owner decision 2026-09-13, option A + the honesty debt).
     *
     * The host KEEPS enforcing `timeout` on a plain `async` hook, where
     * `hooks.md#run-hooks-in-the-background` says the vendor does not — the
     * packaged path starts every hook through a supervisor whose
     * `SupervisedProcessStartRequest.timeoutMs` is a required `number`, so there
     * is no unbounded foreground mode to match the page with. What moved is the
     * NUMBER: the budget was 30 s, which is the page's default for a `prompt`
     * hook and smaller than its 600 s default for a `command` hook, applied to
     * the one kind of hook the page promises not to time out at all.
     */
    it('C4.47 · a plain async hook gets the DOCUMENTED command budget, not the 30 s default', () => {
      expect(hookCommandBudgetMs({ type: 'command', command: 'x', async: true }))
        .toBe(MAX_HOOK_TIMEOUT_MS);
      // The page's own async example is a background `run-tests.sh` in a
      // `hooks.json`: it was SIGTERM'd at 30 s here, with no decision surface,
      // because an async hook's result is never read back for a notice on the
      // settings tier.
      expect(hookCommandBudgetMs({ type: 'command', command: 'x', async: true })).toBeGreaterThan(30_000);
    });

    it('C4.47 · asyncRewake keeps the 30 s default, because the page enforces timeout on it BY NAME', () => {
      // *"Claude Code still enforces `timeout` on a hook you run with
      // `asyncRewake`"*. The order of the two tests in `hookCommandBudgetMs` is
      // the contract: `asyncRewake` implies `async`, so a widening that read
      // `async` alone would have covered it.
      expect(hookCommandBudgetMs({ type: 'command', command: 'x', async: true, asyncRewake: true }))
        .toBe(30_000);
    });

    it('C4.47 · CONTROLS — a declared budget still wins, and a blocking hook is unmoved', () => {
      // A declared value is an author's own ask and is honoured async or not,
      // still bounded by the documented ceiling.
      expect(hookCommandBudgetMs({ type: 'command', command: 'x', async: true, timeoutMs: 5_000 }))
        .toBe(5_000);
      expect(hookCommandBudgetMs({ type: 'command', command: 'x', async: true, timeoutMs: 900_000 }))
        .toBe(MAX_HOOK_TIMEOUT_MS);
      // The negative control, and the one that proves this is scoped to async:
      // an ordinary blocking hook keeps exactly the budget it had.
      expect(hookCommandBudgetMs({ type: 'command', command: 'x' })).toBe(30_000);
      expect(hookCommandBudgetMs({ type: 'command', command: 'x', async: false })).toBe(30_000);
      expect(hookCommandBudgetMs({ type: 'command', command: 'x', timeoutMs: 5_000 })).toBe(5_000);
    });

    it('a NON-timeout failure keeps the hook\'s own words (the control)', () => {
      const reason = getHookCommandPreToolDecision(
        nativeAction,
        commandResult({ success: false, exitCode: 1, output: 'guard refused' }),
        { hookName: 'acme/guard', event: 'UserPromptSubmit' },
      )?.reason ?? '';
      expect(reason).toBe('guard refused');
      expect(reason).not.toContain('did not finish in time');
    });

    it('an IMPORTED hook that times out still renders no decision at all', () => {
      // `hooks.md#timeouts`: "Claude Code cancels a `command`, `http`, or
      // `mcp_tool` hook that reaches its `timeout`, discarding the hook's
      // output, so on most events a timed-out hook renders no decision." The
      // three-way semantics `pluginHookAction` opts into already answer that
      // way, and this row does not change it.
      expect(getHookCommandPreToolDecision(importedAction, timedOut, {
        hookName: 'acme/guard',
        event: 'UserPromptSubmit',
      })).toBeUndefined();
    });
  });
});

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('parseHookOutputForEvent — universal output fields (R9)', () => {
  it('reports the event pattern alongside the parse', () => {
    expect(parseHookOutputForEvent('{}', 'Stop').pattern).toBe('top-level');
    expect(parseHookOutputForEvent('{}', 'PermissionRequest').pattern).toBe('hook-specific');
    expect(parseHookOutputForEvent('{}', 'TaskCreated').pattern).toBe('exit-code-only');
    expect(parseHookOutputForEvent('{}', 'WorktreeCreate').pattern).toBe('path-return');
    expect(parseHookOutputForEvent('{}', 'SessionStart').pattern).toBe('context-only');
  });

  it('continue:false wins over an event-specific decision', () => {
    const out = parseHookOutputForEvent('{"continue":false,"stopReason":"halt","decision":"block","reason":"r"}', 'Stop');
    expect(out.universal.continue).toBe(false);
    expect(out.universal.stopReason).toBe('halt');
    // The stop is the harder of the two, so it survives as the payload block —
    // an `allow` alongside it can never demote it.
    expect(out.payload.decision).toBe('block');
  });

  it('continue:false still stops an exit-code-only event that has no decision field', () => {
    const out = parseHookOutputForEvent('{"continue":false,"stopReason":"rolled back"}', 'TaskCreated');
    expect(out.universal.continue).toBe(false);
    expect(out.payload.decision).toBe('block');
  });

  it('stopReason is shown to the user, never fed to the model as the block reason', () => {
    const out = parseHookOutputForEvent('{"continue":false,"stopReason":"user-facing only"}', 'Stop');
    expect(out.payload.reason).toBeUndefined();
  });

  it('every output string is capped at 10000 characters', () => {
    const long = 'x'.repeat(10_050);
    const out = parseHookOutputForEvent(JSON.stringify({ systemMessage: long, stopReason: long }), 'Stop');
    expect(out.universal.systemMessage).toHaveLength(10_000);
    expect(out.universal.stopReason).toHaveLength(10_000);
    const withBody = parseHookOutputForEvent(JSON.stringify({
      decision: 'block',
      reason: long,
      hookSpecificOutput: { additionalContext: long, updatedToolOutput: long },
    }), 'PostToolUse');
    expect(withBody.payload.reason).toHaveLength(10_000);
    expect(withBody.payload.additionalContext).toHaveLength(10_000);
    expect(withBody.payload.updatedToolOutput).toHaveLength(10_000);
  });

  it('carries suppressOutput and systemMessage, dropping wrong-typed values', () => {
    const out = parseHookOutputForEvent('{"suppressOutput":true,"systemMessage":"heads up"}', 'Stop');
    expect(out.universal.suppressOutput).toBe(true);
    expect(out.universal.systemMessage).toBe('heads up');
    expect(parseHookOutputForEvent('{"suppressOutput":"yes"}', 'Stop').universal.suppressOutput).toBeUndefined();
    expect(parseHookOutputForEvent('{"stopReason":42}', 'Stop').universal.stopReason).toBeUndefined();
  });

  it('terminalSequence outside the OSC allowlist is ignored whole', () => {
    // OSC 4 (colour), OSC 52 (clipboard write), OSC 8 (hyperlink) and CSI are
    // all rejected — the field is dropped, never sanitised into something else.
    for (const raw of [`${ESC}]4;evil${BEL}`, `${ESC}]52;c;ZXZpbA==${BEL}`, `${ESC}]8;;http://evil${BEL}`, `${ESC}[2J`]) {
      expect(parseHookOutputForEvent(JSON.stringify({ terminalSequence: raw }), 'Stop').universal.terminalSequence)
        .toBeUndefined();
    }
  });

  it('terminalSequence inside the OSC allowlist survives', () => {
    for (const code of ['0', '1', '2', '9', '99', '777']) {
      const raw = `${ESC}]${code};nessy${BEL}`;
      expect(parseHookOutputForEvent(JSON.stringify({ terminalSequence: raw }), 'Stop').universal.terminalSequence).toBe(raw);
    }
    // A bare BEL is the documented no-OSC notification.
    expect(parseHookOutputForEvent(JSON.stringify({ terminalSequence: BEL }), 'Stop').universal.terminalSequence).toBe(BEL);
  });

  it('an exit-code-only event ignores a decision field', () => {
    const out = parseHookOutputForEvent('{"decision":"block","reason":"nope"}', 'TaskCreated');
    expect(out.payload).toEqual({});
  });

  it('leaves the PreToolUse parse identical to parseHookCommandOutput', () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' },
    });
    expect(parseHookOutputForEvent(stdout, 'PreToolUse').payload).toEqual(parseHookCommandOutput(stdout)!);
  });

  it('returns empty universal and payload for non-JSON stdout', () => {
    expect(parseHookOutputForEvent('not json at all', 'Stop')).toEqual({
      universal: {}, pattern: 'top-level', payload: {},
    });
  });
});

/**
 * D7 — a command hook can read its input.
 *
 * hooks.md § Hook input and output: "Command hooks receive JSON data via
 * stdin", and the page's own blocking example is built on it:
 * `input=$(cat)` … `command=$(jq -r '.tool_input.command' <<<"$input")`.
 * `runHookCommand` spawned with `stdio: ['ignore', …]` and wrote nothing, so
 * every such hook read empty and allowed.
 */
describe('runHookCommand stdin', () => {
  const script = (body: string): HookCommandAction => ({
    type: 'command',
    command: process.execPath,
    args: ['-e', body],
  });

  it('delivers the documented JSON payload to a hook that reads stdin', async () => {
    const result = await runHookCommand(
      script(`
        let raw = '';
        process.stdin.on('data', chunk => { raw += chunk; });
        process.stdin.on('end', () => {
          const input = JSON.parse(raw);
          if (input.hook_event_name !== 'PreToolUse') { console.error('event: ' + input.hook_event_name); process.exit(9); }
          if (input.tool_input.command !== 'rm -rf /') { console.error('command missing'); process.exit(9); }
          if (typeof input.cwd !== 'string' || input.cwd.length === 0) { console.error('cwd missing'); process.exit(9); }
          console.log(JSON.stringify({ decision: 'block', reason: 'blocked ' + input.tool_input.command }));
        });
      `),
      {
        event: 'PreToolUse',
        input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
        cwd: process.cwd(),
      },
    );

    expect(result.success).toBe(true);
    expect(parseHookCommandOutput(result.stdout ?? '')).toEqual({
      decision: 'block',
      reason: 'blocked rm -rf /',
    });
  });

  it('completes rather than deadlocking when the hook ignores a payload larger than the pipe buffer', async () => {
    const result = await runHookCommand(
      script('console.log("done"); process.exit(0);'),
      {
        event: 'PreToolUse',
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          // Past the 64 KiB OS pipe buffer, which is where a blocking write
          // would stall a host that waited on the flush. Not larger: the same
          // JSON also rides `NESSY_EVENT_DATA` (and `NESSY_TOOL_INPUT`), and
          // Linux caps a SINGLE env string at MAX_ARG_STRLEN = 128 KiB — at
          // 128 KiB of content the JSON wrapper pushed both entries over it
          // and the spawn itself died with E2BIG on any Linux host (macOS
          // only caps the total env block, which is why it passed there).
          tool_input: { content: 'x'.repeat(96 * 1024) },
        },
        cwd: process.cwd(),
      },
    );

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.trim()).toBe('done');
  });

  it('keeps the invocation cwd out of the payload when the event already carries one', () => {
    const carried = hookCommandStdinPayload('CwdChanged', {
      hook_event_name: 'CwdChanged',
      cwd: '/from/event',
    }, '/from/invocation');
    expect(JSON.parse(carried).cwd).toBe('/from/event');
    const filled = hookCommandStdinPayload('PreToolUse', { hook_event_name: 'PreToolUse' }, '/from/invocation');
    expect(JSON.parse(filled).cwd).toBe('/from/invocation');
  });

  it('passes the documented CwdChanged and FileChanged keys through the stdin spread untouched', () => {
    // The claim the CwdChanged/FileChanged fix rests on: `hookCommandStdinPayload`
    // is a verbatim spread, so adding documented keys at the EMITTER is enough
    // and this serializer needs no per-event knowledge.
    const cwdChanged = JSON.parse(hookCommandStdinPayload('CwdChanged', {
      hook_event_name: 'CwdChanged',
      cwd: '/repo/sub', new_cwd: '/repo/sub', old_cwd: '/repo', previous_cwd: '/repo',
    }, '/from/invocation'));
    expect(cwdChanged.new_cwd).toBe('/repo/sub');
    expect(cwdChanged.old_cwd).toBe('/repo');
    const fileChanged = JSON.parse(hookCommandStdinPayload('FileChanged', {
      hook_event_name: 'FileChanged', file_path: '/repo/.envrc', event: 'change',
    }, '/repo'));
    expect(fileChanged.file_path).toBe('/repo/.envrc');
    expect(fileChanged.event).toBe('change');
  });

  it('exports the active effort level to a hook process under both spellings', () => {
    // hooks.md `:707` — "The level is also available to hook commands and the
    // Bash tool as the `$CLAUDE_EFFORT` environment variable." `CLAUDE_EFFORT`
    // is the only spelling the page gives; `NESSY_EFFORT` rides along by the
    // both-spellings convention the skills path already uses.
    const env = buildHookCommandEnv('PreToolUse', {
      hook_event_name: 'PreToolUse',
      effort: { level: 'xhigh' },
    });
    expect(env.CLAUDE_EFFORT).toBe('xhigh');
    expect(env.NESSY_EFFORT).toBe('xhigh');
    // The documented shape is an OBJECT, so the stdin JSON must answer
    // `.effort.level` and not a bare string.
    expect(JSON.parse(hookCommandStdinPayload('PreToolUse', {
      hook_event_name: 'PreToolUse', effort: { level: 'xhigh' },
    }, '/repo')).effort.level).toBe('xhigh');
  });

  it('sets NO effort variable and no effort key when the turn has no level to report', () => {
    // The negative, and the one that must never regress into a default: an
    // absent effort means "nothing to report" — a session at Nessy's `off`, or
    // a model that does not support the effort parameter — and must NOT become
    // `"medium"`.
    const env = buildHookCommandEnv('PreToolUse', { hook_event_name: 'PreToolUse' });
    expect(env).not.toHaveProperty('CLAUDE_EFFORT');
    expect(env).not.toHaveProperty('NESSY_EFFORT');
    expect(JSON.parse(hookCommandStdinPayload('PreToolUse', {
      hook_event_name: 'PreToolUse',
    }, '/repo'))).not.toHaveProperty('effort');
  });
});

describe('R64 SessionStart output fields survive the non-deciding parse path', () => {
  it('carries the quartet for an http/mcp hook body, which the decision gate used to drop', () => {
    // `parseHookOutputForEvent` is the shape mcp_tool and http hook verdicts go
    // through (`plugins/hooks-automation.ts` consumes `parsed.payload`).
    // SessionStart's stdout cannot decide, so before R64 the payload was `{}`
    // for every field except the one `displayContent` escape hatch.
    const out = parseHookOutputForEvent(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'branch info',
          sessionTitle: 'auth-refactor',
          initialUserMessage: 'review the diff',
          reloadSkills: true,
          watchPaths: ['/repo/skills'],
        },
      }),
      'SessionStart',
    );
    expect(out.pattern).toBe('context-only');
    expect(out.payload).toEqual({
      additionalContext: 'branch info',
      sessionTitle: 'auth-refactor',
      initialUserMessage: 'review the diff',
      reloadSkills: true,
      watchPaths: ['/repo/skills'],
    });
  });

  it('still refuses a stdout decision on the events that decide by exit code only', () => {
    // The general form must not have widened R20's rule: `hookEventStdoutCanDecide`
    // is about the `decision` FIELD, and stripping it is all the new branch does.
    for (const event of ['TaskCreated', 'TaskCompleted', 'WorktreeCreate'] as AgentEvent[]) {
      expect(parseHookOutputForEvent('{"decision":"block","reason":"nope"}', event).payload).toEqual({});
    }
    // And SessionStart gains no decision either — `NO_VALUES` is still its surface.
    expect(parseHookOutputForEvent(
      JSON.stringify({ decision: 'block', reason: 'nope', hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: 't' } }),
      'SessionStart',
    ).payload).toEqual({ sessionTitle: 't' });
  });

  // hooks.md:947 names three events in SessionStart's row; the third is `Setup`,
  // which R73 · f001 removed from the inventory (no `--init-only` launch mode),
  // so `SubagentStart` is the only one left to hold the line here.
  it('keeps the four fields off SubagentStart, which shares SessionStart\'s doc row', () => {
    for (const event of ['SubagentStart'] as AgentEvent[]) {
      expect(parseHookOutputForEvent(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event, additionalContext: 'ctx', sessionTitle: 'nope', reloadSkills: true,
          },
        }),
        event,
      ).payload).toEqual({ additionalContext: 'ctx' });
    }
  });
});

describe('R32 MessageDisplay hook output and timeout', () => {
  it('carries hookSpecificOutput.displayContent through as the event\'s whole surface', () => {
    // hooks.md:1311 — "`displayContent` | Text displayed in place of the delta."
    // The event's stdout cannot decide (":1313 no decision control"), which is
    // exactly why this needed its own path: the decision gate yields `{}`.
    const out = parseHookOutputForEvent(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: 'token is [redacted]' },
      }),
      'MessageDisplay',
    );
    expect(out.pattern).toBe('hook-specific');
    expect(out.payload).toEqual({ displayContent: 'token is [redacted]' });
  });

  it('projects away everything MessageDisplay is not allowed to say', () => {
    // ":1313 They can't block the message or change what is stored in the
    // transcript or sent to Claude" — so a decision, a reason, replacement input
    // and model-visible context all die at the contract table. `continue: false`
    // is the one universal that outranks every event's surface and stays.
    const out = parseHookOutputForEvent(
      JSON.stringify({
        decision: 'block',
        reason: 'nope',
        hookSpecificOutput: {
          hookEventName: 'MessageDisplay',
          displayContent: 'shown',
          additionalContext: 'model should not see this',
          updatedInput: { a: 1 },
          updatedToolOutput: 'rewritten',
        },
      }),
      'MessageDisplay',
    );
    expect(out.payload).toEqual({ displayContent: 'shown' });
  });

  it('omits displayContent when the hook omits it, and drops it on every other event', () => {
    // ":1311 Omit it to display the original", and the field is MessageDisplay's
    // alone — a Stop hook cannot borrow it to rewrite the screen.
    expect(parseHookOutputForEvent('{}', 'MessageDisplay').payload.displayContent).toBeUndefined();
    const borrowed = parseHookOutputForEvent(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', displayContent: 'nope' } }),
      'Stop',
    );
    expect(borrowed.payload.displayContent).toBeUndefined();
    // The raw parse does see it; the per-event projection is what removes it, so
    // the drop is a contract decision and not a parser omission.
    expect(parseHookCommandOutput(
      JSON.stringify({ hookSpecificOutput: { displayContent: 'nope' } }),
    )?.displayContent).toBe('nope');
  });

  it('lowers an imported MessageDisplay hook default to 10 seconds without capping it', () => {
    // hooks.md:345 — "`UserPromptSubmit` lowers the `command`, `http`, and
    // `mcp_tool` default to 30, and `MessageDisplay` lowers it to 10." A DEFAULT:
    // ":1271 if your hook needs more time, set the `timeout` field".
    for (const type of ['command', 'http', 'mcp'] as const) {
      expect(resolveImportedHookTimeoutMs('MessageDisplay', type, undefined)).toBe(10_000);
    }
    expect(resolveImportedHookTimeoutMs('MessageDisplay', 'command', 25_000)).toBe(25_000);
    // Unrelated events keep the 600 s documented default.
    expect(resolveImportedHookTimeoutMs('Stop', 'command', undefined)).toBe(600_000);
  });
});

/**
 * F1.875 — a `hooks.json` hook with neither a `name` nor an `id` was reported as
 * the literal 'Automation' in every hook-error row. Read, not invented: the
 * vendored claude (2.1.267) prints `<hook name> hook error` with the hook name
 * built from the EVENT — `hookName:"UserPromptSubmit"` — and, on the three tool
 * events, `PreToolUse:${tool.name}`. The host now falls back to that same label,
 * so a nameless host hook reads exactly as the claude runtime's own notice does.
 */
describe('automationHookName — a nameless hook takes the event label claude prints (F1.875)', () => {
  it('names a nameless hook by its event, and by `<event>:<tool>` on a tool event', () => {
    expect(automationHookName({}, { event: 'UserPromptSubmit' })).toBe('UserPromptSubmit');
    expect(automationHookName({}, { event: 'PreToolUse', toolName: 'Bash' })).toBe('PreToolUse:Bash');
    expect(automationHookName({ name: '  ' }, { event: 'PostToolUse', toolName: 'Edit' })).toBe('PostToolUse:Edit');
    expect(automationHookName({}, { event: 'PostToolUseFailure', toolName: 'Write' })).toBe('PostToolUseFailure:Write');
  });

  it('CONTROLS — a name or an id still wins, a non-tool event takes no tool, and no event keeps the generic word', () => {
    // A named hook and an imported plugin hook (`<pluginId>/<hookId>`) keep their name.
    expect(automationHookName({ name: 'acme/guard', id: 'abc123' }, { event: 'PreToolUse', toolName: 'Bash' })).toBe('acme/guard');
    expect(automationHookName({ id: 'abc123' }, { event: 'UserPromptSubmit' })).toBe('abc123');
    // claude 2.1.267 prints `hookName:"PermissionRequest"` with no tool suffix.
    expect(automationHookName({}, { event: 'PermissionRequest', toolName: 'Bash' })).toBe('PermissionRequest');
    expect(automationHookName({}, { event: 'PreToolUse' })).toBe('PreToolUse');
    expect(automationHookName({})).toBe('Automation');
  });

  it('a timeout sentence does not quote an event label back as the hook\'s name', () => {
    const timedOut = commandResult({ success: false, exitCode: null, timedOut: true, error: 'Hook command timed out after 30000ms.' });
    const unnamed = getHookCommandPreToolDecision(nativeAction, timedOut, { hookName: 'UserPromptSubmit', event: 'UserPromptSubmit' })?.reason ?? '';
    expect(unnamed.startsWith('A hook on UserPromptSubmit did not finish in time')).toBe(true);
    const onTool = getHookCommandPreToolDecision(nativeAction, timedOut, { hookName: 'PreToolUse:Bash', event: 'PreToolUse' })?.reason ?? '';
    expect(onTool.startsWith('A hook on PreToolUse:Bash did not finish in time')).toBe(true);
    // The control: a hook the author named is still quoted by that name.
    const named = getHookCommandPreToolDecision(nativeAction, timedOut, { hookName: 'acme/guard', event: 'UserPromptSubmit' })?.reason ?? '';
    expect(named.startsWith('The "acme/guard" hook on UserPromptSubmit did not finish in time')).toBe(true);
  });

  it('the real dispatcher names a nameless tool-event hook `<event>:<tool>` and keeps a named one', async () => {
    const config = { automations: { PreToolUse: [
      { actions: [{ type: 'command', command: 'echo nameless' }] },
      { name: 'acme/guard', actions: [{ type: 'command', command: 'echo named' }] },
    ] } } as any;
    const result = await executePluginHookAutomations(config, 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Bash' } as any, {
      workspaceRootPath: process.cwd(),
      runner: async action => commandResult({ command: action.command }),
    });
    expect(result.hookRuns?.map(run => run.name)).toEqual(['PreToolUse:Bash', 'acme/guard']);
  });
});

/**
 * UB12.93 — `hooks.md#exit-code-output` (curl'd 2026-10-17), the table row "JSON
 * object that passes schema validation" by column "Any other exit code",
 * verbatim: "Success. Claude Code ignores the exit code, and the fields alone
 * decide. For hooks whose failure blocks the action, the run counts as a
 * failure instead". Premise at `ec06707a2`: a Claude-contract PreToolUse hook
 * that exited 1 with `permissionDecision: "deny"` produced NO decision and a
 * hook-error notice, so the tool ran.
 */
describe('UB12.93 — a Claude-contract exit 1 that printed JSON: the fields alone decide', () => {
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'policy says no' } });
  const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  const fire = (action: Partial<HookCommandAction>, result: HookCommandActionResult) => executePluginHookAutomations(
    { automations: { PreToolUse: [{ id: 'policy/guard', name: 'policy/guard', actions: [{ type: 'command', command: './guard.sh', ...action }] }] } } as any,
    'PreToolUse',
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } } as any,
    { workspaceRootPath: process.cwd(), runner: async () => result },
  );

  it('POSITIVE: exit 1 with a deny JSON blocks the tool call with the hook\'s reason and raises no hook-error notice', async () => {
    const result = await fire({ blockOnNonZero: false }, commandResult({ success: false, exitCode: 1, stdout: deny, stderr: 'exiting 1 on purpose' }));
    expect(result.decision).toEqual({ decision: 'deny', reason: 'policy says no' });
    expect(result.hookErrors).toBeUndefined();
    expect(result.hookRunFailed).toBeUndefined();
  });

  it('NEGATIVE: exit 1 with plain text stays the non-blocking notice, and the tool goes ahead', async () => {
    const result = await fire({ blockOnNonZero: false }, commandResult({ success: false, exitCode: 1, stdout: 'not json', stderr: 'guard crashed' }));
    expect(result.decision?.decision).toBeUndefined();
    expect(result.hookErrors?.length).toBe(1);
    expect(result.hookRunFailed).toBe(true);
  });

  it('BOUNDARY: with onFailure "block", exit 1 with an ALLOW JSON still blocks (UB12.67: the run counts as a failure)', async () => {
    const result = await fire({ blockOnNonZero: false, onFailure: 'block' }, commandResult({ success: false, exitCode: 1, stdout: allow, stderr: 'guard crashed' }));
    expect(result.decision?.decision).toBe('block');
    const reason = result.decision?.reason ?? '';
    expect(reason.startsWith('[./guard.sh]: failed; blocking because onFailure is "block"')).toBe(true);
  });

  it('CONTROLS: a native hook still blocks on exit 1 whatever its JSON says; exit-1 JSON that fails the schema is the notice, not a decision', async () => {
    const native = await fire({}, commandResult({ success: false, exitCode: 1, stdout: allow, output: 'boom' }));
    expect(native.decision?.decision).toBe('block');
    const invalid = await fire({ blockOnNonZero: false }, commandResult({ success: false, exitCode: 1, stdout: JSON.stringify({ decision: 'deny' }) }));
    expect(invalid.decision?.decision).toBeUndefined();
    const summary = invalid.hookErrors?.[0]?.summary ?? '';
    expect(summary.startsWith('Hook output failed schema validation')).toBe(true);
  });

  it('exit 2, a timeout, and the events whose non-zero exit decides by itself do not read the JSON', () => {
    const exit1Json = commandResult({ success: false, exitCode: 1, stdout: allow });
    expect(readClaudeContractExitAsDocumented({ blockOnNonZero: false }, exit1Json, 'PreToolUse', false).success).toBe(true);
    for (const event of ['WorktreeRemove', 'McpElicitation', 'ElicitationResult']) {
      expect(readClaudeContractExitAsDocumented({ blockOnNonZero: false }, exit1Json, event, false).success).toBe(false);
    }
    expect(readClaudeContractExitAsDocumented({ blockOnNonZero: false }, commandResult({ success: false, exitCode: 2, stdout: allow }), 'PreToolUse', false).success).toBe(false);
    expect(readClaudeContractExitAsDocumented({ blockOnNonZero: false }, commandResult({ success: false, exitCode: null, timedOut: true, stdout: allow }), 'PreToolUse', false).success).toBe(false);
  });
});
