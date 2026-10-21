/**
 * Codex agent roles: our agent definitions expressed in codex's own
 * `[agents.<role>]` mechanism.
 *
 * Every expectation below is anchored to something measured rather than
 * inferred, because the format is only half-documented:
 *
 * - the SHAPE comes from the pinned `config-schema.json` (`rust-v0.147.0`),
 *   `AgentsToml.additionalProperties -> AgentRoleToml`;
 * - the ROLE FILE's contract comes from `core/src/config/agent_roles.rs`, whose
 *   messages are in the bundled `codex-app-server` verbatim and which the live
 *   probe reproduced on demand (blank `developer_instructions` ->
 *   `configWarning` "Ignoring malformed agent role definition: … cannot be
 *   blank"; `[agents.enabled]` -> "Invalid configuration; using defaults.",
 *   i.e. the ENTIRE file discarded).
 */
import { test, expect, describe } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEX_AGENT_ROLE_DIR,
  buildCodexAgentRoles,
  buildCodexConfigToml,
  formatCodexAgentRoleDropDiagnostics,
  formatCodexUnhonouredRoleToolGrantNotice,
  validateConfigAgainstSchema,
  writeCodexConfig,
  type CodexAgentRoleDescriptor,
  type CodexConfigOptions,
} from '../config-writer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

function descriptor(over: Partial<CodexAgentRoleDescriptor> = {}): CodexAgentRoleDescriptor {
  return {
    key: 'plugin:claude-security:scan-researcher',
    name: 'scan-researcher',
    selectedAsUnqualifiedAlias: true,
    description: 'Researches a security finding',
    systemPrompt: 'You research security findings.',
    ...over,
  };
}

function baseOpts(agents: readonly CodexAgentRoleDescriptor[]): CodexConfigOptions {
  return {
    codexHome: '/tmp/codex-home',
    model: MODEL,
    adapterPort: 54321,
    mode: 'default',
    agents,
  };
}

function roles(agents: readonly CodexAgentRoleDescriptor[], over: { sessionMode?: CodexConfigOptions['mode'] } = {}) {
  return buildCodexAgentRoles({
    codexHome: '/tmp/codex-home',
    sessionModel: MODEL,
    sessionMode: over.sessionMode ?? 'default',
    definitions: agents,
  });
}

describe('codex agent roles — the declaration', () => {
  test('a definition becomes an [agents.<role>] block pointing at a role file inside CODEX_HOME', () => {
    const toml = buildCodexConfigToml(baseOpts([descriptor()]));
    expect(toml).toContain('[agents.scan-researcher]');
    expect(toml).toContain('description = "Researches a security finding"');
    expect(toml).toContain(`config_file = "/tmp/codex-home/${CODEX_AGENT_ROLE_DIR}/scan-researcher.toml"`);
  });

  test('the role file carries the three keys agent_roles.rs refuses a role without', () => {
    const { roles: built } = roles([descriptor()]);
    expect(built).toHaveLength(1);
    // `must define a non-empty \`name\`` + `.developer_instructions cannot be blank`
    expect(built[0]!.configFileToml).toContain('name = "scan-researcher"');
    expect(built[0]!.configFileToml).toContain('developer_instructions = "You research security findings."');
    // `agent role \`<name>\` must define a description` — satisfied on the
    // config side, per AgentRoleToml.description's own "Required unless
    // supplied by the referenced agent role file".
    expect(built[0]!.description).toBe('Researches a security finding');
  });

  test('nickname_candidates is never emitted — it is optional and carries four further validations', () => {
    const { roles: built } = roles([descriptor()]);
    expect(built[0]!.configFileToml).not.toContain('nickname_candidates');
    expect(buildCodexConfigToml(baseOpts([descriptor()]))).not.toContain('nickname_candidates');
  });

  test('the role name follows the same rule Pi and the Claude SDK builder use', () => {
    const { roles: unqualified } = roles([descriptor({ selectedAsUnqualifiedAlias: true })]);
    expect(unqualified[0]!.roleName).toBe('scan-researcher');
    const { roles: qualified } = roles([descriptor({ selectedAsUnqualifiedAlias: false })]);
    // `key` sanitized to a bare TOML key / safe basename.
    expect(qualified[0]!.roleName).toBe('plugin_claude-security_scan-researcher');
  });

  test('a blank description falls back to the same string the other two runtimes substitute', () => {
    const { roles: built } = roles([descriptor({ description: '  ' })]);
    expect(built[0]!.description).toBe('Imported scan-researcher agent.');
  });

  test('effort maps through the reasoning-effort table already used for the session knob', () => {
    expect(roles([descriptor({ effort: 'high' })]).roles[0]!.configFileToml)
      .toContain('model_reasoning_effort = "high"');
    // P3.226 · `off` is codex's own `"none"` since that row; it read `"minimal"`
    // here for as long as the session knob did, which is exactly the coupling
    // this row's assertion exists to keep.
    expect(roles([descriptor({ effort: 'off' })]).roles[0]!.configFileToml)
      .toContain('model_reasoning_effort = "none"');
    expect(roles([descriptor()]).roles[0]!.configFileToml).not.toContain('model_reasoning_effort');
  });

  test('a session with no definitions writes no [agents] section at all', () => {
    const toml = buildCodexConfigToml({ ...baseOpts([]), agents: undefined });
    expect(toml).not.toContain('[agents');
  });
});

