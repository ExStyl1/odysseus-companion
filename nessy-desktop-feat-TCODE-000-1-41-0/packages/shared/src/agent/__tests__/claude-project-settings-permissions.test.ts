/**
 * Project `.claude/settings.json` permission rules.
 *
 * permissions.md § Project allow rules and workspace trust:
 *   "`permissions.allow` rules and `permissions.additionalDirectories` entries
 *   in a project's `.claude/settings.json` grant capability, so Claude Code
 *   applies them only after you accept the workspace trust dialog for that
 *   workspace. Until then, Claude Code reads the rules but doesn't apply them."
 *
 * settings.md § Settings files puts the same block in
 * `.claude/settings.local.json` at the Local scope.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { parsePermissionsJson, permissionsConfigCache } from '../permissions-config.ts';
import {
  evaluateCdPermissionDslV1,
  evaluatePermissionDslV1,
  filterCapabilityIdentitiesByWholeToolDeny,
  isWholeCapabilityDeniedByPermissionDsl,
  type CompiledPermissionDslV1,
} from '../pi-harness/permission-dsl.ts';
import { evaluateClaudeHookIfFilter } from '../pi-harness/claude-permission-rules.ts';
import { enableDebug } from '../../utils/debug.ts';

afterEach(() => { permissionsConfigCache.clear(); });

/**
 * The `allow`/`deny` halves are permissions.md:120-133 verbatim; the `ask`
 * entry and the `Read(./.env)` deny come from the same page's rule examples.
 */
const CLAUDE_SETTINGS = JSON.stringify({
  permissions: {
    allow: ['Bash(npm run *)', 'Bash(git commit *)'],
    ask: ['Bash(git push *)'],
    deny: ['Bash(curl:*)', 'Read(./.env)'],
  },
});

/** The directory the settings file lives in — what `/x` anchors against. */
const SETTINGS_ROOT = '/nonexistent/settings-source';

function decide(
  content: string,
  scope: 'project' | 'workspace',
  projectTrusted: boolean,
  request: { toolName: string; semanticId: string; input: Record<string, unknown> },
  sourceRoot?: string,
) {
  const merged = permissionsConfigCache.getMergedConfig({
    workspaceRootPath: `/nonexistent/ws-${scope}-${projectTrusted}-${sourceRoot ?? 'none'}`,
    pinnedRevision: 'gen',
    projectTrusted,
    pinnedConfigs: [{ config: parsePermissionsJson(content, sourceRoot), scope }],
  });
  const program = merged.permissionDsl;
  if (!program) return 'no-program';
  return evaluatePermissionDslV1(program, {
    generation: 'gen', cwd: '/work/repo', ...request,
  }).action ?? 'none';
}

/** The same decision, from a settings file that knows where it lives. */
function decideAnchored(
  content: string,
  request: { toolName: string; semanticId: string; input: Record<string, unknown> },
) {
  return decide(content, 'project', true, request, SETTINGS_ROOT);
}

