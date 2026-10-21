/**
 * P2.327 — MEASURING the open question P2.301 left behind, because the two
 * answers needed different work and nobody had run it.
 *
 * The question, as `SessionManager.ts` states it at the chokepoint: a skill's
 * `disallowed-tools` has no representation for a child with NO tool ceiling —
 * there is nothing to subtract from — so "does the child's OWN gate still
 * enforce it independently?" If yes, the parent-side absence costs nothing and
 * is a representation gap. If no, a skill author's exclusion is dropped.
 *
 * MEASURED HERE, AND THE ANSWER IS NO. The chain is three facts, each pinned by
 * a test below, and none of them is an opinion about the design:
 *
 *  1. the CHILD's gate is universe-independent and would enforce the removal
 *     perfectly well if it were ever told about it — `checkSkillDeniedTools`
 *     reads `skillDeniedTools` and nothing else, and `applySkillInvocationRemoval`
 *     passes `denied` through whether or not `piAllowedTools` is known. So the
 *     failure is NOT that a ceiling-less gate cannot subtract;
 *  2. but a preloaded skill reaches the child as RENDERED TEXT, not as an
 *     invocation: `SessionManager` builds the child's prompt from
 *     `formatRuntimeSkillInvocation(...)`, which emits an `<invoked-skill …>`
 *     block;
 *  3. and the child turns a message into invocation records through
 *     `parseSkillMentionOccurrences`, which matches `[skill:<name>]` and nothing
 *     else. An `<invoked-skill>` block carries no such marker, so the child
 *     produces ZERO invocation records for a skill it was preloaded with, never
 *     calls `setSkillInvocationDeniedTools`, and its gate has nothing to enforce.
 *
 * So for a child with a ceiling the removal IS applied — in the PARENT, by
 * subtracting from the pinned list — and for a child WITHOUT one it is applied
 * nowhere. That is a hole and not a representation gap, and the fix it argues
 * for is NOT the pool enumeration P2.301 correctly refused: a removal list is a
 * subtraction, not a ceiling, so carrying the denied NAMES to the child and
 * installing them with `setSkillInvocationDeniedTools` expresses "everything
 * except X" without anyone having to enumerate the pool. Fact 1 is exactly the
 * precondition that fix needs, which is why it is pinned here rather than
 * described.
 *
 * These tests do not implement that fix — its producer and its child-side
 * install are in `SessionManager` and the child start path, outside this lane's
 * files. They pin what was measured so the next reader inherits an answer
 * instead of the question, and so a refactor that made the child's gate
 * universe-dependent (which would close the fix's door) fails loudly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * P2.385 (below, third describe) BUILDS the child-side install those three
 * facts argued for, and NOTHING ELSE about the chain changed: facts 2 and 3
 * still hold exactly as written — the parser was deliberately NOT loosened to
 * match the `<invoked-skill>` block, because the fourth test in the second
 * describe shows a body quoting the marker really does invoke, so a looser
 * parser would arm the wrong sessions. The removal travels as DATA instead, on
 * `BackendConfig.piSkillDisallowedTools`, and is installed session-scoped.
 *
 * The producer that fills that field is still unbuilt (`PiChildRestrictionsV1`
 * and `SessionManager`, both outside this lane too), so the gate below is live
 * with an empty input. That is deliberately visible rather than papered over —
 * an exclusion reported as enforced while nothing enforces it is the exact
 * false assurance this row family exists to remove.
 */
import { describe, expect, it } from 'bun:test';

import { PrerequisiteManager } from '../prerequisite-manager.ts';
import { parseSkillMentionOccurrences } from '../../../mentions/index.ts';
import {
  formatRuntimeSkillInvocation,
  type SkillInvocationRecord,
} from '../../../capabilities/runtime-skill-content.ts';

/** A minimal record in the shape `SessionManager` preloads into a child prompt. */
function preloadedRecord(overrides: Partial<SkillInvocationRecord> = {}): SkillInvocationRecord {
  return {
    key: 'plugin:audit:redact',
    name: 'redact',
    sourceDigest: 'sha256:aaa',
    generation: 'gen-1',
    invokedAt: 0,
    body: 'Redact the secrets before reporting. Never shell out.',
    supportingResources: [],
    restrictions: { disallowedTools: Object.freeze(['bash']) },
    states: { available: true, selected: true, resourceLoaded: false, grantApplied: true },
    invocationDigest: 'sha256:bbb',
    ...overrides,
  } as SkillInvocationRecord;
}