describe('codex agent roles — what is denied by omission, and named', () => {
  test('a declared tool grant denies the role: codex has no per-role tool policy, so declaring it would WIDEN', () => {
    for (const over of [{ tools: ['Read', 'Grep'] }, { disallowedTools: ['Bash'] }]) {
      const plan = roles([descriptor(over)]);
      expect(plan.roles).toHaveLength(0);
      expect(plan.diagnostics).toHaveLength(1);
      expect(plan.diagnostics[0]).toContain('plugin:claude-security:scan-researcher');
      expect(plan.diagnostics[0]).toContain('no per-role tool policy');
    }
  });

  test('a reserved [agents] key denies the role — the measured cost is the WHOLE config being discarded', () => {
    const plan = roles([descriptor({ name: 'enabled', selectedAsUnqualifiedAlias: true })]);
    expect(plan.roles).toHaveLength(0);
    expect(plan.diagnostics[0]).toContain('reserved [agents] key');
    expect(buildCodexConfigToml(baseOpts([descriptor({ name: 'enabled', selectedAsUnqualifiedAlias: true })])))
      .not.toContain('[agents.enabled]');
  });

  // P3.4 — the multi_agent feature toggle and the reserved-key denial are
  // independent and must coexist: writing `[features] multi_agent = true` does
  // not weaken the denial, and the denial does not suppress the toggle.
  test('[features] multi_agent = true is written and still denies a reserved [agents] key', () => {
    const denied = buildCodexConfigToml(baseOpts([descriptor({ name: 'enabled', selectedAsUnqualifiedAlias: true })]));
    // The reserved role is still discarded...
    expect(denied).not.toContain('[agents.enabled]');
    // ...and the feature toggle is still emitted, before any [agents] block.
    expect(denied).toContain('[features]');
    expect(denied).toContain('multi_agent = true');

    // With a VALID role, [features] precedes that role's [agents.<role>] table,
    // and the whole config validates against the release schema.
    const withRole = buildCodexConfigToml(baseOpts([descriptor()]));
    expect(withRole).toContain('multi_agent = true');
    expect(withRole.indexOf('[features]')).toBeLessThan(withRole.indexOf('[agents.scan-researcher]'));
    expect(() => validateConfigAgainstSchema(baseOpts([descriptor()]), SCHEMA)).not.toThrow();
  });

  test('two definitions that sanitize to one role name keep the first — a duplicate is a hard codex error', () => {
    const plan = roles([
      descriptor({ key: 'a/b', selectedAsUnqualifiedAlias: false }),
      descriptor({ key: 'a:b', selectedAsUnqualifiedAlias: false }),
    ]);
    expect(plan.roles.map(r => r.roleName)).toEqual(['a_b']);
    expect(plan.diagnostics[0]).toContain('already claims the codex role name "a_b"');
  });

  test('a permission mode stricter than the session denies the role; one at or above it does not', () => {
    const stricter = roles([descriptor({ permissionMode: 'plan' })], { sessionMode: 'acceptEdits' });
    expect(stricter.roles).toHaveLength(0);
    expect(stricter.diagnostics[0]).toContain('permission mode "plan"');

    const looser = roles([descriptor({ permissionMode: 'bypassPermissions' })], { sessionMode: 'acceptEdits' });
    expect(looser.roles).toHaveLength(1);
    expect(looser.diagnostics).toHaveLength(0);
  });

  test('a blank system prompt denies the role — codex refuses a blank developer_instructions', () => {
    const plan = roles([descriptor({ systemPrompt: '   \n  ' })]);
    expect(plan.roles).toHaveLength(0);
    expect(plan.diagnostics[0]).toContain('developer_instructions is blank');
  });

  test('a foreign model is reported and dropped; `inherit` and the session model are silent', () => {
    const foreign = roles([descriptor({ model: 'opus', effort: 'high' })]);
    expect(foreign.roles).toHaveLength(1);
    // `model_reasoning_effort` still rides; the pinning `model = ` does not.
    expect(foreign.roles[0]!.configFileToml).toContain('model_reasoning_effort = "high"');
    expect(foreign.roles[0]!.configFileToml).not.toMatch(/^model = /m);
    expect(foreign.diagnostics[0]).toContain('declares model "opus"');
    expect(foreign.diagnostics[0]).toContain(MODEL);

    expect(roles([descriptor({ model: 'inherit' })]).diagnostics).toHaveLength(0);
    expect(roles([descriptor({ model: MODEL })]).diagnostics).toHaveLength(0);
  });

  test('one unexpressible definition never costs the others', () => {
    const plan = roles([
      descriptor({ key: 'a', name: 'a', selectedAsUnqualifiedAlias: true, tools: ['Read'] }),
      descriptor({ key: 'b', name: 'b', selectedAsUnqualifiedAlias: true }),
    ]);
    expect(plan.roles.map(r => r.roleName)).toEqual(['b']);
  });
});

