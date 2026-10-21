/**
 * P6.490, tier 1 — the turn-budget consequence.
 *
 * `env-vars.md#variables`: "`CLAUDE_CODE_MAX_TURNS` | Cap the number of agentic
 * turns when no explicit limit is passed. Equivalent to passing `--max-turns`,
 * which takes precedence when both are set. A value that is not a positive
 * integer is rejected at startup with an error rather than treated as no cap".
 *
 * The claude child honours it because the subprocess env is spread; Pi read
 * only its workspace default, so the SAME environment bounded one runtime and
 * not the other. Three things are asserted, and the second is the one a naive
 * implementation inverts: the configured value is this fork's `--max-turns` and
 * therefore WINS, rather than being floored by an administrator's variable.
 */
import { describe, expect, it } from 'bun:test';

import {
  MAX_AGENT_TURNS_COMPAT_ENV,
  MAX_AGENT_TURNS_ENV,
  NO_AGENT_TURN_CAP,
  resolveMaxAgentTurns,
} from '../max-agent-turns.ts';

describe('resolveMaxAgentTurns', () => {
  it('caps a session that chose no limit, under either spelling, with the Nessy name winning', () => {
    // The gap this row closes: no configured cap used to mean "unbounded", so
    // the documented variable did nothing on Pi.
    expect(resolveMaxAgentTurns(0, {})).toBe(NO_AGENT_TURN_CAP);
    expect(resolveMaxAgentTurns(0, { [MAX_AGENT_TURNS_COMPAT_ENV]: '25' })).toBe(25);
    expect(resolveMaxAgentTurns(undefined, { [MAX_AGENT_TURNS_ENV]: '12' })).toBe(12);
    // Both set: the Nessy name wins, the family's own rule.
    expect(resolveMaxAgentTurns(0, {
      [MAX_AGENT_TURNS_ENV]: '12',
      [MAX_AGENT_TURNS_COMPAT_ENV]: '99',
    })).toBe(12);
    // "accept scientific notation and digit-separator spellings in addition to
    // plain digits" — the row notes no restriction, so the general rule governs.
    expect(resolveMaxAgentTurns(0, { [MAX_AGENT_TURNS_COMPAT_ENV]: '2e1' })).toBe(20);
    expect(resolveMaxAgentTurns(0, { [MAX_AGENT_TURNS_COMPAT_ENV]: '1_000' })).toBe(1000);
  });

  it('lets the explicit limit take precedence, which is the direction that is easy to invert', () => {
    // "Equivalent to passing `--max-turns`, which takes precedence when both are
    // set." The workspace's own `maxAgentTurns` is this fork's `--max-turns`, so
    // a configured 5 stays 5 beside a variable saying 200 — and, the half that
    // matters for a user, a configured 200 is NOT lowered to an administrator's
    // 5 by a variable the page says it outranks.
    expect(resolveMaxAgentTurns(5, { [MAX_AGENT_TURNS_COMPAT_ENV]: '200' })).toBe(5);
    expect(resolveMaxAgentTurns(200, { [MAX_AGENT_TURNS_COMPAT_ENV]: '5' })).toBe(200);
    expect(resolveMaxAgentTurns(7.9, {})).toBe(7);
  });

  it('reports a malformed value instead of silently treating it as no cap', () => {
    // The page: "A value that is not a positive integer is rejected at startup
    // with an error rather than treated as no cap." A desktop session cannot
    // refuse to start over an environment variable — that is an owner's call,
    // recorded at the module — but the clause's intent is honoured: the
    // rejection is named rather than swallowed.
    const said: string[] = [];
    expect(resolveMaxAgentTurns(0, { [MAX_AGENT_TURNS_COMPAT_ENV]: 'lots' }, m => said.push(m)))
      .toBe(NO_AGENT_TURN_CAP);
    expect(said.join('\n')).toContain(MAX_AGENT_TURNS_COMPAT_ENV);
    expect(said.join('\n')).toContain('lots');

    // Zero and negatives are not positive integers either, and they are the
    // spellings most likely to be MEANT as "no cap" — so they are reported too.
    const zero: string[] = [];
    expect(resolveMaxAgentTurns(0, { [MAX_AGENT_TURNS_COMPAT_ENV]: '0' }, m => zero.push(m)))
      .toBe(NO_AGENT_TURN_CAP);
    expect(zero).not.toHaveLength(0);
  });
});

/**
 * P6.490's other explicit obligation: *"the ONE of the twenty-nine that is NOT a
 * gap is named rather than closed."*
 *
 * It is `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`, and the reason is on the page
 * rather than in our tree — `env-vars.md#variables`, verbatim: *"Removed in
 * v2.1.224 and now a no-op. Previously capped the total number of subagents
 * Claude could spawn with the Agent tool in one session (default: 200) …"*
 * (re-fetched 2026-09-07). The vendored 2.1.247 binary still carries the string
 * — re-measured 2026-09-12 at 2 lines / 2 occurrences (C3.252) —
 * which is exactly why a blanket sweep gets this one wrong: implementing it
 * would implement a WITHDRAWN contract, and the two limits that replaced it —
 * the concurrent-subagent limit and the depth limit — are separate mechanisms
 * this fork already has.
 *
 * The assertion is the honest one available to a unit test: the name has no
 * reader here and must not acquire one by sweep. If a future row deliberately
 * implements it, this fails and the reason above has to be re-argued rather than
 * quietly overwritten.
 */
describe('P6.490 — the tier-1 key that is NOT a gap', () => {
  it('leaves the withdrawn subagent cap unimplemented, by name', () => {
    expect(WITHDRAWN_TIER1_KEY).toBe('CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION');
    // It is not a spelling this resolver answers to, and no alias reaches it.
    expect(resolveMaxAgentTurns(0, { [WITHDRAWN_TIER1_KEY]: '200' })).toBe(NO_AGENT_TURN_CAP);
  });
});

/** Named here so a sweep that adds a reader has to delete this line first. */
const WITHDRAWN_TIER1_KEY = 'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION';