describe('Claude settings permission blocks', () => {
  it('compiles every rule in a verbatim Claude block, none inert', () => {
    const config = parsePermissionsJson(CLAUDE_SETTINGS);
    const document = config.permissionDsl?.document as { version: number; rules: unknown[] } | undefined;
    expect(document?.version).toBe(1);
    expect(document?.rules).toHaveLength(5);
    expect(config.permissionDsl?.diagnostic).toBeUndefined();
  });

  it('is not confused with a Nessy permissions.json', () => {
    const nessy = parsePermissionsJson(JSON.stringify({ allowedBashPatterns: ['^git status$'] }));
    expect(nessy.permissionDsl).toBeUndefined();
    expect(nessy.allowedBashPatterns).toEqual([{ pattern: '^git status$' }]);
  });

  it('applies deny, ask and allow from a trusted project', () => {
    const call = (command: string) => ({ toolName: 'Bash', semanticId: 'bash', input: { command } });
    expect(decide(CLAUDE_SETTINGS, 'project', true, call('curl https://example.test'))).toBe('deny');
    expect(decide(CLAUDE_SETTINGS, 'project', true, call('git push origin main'))).toBe('ask');
    expect(decide(CLAUDE_SETTINGS, 'project', true, call('npm run build'))).toBe('allow');
    expect(decide(CLAUDE_SETTINGS, 'project', true, {
      toolName: 'Read', semanticId: 'read', input: { file_path: '/work/repo/.env' },
    })).toBe('deny');
  });

  it('the project trust gate withholds an untrusted project layer', () => {
    const call = (command: string) => ({ toolName: 'Bash', semanticId: 'bash', input: { command } });
    expect(decide(CLAUDE_SETTINGS, 'project', false, call('npm run build'))).toBe('none');
    // The same file at workspace scope is unaffected by project trust.
    expect(decide(CLAUDE_SETTINGS, 'workspace', false, call('npm run build'))).toBe('allow');
  });

  /**
   * D3 — a settings-anchored path rule is ENFORCED, not dropped.
   *
   * permissions.md gives file-tool rules four anchors, and the third is the
   * settings source: "Path patterns share the `//`, `~/`, and `/` anchors from
   * Read and Edit rules". A fleet administrator writing the documented
   * `deny: ["Read(/secrets/**)"]` in a project settings file used to get ZERO
   * coverage — the rest of the layer applied, so nothing looked wrong — and the
   * test below asserted that 2 of 3 rules vanished, pinning the defect as if it
   * were the contract.
   *
   * `permission-dsl` has always accepted `layer.sourceRoot`; it was simply
   * never passed from the settings loaders. It is now, and the ONE case with no
   * file to anchor to keeps dropping, out loud.
   */
  const ANCHORED = JSON.stringify({
    permissions: { deny: ['Read(/secrets/**)', 'Cd(/vendor)', 'Bash(curl:*)'] },
  });

  it('a `/`-anchored deny from a settings file denies, anchored at that file\'s directory', () => {
    // Every matcher that can carry the anchor, not just `pathGlob`: `Cd(/x)`
    // compiles to a `cdPath` with the same anchor.
    const document = parsePermissionsJson(ANCHORED, SETTINGS_ROOT).permissionDsl?.document as { rules: unknown[] };
    expect(document.rules).toHaveLength(3);

    // `/secrets/**` resolves under the SETTINGS SOURCE, not the request cwd and
    // not the filesystem root.
    expect(decideAnchored(ANCHORED, {
      toolName: 'Read', semanticId: 'read', input: { file_path: `${SETTINGS_ROOT}/secrets/db.pem` },
    })).toBe('deny');
    expect(decideAnchored(ANCHORED, {
      toolName: 'Bash', semanticId: 'bash', input: { command: 'curl https://example.test' },
    })).toBe('deny');
    // A path outside the anchor is untouched, and so is one at the filesystem
    // root that only a `//`-anchored rule would have reached.
    expect(decideAnchored(ANCHORED, {
      toolName: 'Read', semanticId: 'read', input: { file_path: '/work/repo/src/a.ts' },
    })).toBe('none');
    expect(decideAnchored(ANCHORED, {
      toolName: 'Read', semanticId: 'read', input: { file_path: '/secrets/db.pem' },
    })).toBe('none');
  });

  it('a relative rule is unchanged — it still resolves against the request cwd', () => {
    const relative = JSON.stringify({ permissions: { deny: ['Read(./.env)'] } });
    expect(decideAnchored(relative, {
      toolName: 'Read', semanticId: 'read', input: { file_path: '/work/repo/.env' },
    })).toBe('deny');
    expect(decideAnchored(relative, {
      toolName: 'Read', semanticId: 'read', input: { file_path: `${SETTINGS_ROOT}/.env` },
    })).toBe('none');
  });

  it('with no settings source the anchored rules still drop, and the rest of the layer stands', () => {
    // The layer must not fail CLOSED as a whole: an anchor the compiler cannot
    // resolve throws, and the compiler catches per LAYER, so one unsupported
    // rule would otherwise become a deny of every tool.
    const document = parsePermissionsJson(ANCHORED).permissionDsl?.document as { rules: unknown[] };
    expect(document.rules).toHaveLength(1);
    expect(decide(ANCHORED, 'project', true, {
      toolName: 'Bash', semanticId: 'bash', input: { command: 'curl https://example.test' },
    })).toBe('deny');
    expect(decide(ANCHORED, 'project', true, {
      toolName: 'Read', semanticId: 'read', input: { file_path: '/work/repo/src/a.ts' },
    })).toBe('none');
  });
});

/**
 * D3, the other half — a DELIVERED managed policy has no file to anchor to.
 *
 * `server-managed-settings.md` describes managed settings arriving from a
 * remote endpoint, so the document that reaches the compiler has no directory
 * behind it. Rather than invent a root (which would silently point an
 * administrator's rule at a directory they never named) the anchored rule is
 * dropped — per RULE, and out loud.
 */
describe('a delivered managed policy drops the settings-source anchor, and says why', () => {
  const MANAGED = {
    version: 1 as const,
    rules: [
      { id: 'managed-anchored', action: 'deny' as const, match: { kind: 'pathGlob' as const, pattern: 'secrets/**', anchor: 'source' as const } },
      { id: 'managed-absolute', action: 'deny' as const, match: { kind: 'pathGlob' as const, pattern: 'etc/**', anchor: 'absolute' as const } },
      { id: 'managed-bash', action: 'deny' as const, match: { kind: 'tool' as const, semanticId: 'bash' } },
    ],
  };

  function managedProgram() {
    return permissionsConfigCache.getMergedConfig({
      workspaceRootPath: '/nonexistent/ws-managed-anchor',
      pinnedRevision: 'gen',
      projectTrusted: true,
      pinnedConfigs: [],
      managedPermissionDsl: MANAGED,
    }).permissionDsl;
  }

  it('drops ONLY the anchored rule — every other managed rule still applies', () => {
    const program = managedProgram();
    const ids = (program?.rules ?? []).map(rule => rule.id);
    expect(ids).not.toContain('managed-anchored');
    expect(ids).toContain('managed-absolute');
    expect(ids).toContain('managed-bash');
    // The layer did NOT fail closed: no diagnostic, no invalid source. One
    // unresolvable anchor must not take the rest of a fleet policy down.
    expect(program?.diagnostics ?? []).toHaveLength(0);
    expect(program?.invalidSource).toBeUndefined();
  });

  it('the surviving managed rules still decide', () => {
    const program = managedProgram();
    expect(program).toBeDefined();
    expect(evaluatePermissionDslV1(program!, {
      generation: 'gen', cwd: '/work/repo', toolName: 'Bash', semanticId: 'bash', input: {},
    }).action).toBe('deny');
  });

  it('the drop is reported with the reason and the remedy, not silently', () => {
    // The drop must be diagnosable by whoever deployed the policy. `debug()`
    // writes the app's diagnostic stream to stderr; this reads it back rather
    // than trusting that a reason exists somewhere.
    enableDebug();
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    };
    try {
      permissionsConfigCache.clear();
      permissionsConfigCache.getMergedConfig({
        workspaceRootPath: '/nonexistent/ws-managed-anchor-debug',
        pinnedRevision: 'gen',
        projectTrusted: true,
        pinnedConfigs: [],
        managedPermissionDsl: MANAGED,
      });
    } finally {
      (process.stderr as unknown as { write: unknown }).write = originalWrite;
    }
    const reported = captured.join('\n');
    expect(reported).toContain('managed-anchored');
    expect(reported).toContain('a delivered managed policy has no file to anchor to');
    expect(reported).toContain('Use the `//` (absolute) or `~/` (home) anchor instead.');
  });
});

