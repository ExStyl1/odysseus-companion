import { describe, expect, it } from 'bun:test';

import { PiAgent } from '../pi-agent.ts';
import { bracedRegion } from '../../testing/source-regions.ts';

/**
 * R28 — the delivery hop, at the agent boundary.
 *
 * The rules machinery (discovery, parsing, the per-read trigger, the pending
 * buffer) lives on `BaseAgent` and its own suites cover it. What THIS pins is
 * the pair of seams that make an activated rule actually reach the model:
 *
 * 1. `getPathScopedRulePreToolUseContext()` spread into the check args
 *    `runPreToolUseChecks` receives — the gate is the one place every
 *    file-touching call passes through, so an omission there silently disarms
 *    every path-scoped rule while every lower-level suite stays green.
 * 2. `consumePendingPathScopedRuleContext()` folded into
 *    `hookAdditionalContext` beside the edit-feedback context — the channel the
 *    activated rule body travels on.
 *
 * Both were carried out of R28's execution and wired afterwards. Without these
 * assertions the omission is invisible from the rules suites — the "built but
 * not wired" shape this series keeps hitting.
 */
describe('PiAgent path-scoped rule delivery', () => {
  it('spreads the gate context and folds the pending body into hook context', async () => {
    const text = await Bun.file(new URL('../pi-agent.ts', import.meta.url)).text();

    // The gate arm: spread beside the MCP context, into the same check args.
    // Read as the check-args OBJECT rather than as a window, which also makes
    // "the same check args" an assertion instead of a proximity: both spreads
    // have to be inside the one literal.
    const checkArgsStart = text.indexOf('const checkArgs = {');
    expect(checkArgsStart).toBeGreaterThan(-1);
    const gateArgs = bracedRegion(text, checkArgsStart);
    expect(gateArgs).toContain('...mcpPreToolUseContext,');
    expect(gateArgs).toContain('...this.getPathScopedRulePreToolUseContext()');
    // BOUNDARY CONTROL: the region is the literal and not the rest of the file.
    // Without it a brace scan that ran away would satisfy the line above for a
    // spread anywhere in `pi-agent.ts`; the next anchor this test reads sits
    // thousands of characters later and must be outside.
    expect(gateArgs).not.toContain('const editFeedbackContext = this.consumePendingEditFeedback();');

    // The delivery arm: the consumed body joins the additional-context channel…
    const hookContextStart = text.indexOf('const editFeedbackContext = this.consumePendingEditFeedback();');
    expect(hookContextStart).toBeGreaterThan(-1);
    // …and the region ends at the STATEMENT the claim is about — the join —
    // rather than 800 characters in.
    const joinAt = text.indexOf('const hookAdditionalContext', hookContextStart);
    expect(joinAt).toBeGreaterThan(hookContextStart);
    const hookContextRegion = text.slice(hookContextStart, text.indexOf(';', joinAt) + 1);
    expect(hookContextRegion).toContain('consumePendingPathScopedRuleContext()');
    // BOUNDARY CONTROL for this region too: the re-check block that follows the
    // join is outside it.
    expect(hookContextRegion).not.toContain('if (hookOverlay.hookUpdatedInput) {');

    // …and is part of the JOINED value, not merely computed and dropped.
    expect(hookContextRegion.slice(hookContextRegion.indexOf('const hookAdditionalContext')))
      .toContain('pathScopedRuleContext');
  });

  it('inherits both seams from BaseAgent', () => {
    const proto = PiAgent.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.getPathScopedRulePreToolUseContext).toBe('function');
    expect(typeof proto.consumePendingPathScopedRuleContext).toBe('function');
  });
});
