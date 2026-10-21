import { describe, expect, it } from 'bun:test';

import { ClaudeAgent } from '../claude-agent.ts';

/**
 * R28 — the delivery hop, at the Claude agent boundary.
 *
 * The rules machinery (discovery, parsing, the per-read trigger, the pending
 * buffer) lives on `BaseAgent` and its own suites cover it. The Claude backend
 * spread the ACTIVATION half into `runPreToolUseChecks` but never wired the
 * DELIVERY half: the activated rule's body was queued by
 * `recordPathScopedRuleActivation` — which also emits `InstructionsLoaded`
 * with `load_reason: 'path_glob_match'` — and then drained nowhere, so
 * telemetry said the rule loaded while the model never saw it. What THIS pins
 * is the same pair of seams `pi-agent-path-scoped-rules.test.ts` pins on Pi:
 *
 * 1. `getPathScopedRulePreToolUseContext()` spread into the check args
 *    `runPreToolUseChecks` receives — the gate is the one place every
 *    file-touching call passes through.
 * 2. `consumePendingPathScopedRuleContext()` folded into the PreToolUse
 *    hook's `additionalContext` — the SAME hidden per-tool channel steer
 *    messages and trusted-hook context already ride
 *    (`hookSpecificOutput.additionalContext`), which lands in the message
 *    history rather than the pinned block, exactly what keeps a `paths:` rule
 *    "Lost until a matching file is read again" after compaction
 *    (memory.md:218: "Path-scoped rules trigger when Claude reads files
 *    matching the pattern, not on every tool use").
 */
/**
 * The argument list of the call starting at `start`, brace-matched from its
 * opening `{` — the region the gate arm below reads.
 *
 * A FIXED 2 000-character window used to stand there, and it rotted: `5e9042ae9`
 * (P6.202, 2026-09-08) added `interactive: !this.isHeadless` under an eight-line
 * comment and moved the spread from offset 1 526 to 2 127, so the 1.36.0 wave
 * gate reported this file red while `claude-agent.ts` was correct. A window sized
 * to today's file is a stale-count guard by another name; the call's own braces
 * are the boundary the assertion always meant.
 */
const callArguments = (text: string, start: number): string => {
  const open = text.indexOf('{', start);
  if (open < 0) throw new Error('no argument object at the given call start');
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error('unbalanced argument object at the given call start');
};

describe('ClaudeAgent path-scoped rule delivery', () => {
  it('spreads the gate context and folds the pending body into the hook additionalContext', async () => {
    const text = await Bun.file(new URL('../claude-agent.ts', import.meta.url)).text();

    // The gate arm: spread into the same check args as the MCP context.
    const checkArgsStart = text.indexOf('checkResult: runPreToolUseChecks({');
    expect(checkArgsStart).toBeGreaterThan(-1);
    const gateArgs = callArguments(text, checkArgsStart);
    expect(gateArgs).toContain('...this.getPathScopedRulePreToolUseContext()');
    // BOUNDARY CONTROL: the region is the call and not the rest of the file —
    // without it a brace scan that ran away would make the assertion above pass
    // for any spread anywhere in `claude-agent.ts`. The next anchor this test
    // reads sits ~4 000 characters later and must be outside.
    expect(gateArgs).not.toContain('// R28: a rule the gate just activated rides the same');

    // The delivery arm: the consumed body joins the additional-context channel
    // beside the steer message…
    // F1.238 — the start anchor is the R28 comment itself: the steer consume
    // that used to sit above it is gone (steers now ride `continueWith`).
    const hookContextStart = text.indexOf('// R28: a rule the gate just activated rides the same');
    expect(hookContextStart).toBeGreaterThan(-1);
    // D1.111 — an END ANCHOR rather than `bracedRegion`, checked rather than
    // assumed. The bound is the next declaration, asserted FOUND — an
    // `indexOf` miss answers -1 and `slice(start, -1)` is the rest of the file.
    const hookContextEnd = text.indexOf('const continueWith = this.deliverPendingSteersOn(buildClaudePreToolUseContinue(', hookContextStart);
    expect(hookContextEnd).toBeGreaterThan(hookContextStart);
    const hookContextRegion = text.slice(hookContextStart, hookContextEnd);
    expect(hookContextRegion).toContain('consumePendingPathScopedRuleContext()');
    // BOUNDARY CONTROL for this region too, naming the dispatch BELOW it.
    expect(hookContextRegion).not.toContain('switch (checkResult.type)');

    // …and is part of the JOINED value the hook returns, not merely computed
    // and dropped.
    expect(hookContextRegion.slice(hookContextRegion.indexOf('const additionalContext')))
      .toContain('pathScopedRuleContext');
  });

  it('inherits both seams from BaseAgent', () => {
    const proto = ClaudeAgent.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.getPathScopedRulePreToolUseContext).toBe('function');
    expect(typeof proto.consumePendingPathScopedRuleContext).toBe('function');
  });
});