/**
 * P2.127 / P2.270 — ONE uncompilable rule costs ONE rule, not the whole policy,
 * and it costs that rule WHATEVER ITS ACTION.
 *
 * `managed-settings.md#keys-that-fail-closed` states it for the exact surface
 * this defect was found on, a project settings file:
 *   "This tolerance applies only to managed settings. User, project, and local
 *   settings files remain strict: a file whose JSON or top-level shape fails
 *   validation is rejected as a whole and reported, and an individual entry
 *   that fails, such as a malformed permission rule, is skipped with a warning
 *   while the rest of the file applies."
 * `#find-entries-claude-code-dropped` says the same for managed sources —
 *   "Claude Code first skips the individual entries it can repair, such as one
 *   invalid permission rule, with a warning for each, then drops any top-level
 *   key whose value still fails and keeps enforcing every remaining valid key."
 * — and that page's `deniedMcpServers` row gives the reason a skip is not
 * reserved for grants:
 *   "A wholly invalid value is dropped with a warning, since denying every
 *   server would block servers the policy never named."
 *
 * The native reader used to fail the whole LAYER: one unrepresentable specifier
 * set `invalidSource` and every tool call answered `deny` under
 * `ruleId: 'invalid-policy'` — measured on `0112ed9c9`: `deny:['Read(/a\b)'] +
 * allow:['Bash(ls:*)']` compiled 0 of 2 rules and evaluated `ls -la` to `deny`.
 * `1e2aa4438` scoped that to the rule but kept an uncompilable `deny`/`ask`
 * deciding at its own action over everything — a blanket prohibition nobody
 * wrote, which is what the `deniedMcpServers` sentence argues against.
 *
 * OQ-8 was resolved by the owner on 2026-08-27 toward the contract, cost
 * stated: a typo in a `deny` rule now stops denying, and the user may not read
 * the warning. The tests below assert that cost explicitly rather than leaving
 * it implied — see `an uncompilable DENY is skipped too`.
 */
