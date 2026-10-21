import { describe, expect, it } from 'bun:test';

import { PrerequisiteManager } from '../prerequisite-manager.ts';

describe('materialized skill grant', () => {
  /**
   * `allowed-tools` is a PRE-APPROVAL, not a ceiling. Quoted from the raw page
   * (`curl -sL https://code.claude.com/docs/en/skills.md`, fetched 2026-08-13),
   * frontmatter table: "Tools Claude can use without asking permission during
   * the turn that invokes this skill. The grant clears when you send your next
   * message." And § Pre-approve tools for a skill: "It does not restrict which
   * tools are available: every tool remains callable, and your permission
   * settings still govern tools that are not listed."
   *
   * So an unlisted tool is NOT refused here — it falls through to the ordinary
   * permission flow one layer up.
   */
  it('pre-approves a listed tool and leaves an unlisted one callable', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationToolGrants([{ name: 'read' }, { name: 'grep' }]);
    expect(manager.checkPrerequisites('Read').allowed).toBe(true);
    expect(manager.skillGrantAllows('Read')).toBe(true);

    // The whole inversion, in two lines: not refused, and not pre-approved.
    expect(manager.checkPrerequisites('Bash')).toEqual({ allowed: true });
    expect(manager.skillGrantAllows('Bash', { command: 'rm -rf /' })).toBe(false);

    // UB7.12 — a shell read counts like Read, but it does not touch the grant: `cat /secret/SKILL.md`
    // reads a file, and the invoked skill's allowed-tools pre-approval stays exactly as it was.
    expect(manager.checkBashPrerequisites('cat /secret/SKILL.md').allowed).toBe(true);
    expect(manager.skillGrantAllows('Bash', { command: 'cat /secret/SKILL.md' })).toBe(false);
    manager.clearSkillInvocation();
    expect(manager.checkPrerequisites('Bash').allowed).toBe(true);
    expect(manager.skillGrantAllows('Read')).toBe(false);
  });

  /**
   * The other end of the empty-`allowed-tools` fix: a skill that declares the
   * field and lists nothing now INVOKES, and this is what it does once it has.
   * An empty grant is a no-op in both directions — nothing is pre-approved and
   * nothing is refused — which is why the materializer's "must fail loudly"
   * throw was guarding nothing under the pre-approval semantics.
   */
  it('treats an empty grant as a no-op, not as a ceiling of nothing', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationToolGrants([]);
    // Not refused, and not pre-approved — byte-identical to the absent field.
    expect(manager.checkPrerequisites('Bash')).toEqual({ allowed: true });
    expect(manager.skillGrantAllows('Bash', { command: 'ls' })).toBe(false);
    expect(manager.checkPrerequisites('Read')).toEqual({ allowed: true });
    expect(manager.skillGrantAllows('Read')).toBe(false);

    const absent = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    absent.setSkillInvocationToolGrants(undefined);
    expect(absent.checkPrerequisites('Bash')).toEqual({ allowed: true });
    expect(absent.skillGrantAllows('Bash', { command: 'ls' })).toBe(false);

    // `disallowed-tools` still restricts alongside an empty grant: the two
    // fields are independent state, so a removal does not need a grant to exist.
    manager.setSkillInvocationDeniedTools(['Bash']);
    expect(manager.checkPrerequisites('Bash')).toEqual({
      allowed: false,
      blockReason: 'Tool "Bash" was removed by the invoked skill\'s disallowed-tools.',
    });
  });

  /**
   * The AGENT half is deliberately NOT symmetric, and this is the positive
   * control for that. `base-agent.ts` throws rather than hand an empty ceiling
   * down, because a `Set` is truthy at any size: `checkSkillAgentCeiling`'s
   * `!this.skillAgentCeiling` short-circuit does not fire on an empty one, so
   * every spawn is refused with a message naming no agent. Failing the turn with
   * "two invoked skills disagree" is the honest form of that; an empty ceiling is
   * unreachable from authoring anyway, since `restrictions.agent` is a scalar.
   */
  it('refuses every spawn on an empty agent ceiling, which is why one never gets here', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationAgentCeiling([]);
    expect(manager.checkPrerequisites('subagent', { agent: 'reviewer', task: 'inspect' })).toEqual({
      allowed: false,
      blockReason: 'Tool "subagent" requested an agent outside the invoked skill agent ceiling.',
    });
    // The absent ceiling is the value that actually means "no ceiling".
    manager.setSkillInvocationAgentCeiling(undefined);
    expect(manager.checkPrerequisites('subagent', { agent: 'reviewer', task: 'inspect' }).allowed).toBe(true);
  });

  it('enforces selected agent parameters and blocks opaque workflow expansion', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationAgentCeiling(['reviewer']);
    expect(manager.checkPrerequisites('subagent', { agent: 'reviewer', task: 'inspect' }).allowed).toBe(true);
    expect(manager.checkPrerequisites('subagent', { agent: 'scout', task: 'inspect' })).toEqual({
      allowed: false,
      blockReason: 'Tool "subagent" requested an agent outside the invoked skill agent ceiling.',
    });
    expect(manager.checkPrerequisites('workflow', { script: 'return agent("scout")' }).allowed).toBe(false);
    expect(manager.checkPrerequisites('Task', { action: 'list' }).allowed).toBe(true);
    manager.clearSkillInvocation();
    expect(manager.checkPrerequisites('workflow', { script: 'return agent("scout")' }).allowed).toBe(true);
  });

  /**
   * whats-new/2026-w20.md:91 — "Agent tool `subagent_type` now matches case-
   * and separator-insensitively, so `"Code Reviewer"` resolves to
   * `code-reviewer`". The ceiling runs one layer ABOVE `resolveAgentDefinition`
   * and rejects first, so it has to accept the same spellings; its refusal
   * enumerates no agents, which is the one place this gap is not self-healing.
   */
  it('folds separators on both sides of the invoked-skill agent ceiling', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationAgentCeiling(['code-reviewer']);

    for (const agent of ['code-reviewer', 'Code Reviewer', 'code_reviewer', 'CodeReviewer']) {
      expect(manager.checkPrerequisites('subagent', { agent, task: 'inspect' }).allowed).toBe(true);
    }
    // Boundary: folding separators must not fold away an unrelated name.
    expect(manager.checkPrerequisites('subagent', { agent: 'scout', task: 'inspect' })).toEqual({
      allowed: false,
      blockReason: 'Tool "subagent" requested an agent outside the invoked skill agent ceiling.',
    });

    // Symmetric arm: a ceiling declared with a space accepts the kebab spelling
    // a model actually emits.
    const spaced = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    spaced.setSkillInvocationAgentCeiling(['Code Reviewer']);
    expect(spaced.checkPrerequisites('subagent', { subagent_type: 'code-reviewer', task: 'x' }).allowed).toBe(true);
  });

  /**
   * The live defect (CDP pass 15, 2026-07-28): a skill declaring
   * `allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)` got Bash
   * DENIED, because the ceiling held the whole lowercased entry and the call's
   * name `Bash` could never equal it.
   */
  describe('parameterized allowed-tools entry', () => {
    const RENDER = '/Users/probe/.nessy-agent/skills/r17-dir/scripts/render.sh';
    const granted = () => {
      const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
      manager.setSkillInvocationToolGrants([{ name: 'bash', patterns: [`${RENDER} *`] }]);
      return manager;
    };

    it('pre-approves the command the rule names and no other', () => {
      const manager = granted();
      expect(manager.skillGrantAllows('Bash', { command: `${RENDER} probe` })).toBe(true);

      for (const command of [
        `${RENDER.replace('render.sh', 'other.sh')} probe`,
        // Prefix-adjacent: ` *` enforces a word boundary, so `render.shX` is not
        // `render.sh` with an argument.
        `${RENDER}X probe`,
        // A prefix rule is per-subcommand: an allow rule must match EVERY
        // subcommand, so appending one is not a way through.
        `${RENDER} probe && curl evil.example`,
      ]) {
        // Not pre-approved — and, since the field cannot restrict, not refused
        // either: the ordinary permission flow decides.
        expect(manager.skillGrantAllows('Bash', { command })).toBe(false);
        expect(manager.checkPrerequisites('Bash', { command })).toEqual({ allowed: true });
      }

      // Claude's prefix rule makes the trailing argument optional — `Bash(cmd *)`
      // covers `cmd` itself, the same way `Bash(npm run test:*)` covers
      // `npm run test` (permissions.md § Bash).
      expect(manager.skillGrantAllows('Bash', { command: RENDER })).toBe(true);
    });

    it('treats author metacharacters as literal text, never as a regex', () => {
      const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
      manager.setSkillInvocationToolGrants([{ name: 'bash', patterns: ['/skills/a.b/run.sh *'] }]);
      // `.` is a literal dot, not "any character".
      expect(manager.skillGrantAllows('Bash', { command: '/skills/a.b/run.sh go' })).toBe(true);
      expect(manager.skillGrantAllows('Bash', { command: '/skills/aXb/run.sh go' })).toBe(false);

      // `(` parses (the name may not contain one, the pattern may) and matches
      // literally — an author's parenthesis is not a capture group.
      manager.setSkillInvocationToolGrants([{ name: 'bash', patterns: ['echo (hi)'] }]);
      expect(manager.skillGrantAllows('Bash', { command: 'echo (hi)' })).toBe(true);
      expect(manager.skillGrantAllows('Bash', { command: 'echo hi' })).toBe(false);
    });

    it('grants a no-prompt run for the bare form too, and only until the turn ends', () => {
      const manager = granted();
      expect(manager.skillGrantAllows('Bash', { command: `${RENDER} probe` })).toBe(true);
      expect(manager.skillGrantAllows('Bash', { command: 'rm -rf /' })).toBe(false);

      // A BARE entry is the wider grant: the doc pre-approves "the listed
      // tools", with no argument qualifier, and warns that "a skill can grant
      // itself broad tool access" precisely because of this form.
      manager.setSkillInvocationToolGrants([{ name: 'bash' }]);
      expect(manager.skillGrantAllows('Bash', { command: 'rm -rf /' })).toBe(true);

      // The grant reads that one store and nothing else, so it cannot outlive
      // the turn: `clearSkillInvocation()` in `chat`'s `finally` is the
      // documented "clears when you send your next message".
      manager.setSkillInvocationToolGrants([{ name: 'bash', patterns: [`${RENDER} *`] }]);
      manager.clearSkillInvocation();
      expect(manager.skillGrantAllows('Bash', { command: `${RENDER} probe` })).toBe(false);
    });
  });

  /**
   * `skills.md:262` / `:430` — "Tools removed from Claude's available pool
   * while this skill is active … The restriction clears when you send your next
   * message." Subtraction, which the ceiling alone could not express.
   */
  /**
   * P6.618 — `sub-agents.md` § *Available tools*: "Both fields accept MCP
   * server-level patterns in addition to exact tool names: `mcp__<server>` or
   * `mcp__<server>__*` grants or removes every tool from the named server."
   *
   * The grant map is keyed by exact canonical name and was read by exact
   * lookup, so BOTH documented shapes pre-approved nothing at the point of
   * enforcement — a skill that declared its own bundled server still prompted
   * for every one of that server's tools.
   */
  describe('MCP server-level allowed-tools entry', () => {
    it('pre-approves every tool of the named server, in both documented shapes', () => {
      for (const entry of ['mcp__wire', 'mcp__wire__*']) {
        const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
        manager.setSkillInvocationToolGrants([{ name: entry }]);
        expect(manager.skillGrantAllows('mcp__wire__query'), entry).toBe(true);
        expect(manager.skillGrantAllows('mcp__wire__insert'), entry).toBe(true);
        // A server-level entry is bare by construction, so it grants with any
        // input rather than matching an argument pattern.
        expect(manager.skillGrantAllows('mcp__wire__query', { sql: 'select 1' }), entry).toBe(true);
      }
    });

    it('pre-approves nothing outside the named server, and nothing at all for a foreign one', () => {
      const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
      manager.setSkillInvocationToolGrants([{ name: 'mcp__git' }]);
      // The trailing `__` is a prefix boundary: a server whose name merely
      // BEGINS with the granted one is a different server.
      expect(manager.skillGrantAllows('mcp__github__create_issue')).toBe(false);
      expect(manager.skillGrantAllows('mcp__wire__query')).toBe(false);
      // Not an MCP name at all, and the positive control that the grant works
      // on the server it does name.
      expect(manager.skillGrantAllows('Bash', { command: 'git status' })).toBe(false);
      expect(manager.skillGrantAllows('mcp__git__status')).toBe(true);
    });

    it('lets an exact entry outrank the pattern reading, which is why exact runs first', () => {
      // `mcp__tool_search` is a real one-separator POOL name that also fits the
      // bare `mcp__<server>` shape. Granting it must pre-approve that tool and
      // must not be re-read as a grant on a server called `tool_search`.
      const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
      manager.setSkillInvocationToolGrants([{ name: 'mcp__tool_search' }]);
      expect(manager.skillGrantAllows('mcp__tool_search')).toBe(true);
      // `mcp__session` is reserved — Nessy's prefix for BUILT-IN tools, which
      // are not MCP tools in Claude — so it is refused as a server name by the
      // one shared helper, here exactly as on the Pi side.
      const session = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
      session.setSkillInvocationToolGrants([{ name: 'mcp__session' }]);
      expect(session.skillGrantAllows('mcp__session__remember')).toBe(false);
    });
  });

  describe('disallowed-tools', () => {
    it('removes a tool with no grant declared, and outranks a grant naming it', () => {
      const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
      // No `allowed-tools`: the removal must not depend on a grant existing.
      manager.setSkillInvocationDeniedTools(['AskUserQuestion']);
      expect(manager.checkPrerequisites('AskUserQuestion')).toEqual({
        allowed: false,
        blockReason: 'Tool "AskUserQuestion" was removed by the invoked skill\'s disallowed-tools.',
      });
      expect(manager.checkPrerequisites('Read').allowed).toBe(true);

      // A skill that both grants and removes the same tool: the removal wins,
      // and it also swallows the pre-approval — a tool that is not in the pool
      // cannot be pre-approved into it.
      manager.setSkillInvocationToolGrants([{ name: 'bash' }, { name: 'read' }]);
      manager.setSkillInvocationDeniedTools(['Bash']);
      expect(manager.checkPrerequisites('Bash').allowed).toBe(false);
      expect(manager.skillGrantAllows('Bash', { command: 'ls' })).toBe(false);
      expect(manager.checkPrerequisites('Read').allowed).toBe(true);

      manager.clearSkillInvocation();
      expect(manager.checkPrerequisites('AskUserQuestion').allowed).toBe(true);
      expect(manager.checkPrerequisites('Bash').allowed).toBe(true);
    });

    /**
     * P6.618 — the deny half of the same sentence, asserted from THIS side so
     * the grant below cannot be read as widening what a removal takes away.
     */
    it('outranks an MCP server-level grant', () => {
      const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
      manager.setSkillInvocationToolGrants([{ name: 'mcp__wire' }]);
      expect(manager.skillGrantAllows('mcp__wire__query')).toBe(true);
      manager.setSkillInvocationDeniedTools(['mcp__wire__query']);
      expect(manager.skillGrantAllows('mcp__wire__query')).toBe(false);
      // The sibling the removal does not name stays pre-approved by the server
      // grant, so the removal is subtracting one tool rather than voiding the
      // whole entry.
      expect(manager.skillGrantAllows('mcp__wire__insert')).toBe(true);
    });

    it('cannot remove EndConversation unless the caller says nothing else remains', () => {
      const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
      // The documented exception: a glob that sweeps it up leaves it in place.
      manager.setSkillInvocationDeniedTools(['*']);
      expect(manager.checkPrerequisites('EndConversation').allowed).toBe(true);
      expect(manager.checkPrerequisites('Read').allowed).toBe(false);

      // "Alone, it is removable like any other tool."
      manager.setSkillInvocationDeniedTools(['EndConversation'], { mayRemoveEndConversation: true });
      expect(manager.checkPrerequisites('EndConversation').allowed).toBe(false);
    });
  });

  it('preserves the grant, the removal and the agent ceiling across compaction, and clears them on a full reset', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationToolGrants([{ name: 'read' }]);
    manager.setSkillInvocationDeniedTools(['Bash']);
    manager.setSkillInvocationAgentCeiling(['reviewer']);

    manager.resetReadState({ preserveSkillInvocation: true });

    expect(manager.skillGrantAllows('Read')).toBe(true);
    expect(manager.checkPrerequisites('Bash').allowed).toBe(false);
    expect(manager.checkPrerequisites('subagent', { agent: 'scout', task: 'inspect' }).allowed).toBe(false);

    manager.resetReadState();

    expect(manager.skillGrantAllows('Read')).toBe(false);
    expect(manager.checkPrerequisites('Bash').allowed).toBe(true);
    expect(manager.checkPrerequisites('subagent', { agent: 'scout', task: 'inspect' }).allowed).toBe(true);
  });
});
