import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Pre-tool decision contract, second backend (Q1 permission-boundary wave):
 * the guardian is a Pi-only, HOST-side consult wired exclusively into
 * `pi-agent.ts:handlePreToolUseRequest`. The Claude Agent backend shares the
 * SAME deterministic `runPreToolUseChecks` pipeline but MUST be byte-identical
 * to the pre-guardian flow — it never imports, references, or calls the
 * guardian. A regression that threaded the judge into the Claude path would
 * make the guardian a second authority on a surface with no receipt/audit
 * wiring for it. This is the cheap static pin the plan asks for.
 */
describe('claude-agent pre-tool contract — guardian-free (both-backends invariant)', () => {
  const claudeAgentSource = readFileSync(
    fileURLToPath(new URL('../claude-agent.ts', import.meta.url)),
    'utf-8',
  );

  it('the Claude Agent backend contains zero guardian references (no import, no call)', () => {
    // Case-insensitive so `Guardian`, `guardian-consult`, `GuardianJudgePort`,
    // `consultGuardian*`, etc. all trip this. If a future change legitimately
    // needs the token in the Claude path, it must also wire the guardian's
    // audit/receipt provenance there — update this pin deliberately, not by
    // reflex.
    expect(claudeAgentSource.toLowerCase()).not.toContain('guardian');
  });
});