describe('an uncompilable rule costs one rule, not the policy', () => {
  let workspace = 0;

  /** Compile one project settings block, with a co-resident allow beside it. */
  function compile(block: Record<string, string[]>) {
    const config = parsePermissionsJson(JSON.stringify({ permissions: block }), SETTINGS_ROOT);
    permissionsConfigCache.clear();
    return permissionsConfigCache.getMergedConfig({
      workspaceRootPath: `/nonexistent/ws-unparseable-${workspace++}`,
      pinnedRevision: 'gen',
      projectTrusted: true,
      pinnedConfigs: [{ config, scope: 'project' }],
    }).permissionDsl!;
  }

  const bashCall = { generation: 'gen', cwd: '/work/repo', toolName: 'Bash', semanticId: 'bash', input: { command: 'ls -la' } };
  const long = (size: number) => 'a'.repeat(size);

  /**
   * Every pattern class MEASURED to reach the compiler's throw from a project
   * settings file (2026-08-27). The row named one — a backslash in a
   * `/`-anchored pattern — and asked whether others did: TWENTY do. They are
   * not one predicate but nine, spread over seven matcher kinds, which is why
   * the fix sits at the compile loop rather than in the `pathGlob` branch.
   */
  const UNCOMPILABLE: readonly (readonly [string, string])[] = [
    ['backslash, settings-source anchor (the row\'s case)', 'Read(/a\\b)'],
    ['backslash, absolute anchor', 'Read(//a\\b)'],
    ['backslash, home anchor', 'Read(~/a\\b)'],
    ['backslash, relative anchor', 'Read(a\\b)'],
    ['a Windows path, which is the user story', 'Read(C:\\Users\\alice\\.env)'],
    ['Edit carries the same matcher as Read', 'Edit(/a\\b)'],
    ['a pattern still `/`-led after the anchor strips', 'Read(~//x)'],
    ['a NUL byte in the pattern', 'Read(/a\u0000b)'],
    ['a pathGlob pattern over 1024 chars', `Read(/${long(1025)})`],
    ['cdPath backslash', 'Cd(/a\\b)'],
    ['cdPath still `/`-led after the anchor strips', 'Cd(~//x)'],
    ['cdPath NUL byte', 'Cd(/a\u0000b)'],
    ['cdPath pattern over 1024 chars', `Cd(/${long(1025)})`],
    ['a Bash pattern over 1024 chars', `Bash(${long(1025)})`],
    ['a PowerShell pattern over 1024 chars', `PowerShell(${long(1025)})`],
    ['a bare tool name over 256 chars', long(300)],
    ['an MCP server name over 256 chars', `mcp__${long(300)}__tool`],
    ['an MCP tool name over 256 chars', `mcp__srv__${long(300)}`],
    ['an Agent name over 256 chars', `Agent(${long(300)})`],
    ['a WebFetch domain over 256 chars', `WebFetch(domain:${long(300)})`],
    ['a parameter name over 128 chars', `Foo(${long(200)}:v)`],
    ['a parameter glob over 256 chars', `Foo(p:*${long(300)})`],
  ];

  it.each(UNCOMPILABLE)('%s: the rule is skipped and the rest of the layer stands', (_label, entry) => {
    const program = compile({ deny: [entry], allow: ['Bash(ls:*)'] });
    // The policy is NOT invalidated, and the co-resident rule is still there.
    expect(program.invalidSource).toBeUndefined();
    // The offending rule is GONE — not degraded into something that still
    // decides — and the co-resident allow is the only rule left, compiled.
    expect(program.rules.map(rule => rule.id)).toEqual(['claude-settings-allow-0']);
    expect(program.rules[0]!.matcher.kind).toBe('bashPattern');
    // ...and the skip says which rule, with one warning for it.
    expect(program.droppedRules.map(rule => rule.id)).toEqual(['claude-settings-deny-0']);
    expect(program.droppedRules[0]!.action).toBe('deny');
    expect(program.diagnostics).toHaveLength(1);
    expect(program.diagnostics[0]!.code).toBe('unparseable-rule');
    expect(program.diagnostics[0]!.message).toContain('"claude-settings-deny-0"');
    expect(program.diagnostics[0]!.message).toContain('skipped');
    // The survivor still decides, on all 22 classes: this is the whole row.
    expect(evaluatePermissionDslV1(program, bashCall).action).toBe('allow');
  });

  it('a warning for EACH — two uncompilable rules produce two, both named', () => {
    // "with a warning for each" is per-rule, not per-layer: a layer that
    // reported only the first would leave the second unrepairable.
    const program = compile({ deny: ['Read(C:\\Users\\alice\\.env)', 'Cd(/a\\b)'], allow: ['Bash(ls:*)'] });
    expect(program.rules.map(rule => rule.id)).toEqual(['claude-settings-allow-0']);
    expect(program.droppedRules.map(rule => rule.id))
      .toEqual(['claude-settings-deny-0', 'claude-settings-deny-1']);
    expect(program.diagnostics).toHaveLength(2);
    expect(program.diagnostics[0]!.message).toContain('"claude-settings-deny-0"');
    expect(program.diagnostics[1]!.message).toContain('"claude-settings-deny-1"');
    expect(evaluatePermissionDslV1(program, bashCall).action).toBe('allow');
  });

  it('the surviving rules still decide — a lost ALLOW does not take the others down', () => {
    // The whole point, on the action where dropping is safe. Before the fix
    // this evaluated `deny` under `invalid-policy`.
    const program = compile({ allow: ['Read(C:\\Users\\alice\\.env)', 'Bash(ls:*)'] });
    const decision = evaluatePermissionDslV1(program, bashCall);
    expect(decision.action).toBe('allow');
    expect(decision.match?.ruleId).toBe('claude-settings-allow-1');
  });

  it('the warning reaches the user on the very request the lost allow would have cleared', () => {
    // A dropped allow decides nothing, so it would otherwise announce nothing.
    // It reports itself under the RESERVED `invalid-policy` id — which
    // `SessionManager` and `codex-agent` already hand back to the human, and
    // which the hook `if` filter already fails open on — carrying the reason.
    const program = compile({ allow: ['Read(C:\\Users\\alice\\.env)'] });
    const decision = evaluatePermissionDslV1(program, bashCall);
    expect(decision.action).toBeUndefined();
    expect(decision.match?.ruleId).toBe('invalid-policy');
    expect(decision.diagnostic?.code).toBe('unparseable-rule');
    expect(decision.diagnostic?.message).toContain('claude-settings-allow-0');
    expect(decision.diagnostic?.message).toContain('invalid pathGlob pattern');
    expect(decision.diagnostic?.message).toContain('skipped');
  });

  it('an uncompilable ALLOW never grants, and a real deny still outranks it', () => {
    const program = compile({ allow: ['Read(C:\\Users\\alice\\.env)'], deny: ['Bash(ls:*)'] });
    const decision = evaluatePermissionDslV1(program, bashCall);
    expect(decision.action).toBe('deny');
    expect(decision.match?.ruleId).toBe('claude-settings-deny-0');
  });

  it('an uncompilable DENY is skipped too, and the accepted cost is that it stops denying', () => {
    // OQ-8's resolved direction, and the cost the owner accepted stated out
    // loud rather than left implied. Between `1e2aa4438` and P2.270 this
    // answered `deny` under `invalid-policy` — a blanket prohibition over every
    // tool that no user rule wrote.
    const program = compile({ deny: ['Read(C:\\Users\\alice\\.env)'], allow: ['Bash(ls:*)'] });
    expect(program.droppedRules.map(rule => [rule.id, rule.action]))
      .toEqual([['claude-settings-deny-0', 'deny']]);
    const decision = evaluatePermissionDslV1(program, bashCall);
    expect(decision.action).toBe('allow');
    expect(decision.match?.ruleId).toBe('claude-settings-allow-0');
    // The skip is not silent — this warning is the only thing standing between
    // the user and a deny rule that quietly stopped denying.
    expect(program.diagnostics[0]!.code).toBe('unparseable-rule');
    expect(program.diagnostics[0]!.message).toContain('claude-settings-deny-0');
    expect(program.diagnostics[0]!.message).toContain('skipped');
    // Enforcement and advertisement still agree, now in the other direction: a
    // rule that denies nothing must not strip the tool from the model's
    // context. A half-flip that dropped the rule at the gate but kept it in the
    // deny filter would leave Bash allowed and invisible.
    // `Bash`, not `bash`: a bare `deny: ['Bash']` compiles to
    // `{kind:'tool', semanticId:'Bash'}` and `wildcard` is case-sensitive, so
    // asserting `false` for `'bash'` would hold even under a full regression.
    expect(isWholeCapabilityDeniedByPermissionDsl(program, 'Bash')).toBe(false);
    expect(filterCapabilityIdentitiesByWholeToolDeny(
      [{ bindingName: 'bash', piName: 'bash', semanticId: 'bash', permissionName: 'Bash' }],
      program,
    )).toHaveLength(1);
    // Positive control on the same rig and the same spelling: a deny that DOES
    // compile still removes the tool, so the two assertions above are measuring
    // the skip and not a filter that stopped working.
    const compilable = compile({ deny: ['Bash'] });
    expect(isWholeCapabilityDeniedByPermissionDsl(compilable, 'Bash')).toBe(true);
    expect(filterCapabilityIdentitiesByWholeToolDeny(
      [{ bindingName: 'bash', piName: 'bash', semanticId: 'bash', permissionName: 'Bash' }],
      compilable,
    )).toHaveLength(0);
  });

  it('an uncompilable ASK is skipped too, so it no longer prompts on everything', () => {
    const program = compile({ ask: ['Read(C:\\Users\\alice\\.env)'], allow: ['Bash(ls:*)'] });
    expect(program.droppedRules.map(rule => [rule.id, rule.action]))
      .toEqual([['claude-settings-ask-0', 'ask']]);
    const decision = evaluatePermissionDslV1(program, bashCall);
    expect(decision.action).toBe('allow');
    expect(decision.match?.ruleId).toBe('claude-settings-allow-0');
    // With nothing else to decide, the skipped ask still reports itself rather
    // than vanishing — the same announcement a skipped allow gets.
    const alone = evaluatePermissionDslV1(compile({ ask: ['Read(C:\\Users\\alice\\.env)'] }), bashCall);
    expect(alone.action).toBeUndefined();
    expect(alone.match?.ruleId).toBe('invalid-policy');
    expect(alone.diagnostic?.message).toContain('claude-settings-ask-0');
  });

  it('the Cd evaluator skips it too — and a skipped Cd allow does not switch allowlist mode on', () => {
    // `evaluateCdPermissionDslV1` reads `program.rules` through `isCdRule`; a
    // skipped rule is not in `rules` at all, so it reaches neither the deny
    // check nor the allowlist switch. "Adding any Cd allow rule switches /cd to
    // allowlist mode" — a rule nobody could read was not added.
    const move = { path: `${SETTINGS_ROOT}/sub`, cwd: '/work/repo' };
    expect(evaluateCdPermissionDslV1(compile({ deny: ['Cd(/a\\b)'] }), move).decision).toBe('prompt');
    expect(evaluateCdPermissionDslV1(compile({ ask: ['Cd(/a\\b)'] }), move).decision).toBe('prompt');
    expect(evaluateCdPermissionDslV1(compile({ allow: ['Cd(/a\\b)'] }), move).decision).toBe('prompt');
    // Positive controls on the same rig, or the three `prompt`s above are also
    // satisfied by an evaluator that has stopped evaluating: a Cd deny that
    // COMPILES still refuses, and a Cd allow that compiles still switches
    // allowlist mode on and refuses an unmatched target.
    expect(evaluateCdPermissionDslV1(compile({ deny: ['Cd(/sub)'] }), move).decision).toBe('deny');
    expect(evaluateCdPermissionDslV1(compile({ allow: ['Cd(/vendor)'] }), move)).toEqual({
      decision: 'deny', allowlistRefusal: true,
    });
    expect(evaluateCdPermissionDslV1(compile({ allow: ['Cd(/sub)'] }), move).decision).toBe('allow');
  });

  it('the hook `if` filter still fails open on a rule that cannot compile', () => {
    // hooks.md's documented posture, and the reason the degraded rule reports
    // `invalid-policy` rather than its own id: `evaluateClaudeHookIfFilter`
    // compiles a ONE-RULE allow program and reads that id to decide. A plain
    // drop would have left it with an empty program and silently stopped the
    // hook from running.
    expect(evaluateClaudeHookIfFilter('Read(/a\\b)', { cwd: '/work/repo', toolName: 'Read', sourceRoot: SETTINGS_ROOT }))
      .toEqual({ run: true, unparseableRule: true });
    // Positive control on the same rig: a rule that DOES compile still gates.
    expect(evaluateClaudeHookIfFilter('Read(/secrets/**)', {
      cwd: '/work/repo', toolName: 'Read', toolInput: { file_path: `${SETTINGS_ROOT}/secrets/db.pem` }, sourceRoot: SETTINGS_ROOT,
    })).toEqual({ run: true, unparseableRule: false });
    expect(evaluateClaudeHookIfFilter('Read(/secrets/**)', {
      cwd: '/work/repo', toolName: 'Read', toolInput: { file_path: '/work/repo/src/a.ts' }, sourceRoot: SETTINGS_ROOT,
    })).toEqual({ run: false, unparseableRule: false });
  });

  /**
   * P2.269 — the rule cap was a CLIFF, and the number is ours.
   *
   * This block REPLACES an arm named "a DOCUMENT-level failure still fails the
   * layer closed". That arm listed three members of the layer-fatal set — an
   * unreadable rule id or action, an unknown matcher kind, and a rule count over
   * `MAX_PERMISSION_DSL_RULES` — but the count was the only one a Claude
   * settings file can actually reach, because `parsePermissionsJson` mints every
   * id itself and emits only matcher kinds this compiler knows. So the arm
   * tested the count and nothing else, and the count is no longer a member: every
   * rule of a 513-rule document parses perfectly, and refusing them all was a
   * choice about a number of ours, not an inability to read the document. The
   * other two remain layer-fatal, unchanged and unreachable from here.
   *
   * Measured before this change, through this same production path: at 512
   * rules all 512 compiled, no `invalidSource`, the named deny fired, and a
   * request no rule mentioned was correctly undecided. At 513 **zero** rules
   * compiled, `invalidSource` was set, and that same unmentioned request
   * answered `deny` under `ruleId: 'invalid-policy'` — the whole layer replaced
   * by a blanket prohibition nobody wrote, reported as one generic "Permission
   * DSL document is invalid."
   *
   * `MAX_PERMISSION_DSL_RULES` is from our own `b1571ad0a` and appears in no
   * Claude page, so "refuse rather than raise" does not apply — but raising it
   * only moves the cliff. The cliff is what changed: the overflow is paid by
   * ALLOW rules, which can only narrow, and never by a deny or an ask.
   */
  describe('the rule cap', () => {
    const control = { generation: 'gen', cwd: '/work/repo', toolName: 'Bash', semanticId: 'bash', input: { command: 'git status' } };
    const curl = { generation: 'gen', cwd: '/work/repo', toolName: 'Bash', semanticId: 'bash', input: { command: 'curl https://x.test' } };

    it('a source one rule over the cap keeps every deny, and pays with its trailing allows', () => {
      const program = compile({
        deny: ['Bash(curl:*)'],
        allow: Array.from({ length: 512 }, (_, index) => `Bash(tool${index}:*)`),
      });
      // 513 declared, 512 compiled — and the one that went is an ALLOW.
      expect(program.rules).toHaveLength(512);
      expect(program.invalidSource).toBeUndefined();
      expect(program.droppedRules.map(rule => [rule.id, rule.action]))
        .toEqual([['claude-settings-allow-511', 'allow']]);
      // The layer still DISCRIMINATES, which is the whole defect: the named deny
      // fires, and the control — a command no rule mentions — stays undecided
      // instead of being denied by a reserved id.
      expect(evaluatePermissionDslV1(program, curl).action).toBe('deny');
      expect(evaluatePermissionDslV1(program, control).action).toBeUndefined();
      // ...and a surviving allow still grants.
      expect(evaluatePermissionDslV1(program, {
        ...control, input: { command: 'tool0 --x' },
      }).action).toBe('allow');
    });

    it('the drop NAMES the cap, the count and the rule — the generic collapse named none of the three', () => {
      const program = compile({
        deny: ['Bash(curl:*)'],
        allow: Array.from({ length: 520 }, (_, index) => `Bash(tool${index}:*)`),
      });
      expect(program.droppedRules).toHaveLength(9);
      expect(program.diagnostics).toHaveLength(9);
      for (const diagnostic of program.diagnostics) expect(diagnostic.code).toBe('rule-cap');
      const first = program.diagnostics[0]!.message;
      expect(first).toContain('"claude-settings-allow-511"');
      expect(first).toContain('521 rules');
      expect(first).toContain('at most 512');
      expect(first).toContain('deny and ask rules are always kept');
      // The dropped grant announces itself on the very request it would have
      // cleared, exactly as a dropped rule already does.
      const decision = evaluatePermissionDslV1(program, { ...control, input: { command: 'tool511 --x' } });
      expect(decision.action).toBeUndefined();
      expect(decision.match?.ruleId).toBe('invalid-policy');
      expect(decision.diagnostic?.code).toBe('rule-cap');
    });

    it('an ASK rule is never the one dropped to fit', () => {
      // Dropping an ask leaves the request to the session default, which can be
      // more permissive than a prompt. Only grants pay.
      const program = compile({
        ask: ['Bash(curl:*)'],
        allow: Array.from({ length: 512 }, (_, index) => `Bash(tool${index}:*)`),
      });
      // Lengths, not only the predicate: `every` over an EMPTY array is true, so
      // without these an `ask` that stopped counting against the budget — and
      // therefore rode over the cap — would pass this arm unnoticed.
      expect(program.rules).toHaveLength(512);
      expect(program.droppedRules).toHaveLength(1);
      expect(program.droppedRules.every(rule => rule.action === 'allow')).toBe(true);
      expect(evaluatePermissionDslV1(program, curl).action).toBe('ask');
    });

    it('deny/ask rules ALONE over the cap still fail the layer closed, and now say why', () => {
      // The residue, deliberate: honouring the cap here could only be done by
      // dropping a deny, which is the widening direction. So it stays fail-closed
      // — but the message names the limit and the count instead of arriving as
      // "Permission DSL document is invalid."
      const program = compile({ deny: Array.from({ length: 513 }, (_, index) => `Read(/s${index}/**)`) });
      expect(program.invalidSource?.scope).toBe('project');
      expect(program.rules).toHaveLength(0);
      expect(program.droppedRules).toHaveLength(0);
      expect(program.diagnostics[0]!.code).toBe('rule-cap');
      expect(program.diagnostics[0]!.message).toContain('513 deny/ask permission rules');
      expect(program.diagnostics[0]!.message).toContain('512-rule compile limit');
      expect(program.diagnostics[0]!.message).toContain('would widen the policy');
      expect(evaluatePermissionDslV1(program, control).action).toBe('deny');
    });

    it('CONTROL: a source AT the cap is untouched — nothing is dropped and nothing is named', () => {
      // The threshold is read from the system's resting behaviour, not from
      // zero: 512 is the largest source that was already whole, so a regression
      // that starts dropping early fails here.
      const program = compile({
        deny: ['Bash(curl:*)'],
        allow: Array.from({ length: 511 }, (_, index) => `Bash(tool${index}:*)`),
      });
      expect(program.rules).toHaveLength(512);
      expect(program.droppedRules).toHaveLength(0);
      expect(program.diagnostics).toHaveLength(0);
      expect(program.invalidSource).toBeUndefined();
      expect(evaluatePermissionDslV1(program, control).action).toBeUndefined();
    });
  });
});