describe('P2.327 fact 1 — the child gate subtracts without knowing a universe', () => {
  /**
   * The reason the ceiling-less case is fixable at all. A ceiling is a positive
   * NAME list and cannot say "everything except X"; a removal list is the
   * complement operation and does not need to.
   */
  it('blocks a denied tool with no ceiling, no grant and no pool ever set', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    // Nothing else is configured: no `setSkillInvocationToolGrants`, no pinned
    // tool list. This is exactly a ceiling-less child's gate.
    manager.setSkillInvocationDeniedTools(['bash']);
    expect(manager.checkPrerequisites('Bash')).toEqual({
      allowed: false,
      blockReason: 'Tool "Bash" was removed by the invoked skill\'s disallowed-tools.',
    });
    // And it subtracts only what it was told to: an unnamed tool is untouched,
    // so installing a removal on a ceiling-less child cannot narrow it wholesale.
    expect(manager.checkPrerequisites('Read')).toEqual({ allowed: true });
  });

  /**
   * The removal is glob-matched on the canonical name, so it reaches an MCP
   * family too — the shape a `disallowed-tools: mcp__*` author expects, and one
   * a pool enumeration would have had to reproduce by hand.
   */
  it('a glob removal works with no universe, the adversarial spelling included', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationDeniedTools(['mcp__*']);
    expect(manager.checkPrerequisites('mcp__github__create_issue').allowed).toBe(false);
    expect(manager.checkPrerequisites('mcp__deploy').allowed).toBe(false);
    // Not a prefix-of-a-word match: a tool merely STARTING with the same letters
    // is a different tool and must survive.
    expect(manager.checkPrerequisites('mcpanything').allowed).toBe(true);
  });

  /**
   * The `EndConversation` carve-out is the one place the unknown universe DOES
   * change an answer, and it changes it in the safe direction: with no pool to
   * prove the removal would empty, the tool stays.
   */
  it('keeps EndConversation when the universe is unknown', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationDeniedTools(['EndConversation']);
    expect(manager.checkPrerequisites('EndConversation')).toEqual({ allowed: true });
    // The caller's own answer still governs, so nothing here is hard-coded.
    manager.setSkillInvocationDeniedTools(['EndConversation'], { mayRemoveEndConversation: true });
    expect(manager.checkPrerequisites('EndConversation').allowed).toBe(false);
  });
});

describe('P2.327 facts 2 and 3 — a preloaded skill produces no invocation in the child', () => {
  /**
   * THE MEASUREMENT THAT ANSWERS THE ROW. The child's prompt carries the
   * rendered block; the child's parser wants a `[skill:…]` marker. They do not
   * meet, so `setSkillInvocationDeniedTools` is never called in the child and
   * fact 1's machinery is never armed.
   */
  it('the rendered <invoked-skill> block yields zero skill mentions', () => {
    const rendered = formatRuntimeSkillInvocation(preloadedRecord());
    // The block really does carry the skill and its restriction — this is the
    // text a preloaded child is handed, not a stand-in.
    expect(rendered).toContain('<invoked-skill');
    expect(rendered).toContain('name="redact"');
    expect(parseSkillMentionOccurrences(rendered)).toEqual([]);
  });

  /**
   * The positive control for the test above, on the same rig: the parser is
   * live, and it is the ABSENCE of the marker that produces the empty result —
   * not a parser that returns nothing for everything.
   */
  it('positive control: an explicit [skill:…] marker is parsed', () => {
    expect(parseSkillMentionOccurrences('please [skill:redact] this')).toEqual(['redact']);
    // And the two forms in one message, so a child that DOES invoke the skill by
    // name arms its own gate exactly as a top-level session would.
    const both = `${formatRuntimeSkillInvocation(preloadedRecord())}\n[skill:redact]`;
    expect(parseSkillMentionOccurrences(both)).toEqual(['redact']);
  });

  /**
   * A body that happens to quote the marker is the adversarial spelling, and it
   * matters in the direction of NOT over-claiming: if a skill's own text spelled
   * `[skill:x]` the child would invoke it, so the "zero invocations" finding is
   * about the WRAPPER, not about rendered bodies in general. Stated as a bound
   * on the finding rather than left for someone to discover as a contradiction.
   */
  it('the finding is about the wrapper: a body quoting the marker does invoke', () => {
    const rendered = formatRuntimeSkillInvocation(preloadedRecord({ body: 'run [skill:other] next' }));
    expect(parseSkillMentionOccurrences(rendered)).toEqual(['other']);
  });
});

