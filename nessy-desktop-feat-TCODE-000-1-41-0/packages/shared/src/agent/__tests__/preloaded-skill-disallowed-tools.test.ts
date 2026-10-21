/**
 * P2.385 — the WIRING half: `BackendConfig.piSkillDisallowedTools` reaches the
 * gate, once, at agent construction.
 *
 * The gate's own behaviour is pinned next to the measurement that argued for it
 * (`core/__tests__/child-skill-disallowed-tools.test.ts`). What is pinned HERE
 * is the seam between them, because that seam is the whole defect: P2.327
 * measured a gate that would have enforced a preloaded skill's `disallowed-tools`
 * perfectly if anything had ever told it about them, and nothing did.
 *
 * The constructor is the install point rather than a per-turn hook for a reason
 * a test can state: a runtime-config change DISPOSES the agent and builds a new
 * one (`SessionManager.tryRefreshAgentRuntime` → `createAgent()`), so an install
 * that rode the turn would have to be re-derived on a path nobody remembers,
 * while one that rides construction is re-derived by the same code that rebuilt
 * the agent.
 *
 * NOT PINNED HERE, but it EXISTS: the PRODUCER. P2.402 (`592596b76`) added the
 * `PiChildRestrictionsV1` field and the two `SessionManager` lines that fill and
 * project it, pinned in
 * `server-core/src/sessions/__tests__/preloaded-skill-denied-tools-producer.test.ts`.
 * These tests prove the seam; that one proves the closure. This header claimed
 * the producer did not exist until P2.406 corrected it — the tests below never
 * changed and never needed to.
 *
 * So the "absent config installs nothing" case below is no longer a picture of
 * EVERY session: a Pi child whose preloaded skills remove tools now arrives with
 * names in this field. It is still exactly the production path for every session
 * that carries none — a top-level session, a Claude child (enforced natively
 * through `AgentDefinition.disallowedTools` instead), a child whose skills
 * exclude nothing — so it remains a valid negative control and is kept as
 * written.
 */
import { describe, expect, it } from 'bun:test';

import { TestAgent, createMockBackendConfig } from './test-utils.ts';

/**
 * `prerequisiteManager` is `protected` on `BaseAgent`. A subclass declared here
 * exposes it without touching the shared `test-utils` harness — the reach is
 * the point of the test, so faking it would test nothing.
 */
class PreloadProbeAgent extends TestAgent {
  get gate() {
    return this.prerequisiteManager;
  }
}

describe('P2.385 — a preloaded skill\'s disallowed-tools reaches the child gate', () => {
  it('installs the removal from config, with no ceiling and no invocation anywhere', () => {
    const agent = new PreloadProbeAgent(createMockBackendConfig({ piSkillDisallowedTools: ['bash'] }));
    // No `piAllowedTools`, no skill mention, no invocation record — the exact
    // state P2.327 measured as enforced nowhere.
    expect(agent.gate.checkPrerequisites('Bash')).toEqual({
      allowed: false,
      blockReason: 'Tool "Bash" was removed by a preloaded skill\'s disallowed-tools.',
    });
    // A tool the exclusion does not name is untouched: a subtraction, not a
    // ceiling, so this can never be the pool enumeration P2.301 refused.
    expect(agent.gate.checkPrerequisites('Read')).toEqual({ allowed: true });
  });

  /**
   * The negative control: absent config, no removal. Every session that carries
   * no preloaded exclusion — top-level, Claude-side, or a child whose skills
   * remove nothing — takes this branch, so the install can never be read as a
   * blanket subtraction by someone skimming the test names.
   *
   * P2.406 corrected the second half of this comment, not the case: it used to
   * add "and it is also today's production reality: with no producer filling the
   * field, every real session takes this branch", which stopped being true when
   * P2.402 landed the producer. The test name and its assertion are unchanged.
   */
  it('installs nothing when the config carries nothing', () => {
    const agent = new PreloadProbeAgent(createMockBackendConfig());
    expect(agent.gate.checkPrerequisites('Bash')).toEqual({ allowed: true });
  });

  /**
   * A top-level session is not a child, and must not acquire a removal from
   * this path. `[]` is the boundary spelling — an empty SUBTRACTION subtracts
   * nothing, unlike the empty tool CEILING one layer up, which is the author's
   * own empty set.
   */
  it('an empty list is not an empty pool', () => {
    const agent = new PreloadProbeAgent(createMockBackendConfig({ piSkillDisallowedTools: [] }));
    expect(agent.gate.checkPrerequisites('Bash')).toEqual({ allowed: true });
  });

  /**
   * The removal outlives the turn that did not create it. `clearSkillInvocation`
   * is what `chat`'s `finally` calls, and it is correct for a skill the session
   * INVOKED; a preloaded skill was invoked by no turn, so surviving this call is
   * the difference between enforcing for the child's whole life and enforcing
   * for one turn of it.
   */
  it('survives the per-turn clear the invoked-skill path relies on', () => {
    const agent = new PreloadProbeAgent(createMockBackendConfig({ piSkillDisallowedTools: ['mcp__*'] }));
    expect(agent.gate.checkPrerequisites('mcp__github__create_issue').allowed).toBe(false);
    agent.gate.clearSkillInvocation();
    expect(agent.gate.checkPrerequisites('mcp__github__create_issue').allowed).toBe(false);
    // …and it is still a glob and not a blanket: the adversarial near-miss.
    expect(agent.gate.checkPrerequisites('mcpanything').allowed).toBe(true);
  });
});