/**
 * P2.271 — the warning the contract promises has to REACH somebody.
 *
 * `managed-settings.md#keys-that-fail-closed`: "User, project, and local
 * settings files remain strict: a file whose JSON or top-level shape fails
 * validation is rejected as a whole and reported, and an individual entry that
 * fails, such as a malformed permission rule, is skipped with a warning while
 * the rest of the file applies."
 *
 * P2.270 shipped the skipping; `CompiledPermissionDslV1.diagnostics` was
 * written and read by nobody, so we had half that sentence — the silent half.
 * MEASURED on `4d4bd82a1` through the production path below: the compiler
 * produced one `unparseable-rule` diagnostic and the app's diagnostic stream
 * carried no trace of it.
 *
 * These tests run the REAL path — `parsePermissionsJson` →
 * `permissionsConfigCache.getMergedConfig` → `compilePermissionDslV1` — and read
 * the stream back, rather than handing a double a diagnostic and asserting the
 * double received it.
 */
describe('a skipped rule is announced, not silently subtracted', () => {
  let workspace = 0;

  /**
   * Build a merged config from a project settings block on the production path,
   * returning both the compiled program and everything `debug()` wrote while it
   * was built.
   */
  function build(block: Record<string, string[]>): { program: CompiledPermissionDslV1; reported: string } {
    enableDebug();
    const config = parsePermissionsJson(JSON.stringify({ permissions: block }), SETTINGS_ROOT);
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    };
    let program: CompiledPermissionDslV1 | undefined;
    try {
      permissionsConfigCache.clear();
      program = permissionsConfigCache.getMergedConfig({
        workspaceRootPath: `/nonexistent/ws-announce-${workspace++}`,
        pinnedRevision: 'gen',
        projectTrusted: true,
        pinnedConfigs: [{ config, scope: 'project' }],
      }).permissionDsl;
    } finally {
      (process.stderr as unknown as { write: unknown }).write = originalWrite;
    }
    return { program: program!, reported: captured.join('\n') };
  }

  it('names the rule, its action, the reason and the file it came from', () => {
    const { program, reported } = build({ deny: ['Read(C:\\Users\\alice\\.env)'], allow: ['Bash(ls:*)'] });
    // The drop still happened — this is the state the warning describes.
    expect(program.droppedRules.map(rule => rule.id)).toEqual(['claude-settings-deny-0']);
    // ...and it is now on the stream, with everything needed to repair it.
    expect(reported).toContain('unparseable-rule');
    expect(reported).toContain('claude-settings-deny-0');
    expect(reported).toContain('(deny)');
    expect(reported).toContain('invalid pathGlob pattern');
    expect(reported).toContain('skipped');
    // The SCOPE is what points at which settings file to edit; without it a
    // user with a workspace file, a project file and three plugins has to guess.
    expect(reported).toContain('dropped from project settings');
  });

  it('one warning EACH, not one aggregate — three malformed rules, three lines', () => {
    // "with a warning for each". An aggregated "your settings had problems"
    // leaves the second and third rules unrepairable, which is why this counts
    // LINES rather than asserting the ids appear somewhere in one blob.
    const { program, reported } = build({
      deny: ['Read(C:\\Users\\alice\\.env)', 'Cd(/a\\b)'],
      ask: ['Read(~//x)'],
      allow: ['Bash(ls:*)'],
    });
    expect(program.droppedRules.map(rule => rule.id))
      .toEqual(['claude-settings-deny-0', 'claude-settings-deny-1', 'claude-settings-ask-0']);
    const lines = reported.split('\n').filter(line => line.includes('Permission rule dropped from'));
    expect(lines).toHaveLength(3);
    expect(lines.filter(line => line.includes('claude-settings-deny-0'))).toHaveLength(1);
    expect(lines.filter(line => line.includes('claude-settings-deny-1'))).toHaveLength(1);
    expect(lines.filter(line => line.includes('claude-settings-ask-0'))).toHaveLength(1);
    // The surviving allow still decides: announcing must not cost enforcement.
    expect(evaluatePermissionDslV1(program, {
      generation: 'gen', cwd: '/work/repo', toolName: 'Bash', semanticId: 'bash', input: { command: 'ls -la' },
    }).action).toBe('allow');
  });

  it('a clean settings file says nothing — the rig proves it by also failing', () => {
    // An absence claim needs a positive control on the SAME rig, or a stream
    // that has silently stopped working reads exactly like a clean file.
    const clean = build({ deny: ['Bash(curl:*)'], allow: ['Bash(npm run *)'] });
    expect(clean.program.droppedRules).toHaveLength(0);
    expect(clean.program.diagnostics).toHaveLength(0);
    expect(clean.reported).not.toContain('Permission rule dropped from');
    expect(clean.reported).not.toContain('unparseable-rule');
    // Same rig, one character different: the warning appears.
    const broken = build({ deny: ['Bash(curl:*)', 'Read(C:\\Users\\alice\\.env)'], allow: ['Bash(npm run *)'] });
    expect(broken.reported).toContain('Permission rule dropped from project settings');
    expect(broken.reported).toContain('claude-settings-deny-1');
  });

  it('a DOCUMENT-level failure is announced too, under its own wording', () => {
    // A layer-level diagnostic has no rule and no scope to name — it is the
    // "rejected as a whole and reported" half of the same sentence — so it must
    // not borrow the per-rule wording and imply one repairable entry.
    //
    // P2.269 changed the CODE this reaches the stream under, not the shape: 513
    // deny rules is the layer-fatal residue of the rule cap, and it now arrives
    // naming the limit rather than as a bare "document is invalid". The
    // structural assertions are the point and they are unchanged.
    const { program, reported } = build({ deny: Array.from({ length: 513 }, (_, index) => `Read(/s${index}/**)`) });
    expect(program.invalidSource?.scope).toBe('project');
    expect(reported).toContain('Permission policy diagnostic (rule-cap)');
    expect(reported).toContain('512-rule compile limit');
    expect(reported).not.toContain('Permission rule dropped from');
  });

  it('the rule-cap OVERFLOW is announced per rule and names its scope', () => {
    // The other half of the cap: an overflow that the layer absorbs reports as
    // ordinary per-rule drops, so the user is told which grants they lost and
    // from which file — the discrimination the blanket collapse destroyed.
    const { program, reported } = build({
      deny: ['Bash(curl:*)'],
      allow: Array.from({ length: 513 }, (_, index) => `Bash(tool${index}:*)`),
    });
    expect(program.invalidSource).toBeUndefined();
    expect(program.droppedRules).toHaveLength(2);
    expect(reported).toContain('Permission rule dropped from project settings (rule-cap)');
    expect(reported).toContain('claude-settings-allow-512');
    expect(reported).toContain('at most 512');
  });
});

