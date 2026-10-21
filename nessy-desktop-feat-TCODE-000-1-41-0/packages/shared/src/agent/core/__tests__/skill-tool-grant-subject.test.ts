import { describe, expect, it } from 'bun:test';

import { PI_TOOL_BINDINGS } from '../../pi-harness/harness-tool-descriptor.ts';
import { PrerequisiteManager } from '../prerequisite-manager.ts';

/**
 * A parameterized `allowed-tools` entry pre-approves against a tool-input
 * FIELD, and the field has to be the one the runtime actually populates.
 * `PI_TOOL_BINDINGS` is the contract: the bindings whose `permissionName` is
 * `Bash` are `bash` and `bash_background`, and their local port declares
 * `command`. If a binding is renamed, added, or re-pointed, this fails here
 * rather than silently pre-approving nothing — or, worse, everything.
 *
 * Every arm reads `skillGrantAllows`, because that is the whole of what the
 * field does: "Tools Claude can use without asking permission during the turn
 * that invokes this skill." It cannot block, so `checkPrerequisites` is asserted
 * only where it proves the call is still callable.
 */
describe('parameterized allowed-tools subject field', () => {
  const grantedManager = (patterns: string[]) => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationToolGrants([{ name: 'bash', patterns }]);
    return manager;
  };

  it('covers every binding the gate presents as Bash', () => {
    const bashBindings = PI_TOOL_BINDINGS.filter(binding => binding.permissionName === 'Bash');
    expect(bashBindings.map(binding => binding.bindingName).sort()).toEqual(['bash', 'bash_background']);

    // Every spelling a call arrives under — permission name and binding name —
    // has to resolve to the same subject. Proven behaviourally: a matching
    // command is pre-approved under each, which is only possible if the name
    // maps to a field the input carries.
    const manager = grantedManager(['/skills/r17/scripts/render.sh *']);
    for (const toolName of ['Bash', 'bash']) {
      expect(manager.skillGrantAllows(toolName, { command: '/skills/r17/scripts/render.sh probe' })).toBe(true);
    }
  });

  it('withholds the pre-approval — never widens it — when the subject field is missing or not a string', () => {
    const manager = grantedManager(['/skills/r17/scripts/render.sh *']);
    // This is the renamed-field failure mode. It must fail CLOSED: no
    // pre-approval. The call is not refused either — the ordinary permission
    // flow decides, which is what `allowed-tools` leaves in place.
    for (const input of [{}, { cmd: '/skills/r17/scripts/render.sh probe' }, { command: 42 }, undefined]) {
      const typed = input as Record<string, unknown> | undefined;
      expect(manager.skillGrantAllows('Bash', typed)).toBe(false);
      expect(manager.checkPrerequisites('Bash', typed).allowed).toBe(true);
    }
  });

  it('enforces a NON-Bash specifier instead of dropping it', () => {
    // `Name(pattern)` in `allowed-tools` is a permission rule string
    // (`skills.md` writes them in `permissions.md` syntax), so a path specifier
    // narrows what the pre-approval covers the same way a permission rule would.
    // The single leading slash anchors at the grant's own source — for a
    // turn-scoped skill grant, the session-rule row of `permissions.md:296`.
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationToolGrants([{ name: 'read', patterns: ['/only/this.txt'] }]);

    expect(manager.skillGrantAllows('Read', { file_path: '/workspace/only/this.txt' })).toBe(true);
    expect(manager.skillGrantAllows('Read', { file_path: '/somewhere/else.txt' })).toBe(false);
    // A call that carries no path at all cannot prove the constraint.
    expect(manager.skillGrantAllows('Read', {})).toBe(false);
    // ...and none of those is a refusal.
    expect(manager.checkPrerequisites('Read', { file_path: '/somewhere/else.txt' }).allowed).toBe(true);
  });

  it('treats a form no permission check matches as the bare, wider grant', () => {
    // `Write(path)` is the documented accepted-but-never-matched spelling
    // (`permissions.md:263`), where it behaves as a whole-tool allow. The author
    // listed Write, so the grant is the tool — dropping it would silently
    // withhold a pre-approval the frontmatter plainly declares.
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationToolGrants([{ name: 'write', patterns: ['/only/this.txt'] }]);
    expect(manager.skillGrantAllows('Write', { file_path: '/only/this.txt' })).toBe(true);
    expect(manager.skillGrantAllows('Write', { file_path: '/somewhere/else.txt' })).toBe(true);
    expect(manager.checkPrerequisites('Write', { file_path: '/somewhere/else.txt' }).allowed).toBe(true);
  });

  it('leaves a tool the grant does not name callable, and unapproved', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/workspace' });
    manager.setSkillInvocationToolGrants([{ name: 'read' }]);
    // A bare entry pre-approves the tool outright — the doc grants "the listed
    // tools", unqualified.
    expect(manager.skillGrantAllows('Read', { file_path: '/anywhere.txt' })).toBe(true);
    // An unlisted tool keeps the permission flow it would have had anyway;
    // `allowed-tools` "does not restrict which tools are available".
    const outside = manager.checkPrerequisites('Bash', { command: 'ls' });
    expect(outside).toEqual({ allowed: true });
    expect(manager.skillGrantAllows('Bash', { command: 'ls' })).toBe(false);
  });
});