describe('P2.385 — the preloaded removal, on the side P2.327 measured empty', () => {
  /**
   * The whole point, in one test: a child with NO ceiling, no grant and no pool
   * refuses the tool its preloaded skill removed. This is the state P2.327
   * measured as enforced NOWHERE.
   */
  it('blocks a preloaded denial with no ceiling, and leaves an unnamed tool alone', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setPreloadedSkillDeniedTools(['bash']);
    expect(manager.checkPrerequisites('Bash')).toEqual({
      allowed: false,
      blockReason: 'Tool "Bash" was removed by a preloaded skill\'s disallowed-tools.',
    });
    // A tool the exclusion does NOT name survives — the removal is a
    // subtraction, never a ceiling, so it cannot narrow a child wholesale.
    expect(manager.checkPrerequisites('Read')).toEqual({ allowed: true });
  });

  /**
   * THE REASON IT IS A THIRD FIELD. `clearSkillInvocation()` runs in `chat`'s
   * `finally` on every turn, and it disarms the turn-scoped removal by design —
   * "The restriction clears when you send your next message". A preloaded skill
   * is invoked by no message and un-invoked by none either
   * (`sub-agents.md#preload-skills-into-subagents`: "The full content of each
   * listed skill is injected into the subagent's context at startup"), so its
   * removal has to outlive the turn. Folding the two together would arm the
   * child's FIRST turn and silently disarm every turn after — an intermittent
   * hole is worse than an open one, because it looks fixed.
   */
  it('survives the turn boundary that clears the invoked-skill removal', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationDeniedTools(['read']);
    manager.setPreloadedSkillDeniedTools(['bash']);
    expect(manager.checkPrerequisites('Read').allowed).toBe(false);
    expect(manager.checkPrerequisites('Bash').allowed).toBe(false);

    manager.clearSkillInvocation();

    // The turn-scoped one is gone, which is the documented behaviour and the
    // positive control that `clearSkillInvocation` really ran…
    expect(manager.checkPrerequisites('Read')).toEqual({ allowed: true });
    // …and the preloaded one is still enforcing.
    expect(manager.checkPrerequisites('Bash').allowed).toBe(false);
  });

  /**
   * Compaction is where a session-scoped removal matters MOST: the preloaded
   * skill's text can fall out of the window while the restriction its author
   * wrote is still in force, so a reset that disarmed it would hand the model
   * back a tool the skill removed at exactly the moment the model forgot why.
   */
  it('survives compaction, in both spellings of resetReadState', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationDeniedTools(['read']);
    manager.setPreloadedSkillDeniedTools(['bash']);

    manager.resetReadState();
    expect(manager.checkPrerequisites('Read')).toEqual({ allowed: true });
    expect(manager.checkPrerequisites('Bash').allowed).toBe(false);

    manager.resetReadState({ preserveSkillInvocation: true });
    expect(manager.checkPrerequisites('Bash').allowed).toBe(false);
  });

  /**
   * Same glob semantics as the turn-scoped field — one `matchesToolPattern`
   * call, so an `mcp__*` author gets the same answer whichever way the skill
   * reached the session — with the adversarial near-miss pinned: a tool whose
   * name merely STARTS with the same letters is a different tool and survives.
   */
  it('globs an MCP family, and does not eat a name that merely starts alike', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setPreloadedSkillDeniedTools(['mcp__*']);
    expect(manager.checkPrerequisites('mcp__github__create_issue').allowed).toBe(false);
    expect(manager.checkPrerequisites('mcp__deploy').allowed).toBe(false);
    expect(manager.checkPrerequisites('mcpanything').allowed).toBe(true);
  });

  /**
   * `EndConversation` is out of this field's reach entirely, and the two
   * verdicts do not leak into each other: setting `mayRemoveEndConversation`
   * for the TURN-scoped list must not unlock it for the preloaded one.
   *
   * Both branches of `skills.md`'s "can't remove `EndConversation` while any
   * other tool remains" agree without needing the pool here — a ceiling-less
   * child holds the full built-in set, and a child WITH a ceiling cannot carry
   * `EndConversation` in it at all.
   */
  it('never removes EndConversation, even when the turn-scoped verdict allows it', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setPreloadedSkillDeniedTools(['EndConversation', 'bash']);
    expect(manager.checkPrerequisites('EndConversation')).toEqual({ allowed: true });
    // The neighbouring name in the SAME list is still removed, so this is the
    // carve-out and not an inert install.
    expect(manager.checkPrerequisites('Bash').allowed).toBe(false);

    manager.setSkillInvocationDeniedTools(['nothing-else'], { mayRemoveEndConversation: true });
    expect(manager.checkPrerequisites('EndConversation')).toEqual({ allowed: true });
  });

  /**
   * A removal outranks a grant naming the same tool — the ordinary precedence,
   * and the reason the page calls the field "like deny rules". Pinned across
   * the two fields because they are now two, and a skill the child DOES invoke
   * must not be able to pre-approve its way past what a preloaded skill removed.
   */
  it('outranks a turn-scoped allowed-tools grant naming the same tool', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationToolGrants([{ name: 'Bash', patterns: undefined }]);
    // Positive control: without the preloaded removal that grant pre-approves.
    expect(manager.skillGrantAllows('Bash')).toBe(true);

    manager.setPreloadedSkillDeniedTools(['bash']);
    expect(manager.skillGrantAllows('Bash')).toBe(false);
    expect(manager.checkPrerequisites('Bash').allowed).toBe(false);
  });

  /**
   * The boundary. Unlike the tool CEILING one layer up, where `[]` is the
   * author's own empty set, an empty SUBTRACTION subtracts nothing — so neither
   * spelling may turn into a removal, and neither may disarm one already
   * installed by accident of ordering.
   */
  it('undefined and [] install nothing', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setPreloadedSkillDeniedTools([]);
    expect(manager.checkPrerequisites('Bash')).toEqual({ allowed: true });
    manager.setPreloadedSkillDeniedTools(undefined);
    expect(manager.checkPrerequisites('Bash')).toEqual({ allowed: true });
  });

  /**
   * The two layers say which one refused, because "the invoked skill" sends the
   * user of a SUBAGENT looking for an invocation that never happened — the very
   * confusion that left this hole unnoticed. Transparent-where-undocumented:
   * the page specifies the removal, not the wording of the refusal.
   */
  it('names the layer that refused', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationDeniedTools(['read']);
    manager.setPreloadedSkillDeniedTools(['bash']);
    expect(manager.checkPrerequisites('Read').blockReason)
      .toBe('Tool "Read" was removed by the invoked skill\'s disallowed-tools.');
    expect(manager.checkPrerequisites('Bash').blockReason)
      .toBe('Tool "Bash" was removed by a preloaded skill\'s disallowed-tools.');
  });

  /**
   * The bound P2.327 stated, re-checked against the fix: the parser was NOT
   * loosened, so a preloaded skill still produces zero mentions, and a body
   * that quotes the marker still invokes. The removal now binds in BOTH cases
   * and by two independent routes, which is the point — arming had to stop
   * depending on the parser at all.
   */
  it('is independent of the parser the fix deliberately did not loosen', () => {
    const rendered = formatRuntimeSkillInvocation(preloadedRecord({ body: 'run [skill:other] next' }));
    expect(parseSkillMentionOccurrences(rendered)).toEqual(['other']);
    expect(parseSkillMentionOccurrences(formatRuntimeSkillInvocation(preloadedRecord()))).toEqual([]);

    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setPreloadedSkillDeniedTools([...preloadedRecord().restrictions.disallowedTools!]);
    expect(manager.checkPrerequisites('Bash').allowed).toBe(false);
  });
});