/**
 * P6.676 — an inert ALLOW rule reaches the one user-visible reader.
 *
 * `parseClaudeRuleString` returns an inert form as `{ warning }` with NO rule,
 * so it never enters the compiled program and can never appear in
 * `CompiledPermissionDslV1.diagnostics`. `permissionDslDiagnostics` — the field
 * `SessionManager.announcePermissionPolicyDiagnostics` turns into an
 * `info`/`warning` event, the only permissions channel that reaches a user with
 * no debug flag — was fed only by the compiler, so a user who wrote an allow
 * rule that can never match was told nothing at all, on every runtime.
 *
 * The reader needs no new i18n key: it renders
 * `chat.permissionPolicy.rulesDropped` from the COUNT and the SCOPES, and both
 * of these codes describe a rule that was genuinely dropped.
 */
describe('inert allow rules reach the user-visible diagnostics carrier', () => {
  let workspace = 0;

  function diagnose(block: Record<string, string[]>) {
    permissionsConfigCache.clear();
    return permissionsConfigCache.getMergedConfig({
      workspaceRootPath: `/nonexistent/ws-inert-${workspace++}`,
      pinnedRevision: 'gen',
      projectTrusted: true,
      pinnedConfigs: [{
        config: parsePermissionsJson(JSON.stringify({ permissions: block }), SETTINGS_ROOT),
        scope: 'project',
      }],
    }).permissionDslDiagnostics ?? [];
  }

  it('carries both allow-only codes with the scope that names the file to edit', () => {
    // `permissions.md` gives parameter rules to deny and ask only, and gives an
    // allow rule's tool-name glob a literal glob-free prefix. Both rules below
    // are therefore accepted and can never match.
    const diagnostics = diagnose({
      allow: ['Agent(isolation:*)', 'mcp__*'],
      deny: ['Bash(curl:*)'],
    });
    expect(diagnostics.map(diagnostic => diagnostic.code).sort()).toEqual([
      'claude_rule.param_allow_inert',
      'claude_rule.unanchored_allow_glob',
    ]);
    // The scope is the whole point: it says which of a user's several settings
    // files carries the rule that does nothing.
    expect(new Set(diagnostics.map(diagnostic => diagnostic.scope))).toEqual(new Set(['project']));
  });

  it('says nothing for an allow rule that CAN match — the negative control', () => {
    // Without this the assertion above would pass for a carrier that announces
    // every allow rule ever written.
    expect(diagnose({ allow: ['Bash(npm run *)', 'mcp__linear__create_issue'], deny: ['Bash(curl:*)'] }))
      .toEqual([]);
  });

  it('announces the inert rule even when the document installs nothing else', () => {
    // The case that used to be invisible twice over: with no installable rule
    // there is no compiled layer, so the early return skipped the announcement
    // entirely and the user's only allow rule vanished in silence.
    const diagnostics = diagnose({ allow: ['mcp__*'] });
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(['claude_rule.unanchored_allow_glob']);
  });
});