/**
 * P2.271 — a skill grant that will not COMPILE is skipped, and the skip has to
 * say so.
 *
 * `compileSkillGrant` builds a one-rule allow program per pattern. Since P2.270
 * a matcher that will not compile is skipped rather than kept, so that program
 * ends up with no rules and `matchSkillToolPatterns` answers `'no-match'` — the
 * skill quietly loses the pre-approval its frontmatter asked for. Failing
 * CLOSED there is deliberate (a grant we cannot read must not widen); being
 * SILENT is not: `managed-settings.md#keys-that-fail-closed` — "an individual
 * entry that fails, such as a malformed permission rule, is skipped with a
 * warning while the rest of the file applies."
 *
 * `CompiledPermissionDslV1.diagnostics` carried that warning and this caller
 * dropped it, exactly as the settings path did.
 */
describe('an uncompilable allowed-tools pattern announces itself', () => {
  const withDebug = (patterns: string[]) => {
    const lines: string[] = [];
    const manager = new PrerequisiteManager({
      workspaceRootPath: '/workspace',
      onDebug: (message: string) => { lines.push(message); },
    });
    manager.setSkillInvocationToolGrants([{ name: 'read', patterns }]);
    return { manager, lines };
  };

  it('names the pattern and the compiler\'s reason', () => {
    // The diagnostic's own rule id is the synthetic `skill-grant`, which would
    // point the author at nothing, so the line has to carry the pattern.
    const { manager, lines } = withDebug(['/a\\b']);
    const dropped = lines.filter(line => line.includes('was skipped'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('Read(/a\\b)');
    expect(dropped[0]).toContain('unparseable-rule');
    expect(dropped[0]).toContain('invalid pathGlob pattern');
    // And the behaviour it describes is real: the grant does not match.
    expect(manager.skillGrantAllows('Read', { file_path: '/workspace/a\\b' })).toBe(false);
  });

  it('one line per pattern, and a compilable neighbour is untouched and silent', () => {
    // Positive control on the same rig: without one, a `withDebug` that had
    // stopped wiring `onDebug` at all would satisfy every "no warning" claim.
    const { manager, lines } = withDebug(['/a\\b', '/only/this.txt', '~//x']);
    expect(lines.filter(line => line.includes('was skipped'))).toHaveLength(2);
    expect(lines.filter(line => line.includes('Read(/only/this.txt)'))).toHaveLength(0);
    expect(manager.skillGrantAllows('Read', { file_path: '/workspace/only/this.txt' })).toBe(true);

    const clean = withDebug(['/only/this.txt']);
    expect(clean.lines.filter(line => line.includes('was skipped'))).toHaveLength(0);
    expect(clean.manager.skillGrantAllows('Read', { file_path: '/workspace/only/this.txt' })).toBe(true);
  });
});