describe('codex agent roles — the TOML has to parse', () => {
  test('a multi-line prompt is escaped, not emitted raw: a bare newline is an unparseable config', () => {
    const prompt = 'line one\n\nline "two" with \\ and a \ttab';
    const { roles: built } = roles([descriptor({ systemPrompt: prompt })]);
    const line = built[0]!.configFileToml.split('\n').find(l => l.startsWith('developer_instructions'))!;
    expect(line).toBe('developer_instructions = "line one\\n\\nline \\"two\\" with \\\\ and a \\ttab"');
    // JSON and TOML basic strings share this escape vocabulary, so a round trip
    // is a real parse check rather than a restatement of the escaper.
    expect(JSON.parse(line.slice('developer_instructions = '.length))).toBe(prompt);
  });

  test('other control characters go out as \\uXXXX', () => {
    const bell = String.fromCharCode(0x07);
    const del = String.fromCharCode(0x7f);
    const { roles: built } = roles([descriptor({ systemPrompt: `a${bell}b${del}c` })]);
    expect(built[0]!.configFileToml).toContain('"a\\u0007b\\u007fc"');
  });
});

describe('codex agent roles — schema and disk', () => {
  test('validateConfigAgainstSchema checks the two AgentRoleToml keys and developer_instructions', () => {
    expect(() => validateConfigAgainstSchema(baseOpts([descriptor()]), SCHEMA)).not.toThrow();
    // Drift control: a schema whose AgentRoleToml lost `config_file` must fail.
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
    delete schema.definitions.AgentRoleToml.properties.config_file;
    const dir = mkdtempSync(join(tmpdir(), 'codex-schema-'));
    const path = join(dir, 'config-schema.json');
    try {
      writeFileSync(path, JSON.stringify(schema), 'utf8');
      expect(() => validateConfigAgainstSchema(baseOpts([descriptor()]), path))
        .toThrow(/AgentRoleToml has no property "config_file"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writeCodexConfig materializes every role file and reports the denials once', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const diagnostics: string[] = [];
    try {
      writeCodexConfig({
        ...baseOpts([descriptor(), descriptor({ key: 'x', name: 'x', tools: ['Read'] })]),
        codexHome: home,
        onDiagnostic: m => diagnostics.push(m),
      });
      const rolePath = join(home, CODEX_AGENT_ROLE_DIR, 'scan-researcher.toml');
      expect(existsSync(rolePath)).toBe(true);
      expect(readFileSync(rolePath, 'utf8')).toContain('developer_instructions = ');
      // `config_file must point to an existing file` — the declaration and the
      // file it names have to agree on disk, not just in the builder.
      const declared = readFileSync(join(home, 'config.toml'), 'utf8')
        .split('\n').find(l => l.startsWith('config_file'))!;
      expect(declared).toBe(`config_file = "${rolePath}"`);
      expect(existsSync(join(home, CODEX_AGENT_ROLE_DIR, 'x.toml'))).toBe(false);
      // Scoped to the ROLE family. `writeCodexConfig` drains four independent
      // diagnostic sources into one sink, and this case is about one of them:
      // counting the sink counted P2.384's egress line too, which is a different
      // claim about a different subsystem. The `x` role is the only denial here,
      // and it must still be reported exactly once.
      expect(diagnostics.filter(m => m.includes('agent role'))).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * P6.126 (MEASURE) — what codex does with a subagent role whose declared tools
 * cannot be honoured, ledger H5's codex cell (`—`, no claim ever made).
 *
 * ## The rig the row specified, run as one call
 *
 * Three definitions handed to `buildCodexAgentRoles` together:
 *   1. a tool list where NO name resolves to a real tool;
 *   2. a tool list where every name resolves;
 *   3. no `tools` field at all.
 *
 * ## The measurement
 *
 * (1) and (2) are denied IDENTICALLY, with the same sentence, and (3) is the
 * only one that becomes a role. Resolvability is not consulted because the deny
 * sits at the TYPE boundary — `if (descriptor.tools || descriptor.disallowedTools)`
 * runs ahead of every other check in the loop, and the format cannot carry a
 * tool list at all: `AgentRoleToml` in the pinned `config-schema.json` is
 * `additionalProperties: false` over `description`, `config_file` and
 * `nickname_candidates`.
 *
 * So codex satisfies H5 EARLIER and MORE STRICTLY than the capability asks. H5
 * wants a subagent refused at SPAWN when its tools all fail to resolve; on codex
 * a tool-declaring definition never becomes spawnable in the first place, so the
 * useless agent it exists to prevent cannot be launched — and the refusal is
 * named to the user by `formatCodexAgentRoleDropDiagnostics` rather than
 * happening silently.
 *
 * The cost of that strictness is stated rather than hidden and is the reason
 * (2) is in the rig at all: a definition whose tools ALL resolve is refused too.
 * That is a superset refusal, not the capability failing.
 *
 * ## The binary half, measured on the shipped `codex-app-server`
 *
 * A denied definition produces no `[agents.<role>]` table, and `spawn_agent`
 * against a name it has no table for fails by name: the shipped
 * `darwin-arm64/codex-app-server` (178 126 224 B, `rust-v0.148.0`) carries the
 * literal `unknown agent_type '` exactly once, with `spawn_agent` (28) and
 * `agent_type` (22) as the positive controls that the probe reads the file and
 * `nessy_not_a_real_symbol` (0) as the negative. That reading is recorded here
 * rather than re-run in this suite, for the reason
 * `codex-worktree-tier-absence.test.ts` states: the artefact is pinned and
 * byte-identical, and re-scanning 178 MB per run buys nothing.
 *
 * WHAT EACH TEST KILLS: the first dies if resolvability ever starts being
 * consulted — which would be a silent WIDENING, since a resolvable grant would
 * then produce a role codex cannot honour the grant for. The second dies if the
 * survivor stops reaching the written file, which is the control that the
 * instrument reads anything at all. The third dies if the denial stops being
 * named to the user, which is what separates "covered by a stricter mechanism"
 * from "silently dropped".
 */
describe('P6.126 · a tool-declaring role is refused before resolution, not after', () => {
  const UNRESOLVABLE = descriptor({
    key: 'unresolvable', name: 'unresolvable', selectedAsUnqualifiedAlias: true,
    tools: ['NoSuchTool', 'AlsoNotATool'],
  });
  const RESOLVABLE = descriptor({
    key: 'resolvable', name: 'resolvable', selectedAsUnqualifiedAlias: true,
    tools: ['Read', 'Grep'],
  });
  const NO_TOOLS = descriptor({
    key: 'no-tools', name: 'no-tools', selectedAsUnqualifiedAlias: true,
  });

  test('both tool-declaring definitions are denied with the SAME reason, resolvable or not', () => {
    const plan = roles([UNRESOLVABLE, RESOLVABLE, NO_TOOLS]);
    expect(plan.denied.map(entry => entry.key)).toEqual(['unresolvable', 'resolvable']);
    const reasons = new Set(plan.denied.map(entry => entry.reason));
    // ONE reason for both: the discriminator the capability assumes exists —
    // "did the tools resolve?" — is never reached on this runtime.
    expect(reasons.size).toBe(1);
    expect([...reasons][0]).toBe(
      'it declares a tool grant, and codex has no per-role tool policy to honour it with',
    );
    // The survivor is the one with no `tools` field, and it is the only one.
    expect(plan.roles.map(role => role.roleName)).toEqual(['no-tools']);
  });

  test('the survivor reaches the written config.toml — the control that the instrument reads', () => {
    const toml = buildCodexConfigToml(baseOpts([UNRESOLVABLE, RESOLVABLE, NO_TOOLS]));
    expect(toml).toContain('[agents.no-tools]');
    // And neither denied definition leaves a table behind for `spawn_agent` to
    // find, which is what makes `unknown agent_type '<key>'` the binary's answer.
    expect(toml).not.toContain('[agents.unresolvable]');
    expect(toml).not.toContain('[agents.resolvable]');
  });

  test('the user is told, by name, in one aggregated notice', () => {
    const notices = formatCodexAgentRoleDropDiagnostics(roles([UNRESOLVABLE, RESOLVABLE, NO_TOOLS]));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('2 agent definitions');
    expect(notices[0]).toContain('unresolvable');
    expect(notices[0]).toContain('resolvable');
    expect(notices[0]).not.toContain('no-tools (');
  });
});

/**
 * P6.485 — the bundled `reviewer` was not declared on codex at all, so
 * `/code-review` delegated to an unnamed agent with the parent's full tools.
 *
 * Owner decision 2026-09-05, Q17 option (b): declare the role and carry the
 * read-only obligation as PROSE. Option (a) — keep denying — was declined
 * because it preserved a restriction nobody was enforcing: the spawn already
 * happened with the parent's whole tool surface, only without a name. Option (c),
 * a `[permissions.<role>]` layer, cannot express it either — no member of the
 * `*PermissionToml` family carries a `Tool*` field.
 *
 * These cases pin the exception's NARROWNESS first. A general "declare tool-
 * granting roles anyway" would silently widen every user-authored definition,
 * which is the thing the deny is right about.
 */
describe('P6.485 · the reviewer role is declared despite a grant codex cannot honour', () => {
  const reviewer = (over: Partial<CodexAgentRoleDescriptor> = {}) => descriptor({
    key: 'builtin:reviewer',
    name: 'reviewer',
    description: 'Review changes for bugs, regressions, and missing verification.',
    systemPrompt: 'You are a reviewer agent. Focus on defects and test gaps.',
    tools: ['Read', 'Grep'],
    ...over,
  });

  test('declares it, and carries the obligation as prose ahead of its own prompt', () => {
    const plan = roles([reviewer()]);
    expect(plan.roles.map(role => role.roleName)).toEqual(['reviewer']);
    const toml = plan.roles[0]!.configFileToml;
    // The obligation is an INSTRUCTION to the model, not a note about our
    // plumbing, and it names the tools because the model is not told which it has.
    expect(toml).toContain('READ-ONLY OBLIGATION');
    expect(toml).toContain('apply_patch');
    // The definition's own prompt survives, after it.
    expect(toml).toContain('You are a reviewer agent.');
    expect(toml.indexOf('READ-ONLY OBLIGATION')).toBeLessThan(toml.indexOf('You are a reviewer agent.'));
  });

  test('says out loud that the grant was NOT honoured — on its own line, not the drop line', () => {
    const plan = roles([reviewer()]);
    expect(plan.unhonouredToolGrants).toEqual([{ key: 'builtin:reviewer', roleName: 'reviewer' }]);
    // The drop notice reports a LOSS and must stay silent here; this is a
    // WIDENING, and reporting it in the sentence a reader has learned means
    // "loss" is how the important half gets skimmed past.
    expect(formatCodexAgentRoleDropDiagnostics(plan)).toEqual([]);
    const [notice, ...rest] = formatCodexUnhonouredRoleToolGrantNotice(plan);
    expect(rest).toEqual([]);
    expect(notice).toContain('codex-agent-role-tool-grant-unhonoured:');
    expect(notice).toContain('reviewer');
    expect(notice).toContain('no per-role tool policy');
  });

  test('the exception is by NAME and nothing else — every other tool-granting role still denies', () => {
    for (const name of ['scan-researcher', 'reviewer-2', 'my-reviewer', 'planner', 'scout', 'worker']) {
      const plan = roles([descriptor({ name, tools: ['Read'] })]);
      expect(plan.roles).toHaveLength(0);
      expect(plan.denied).toHaveLength(1);
      expect(plan.unhonouredToolGrants).toEqual([]);
    }
  });

  test('a reviewer with NO grant is an ordinary role — no notice, no obligation', () => {
    // The control that keeps the notice honest: it must name a widening that
    // happened, not every role that shares a name.
    const plan = roles([reviewer({ tools: undefined })]);
    expect(plan.roles).toHaveLength(1);
    expect(plan.unhonouredToolGrants).toEqual([]);
    expect(plan.roles[0]!.configFileToml).not.toContain('READ-ONLY OBLIGATION');
  });

  test('every other deny still applies to it — the exception covers the tool grant alone', () => {
    // A blank prompt, a reserved key and an unscopeable permission mode are
    // unchanged: codex refuses the first outright, the second discards the WHOLE
    // config, and the third cannot be expressed per role.
    expect(roles([reviewer({ systemPrompt: '   ' })]).roles).toHaveLength(0);
    // A mode STRICTER than the session's is the unscopeable case: the clamp
    // leaves it below the session mode and codex cannot scope a mode to one role.
    expect(roles([reviewer({ permissionMode: 'plan' })], { sessionMode: 'default' }).roles)
      .toHaveLength(0);
  });

  test('the declaration reaches the written config.toml and the file still validates', () => {
    const toml = buildCodexConfigToml(baseOpts([reviewer()]));
    expect(toml).toContain('[agents.reviewer]');
    expect(() => validateConfigAgainstSchema(baseOpts([reviewer()]), SCHEMA)).not.toThrow();
  });
});

/**
 * P6.550 — a role's declared TIER, honoured on codex's own per-role layer.
 *
 * The precedence both arms rest on was read from the source at `rust-v0.148.0`
 * (`core/src/agent/role.rs`, `build_next_config`):
 * `let preserve_current_model = role_layer_toml.get("model").is_none();` — a role
 * layer carrying `model` overrides the global `[agents] default_subagent_model`
 * that `apply_requested_spawn_agent_model_overrides` applied a step earlier, and
 * a layer without it preserves that choice.
 */
describe('codex agent roles — the declared model tier', () => {
  const CHEAP = 'tgpt/qwen35-mini';

  function tiered(
    over: Partial<CodexAgentRoleDescriptor>,
    cheapSubagentModel?: string,
  ) {
    return buildCodexAgentRoles({
      codexHome: '/tmp/codex-home',
      sessionModel: MODEL,
      sessionMode: 'default',
      ...(cheapSubagentModel ? { cheapSubagentModel } : {}),
      definitions: [descriptor(over)],
    });
  }

  test('POSITIVE — the cheap tier gets its own model in its role layer', () => {
    const toml = tiered({ tier: 'small' }, CHEAP).roles[0]!.configFileToml;
    expect(toml).toContain(`model = "${CHEAP}"`);
  });

  test('a non-cheap tier PINS the session model, because the global default would move it', () => {
    // The half a reader misses: with a distinct cheap model the caller also
    // writes `[agents] default_subagent_model`, which moves every role together.
    // Without this key a `big` role runs cheap — the declaration inverted.
    for (const tier of ['medium', 'big'] as const) {
      const toml = tiered({ tier }, CHEAP).roles[0]!.configFileToml;
      expect(toml).toContain(`model = "${MODEL}"`);
    }
  });

  test('NEGATIVE — no distinct cheap model, no key, whatever the tier', () => {
    // One model on this connection means every tier resolves to it, so writing
    // the key would restate codex's own documented inherit-by-default.
    for (const tier of ['small', 'medium', 'big', undefined] as const) {
      expect(tiered(tier ? { tier } : {}).roles[0]!.configFileToml).not.toContain('model =');
      // Boundary: a "cheap" model equal to the session model says nothing either.
      expect(tiered(tier ? { tier } : {}, MODEL).roles[0]!.configFileToml).not.toContain('model =');
    }
  });

  test('an undeclared tier is silent even when a cheap model exists', () => {
    expect(tiered({}, CHEAP).roles[0]!.configFileToml).not.toContain('model =');
  });

  test('the whole config still validates, and the role layer keeps its other keys', () => {
    const opts = baseOpts([descriptor({ tier: 'small', effort: 'high' })]);
    const withCheap: CodexConfigOptions = { ...opts, defaultSubagentModel: CHEAP };
    expect(() => validateConfigAgainstSchema(withCheap, SCHEMA)).not.toThrow();
    const home = mkdtempSync(join(tmpdir(), 'p6550-'));
    try {
      writeCodexConfig({ ...withCheap, codexHome: home });
      const roleFile = readFileSync(
        join(home, CODEX_AGENT_ROLE_DIR, 'scan-researcher.toml'), 'utf8',
      );
      expect(roleFile).toContain(`model = "${CHEAP}"`);
      expect(roleFile).toContain('model_reasoning_effort =');
      expect(roleFile).toContain('developer_instructions =');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * P6.309 (4) — codex's own delegation off-switch, `[agents] enabled`.
 *
 * `AgentsToml.enabled` in the pinned `config-schema.json` is *"Whether
 * multi-agent tools are enabled. Defaults to true"*. The writer's `[agents]`
 * comment recorded why `true` is never written; nothing answered how an operator
 * turns delegation OFF, and this is that answer.
 *
 * The mechanism is proven here while its caller does not exist yet — the same
 * explicitly-inert shape `CodexConfigOptions.instructionExcludes` records — and
 * the option's own docblock carries why no host setting was minted for it.
 */
describe('codex agent roles — the delegation off-switch', () => {
  test('POSITIVE — an explicit `false` writes the key, FIRST among the bare [agents] keys', () => {
    const toml = buildCodexConfigToml({
      ...baseOpts([descriptor()]),
      subagentsEnabled: false,
      maxSubagentSpawnDepth: 2,
    });
    expect(toml).toContain('[agents]');
    expect(toml).toContain('enabled = false');
    // A bare assignment after the first `[agents.<role>]` header becomes
    // `agents.<role>.enabled`, which `AgentRoleToml` refuses outright.
    expect(toml.indexOf('enabled = false')).toBeLessThan(toml.indexOf('[agents.'));
    // And it must not land after `max_depth` either — order among bare keys is
    // free, but all of them precede the first role header.
    expect(toml.indexOf('enabled = false')).toBeLessThan(toml.indexOf('max_depth'));
  });

  test('NEGATIVE — `true` and `undefined` write nothing at all', () => {
    // `true` would restate codex's own default, and unlike `view_image` a flip
    // of THIS default would be loud rather than silent: every delegation stops
    // and the model says so.
    for (const subagentsEnabled of [true, undefined]) {
      const toml = buildCodexConfigToml({
        ...baseOpts([]),
        ...(subagentsEnabled === undefined ? {} : { subagentsEnabled }),
      });
      // Scoped to the table, because `[analytics] enabled = false` is a real
      // and unrelated key of this same file — a bare `enabled =` search would
      // have passed for the wrong reason.
      expect(toml).not.toContain('[agents]');
    }
  });

  test('the switch alone demands the table, and the schema guard covers the key', () => {
    const opts: CodexConfigOptions = { ...baseOpts([]), subagentsEnabled: false };
    expect(buildCodexConfigToml(opts)).toContain('[agents]');
    expect(() => validateConfigAgainstSchema(opts, SCHEMA)).not.toThrow();
  });
});
