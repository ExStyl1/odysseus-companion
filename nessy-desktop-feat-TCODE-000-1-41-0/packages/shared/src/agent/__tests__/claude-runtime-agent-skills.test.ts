/**
 * R10 — a Claude subagent must carry the skills its definition declares.
 *
 * BEFORE (measured on this seam, and kept below as the first negative control):
 * `buildClaudeRuntimeAgents` produced `{description, prompt, disallowedTools}`
 * for a descriptor whose `skillKeys` named a real skill. The SDK's own `skills`
 * field was not passed, and nothing else carried the content either — the same
 * agent was simply weaker on this runtime than on Pi.
 *
 * The fix INLINES the bodies rather than passing `AgentDefinition.skills`, and
 * the refusal is the point of the row. `sdk.d.ts:65-67` calls that field an
 * "Array of skill names to preload into the agent context"; ours holds resolved
 * capability KEYS, so the SDK would resolve each name against ITS OWN
 * directories — and the only one a live session has is `.claude/skills` inside
 * the user's open repository, so a name match would substitute an arbitrary
 * unvetted file for our vetted skill, silently. Its preload also carries none of
 * our per-skill `disallowed-tools`, none of the model/agent compatibility checks
 * and none of the invocation budget.
 *
 * So the tests below prove two things together, and neither alone is enough:
 * the content ARRIVES, and every restriction that rode with it on Pi RIDES WITH
 * IT HERE. A version that inlined the bodies and dropped the restrictions would
 * be worse than doing nothing.
 *
 * The composition is a port of `SessionManager`'s child-session admission — the
 * one place that already composes skill content for a subagent. Where it
 * differs it is because a THROW is affordable there and fatal here: the CLI
 * parses the whole `agents` record through one `z.record(...)` whose `catch`
 * returns `[]`, so one bad skill would delete every agent we sent.
 */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { BUILTIN_AGENT_NAMES } from '../../agents/definitions.ts';
import {
  buildClaudeRuntimeAgents,
  buildClaudeRuntimeAgentOptions,
  materializeClaudeRuntimeAgentSkills,
  type ClaudeRuntimeAgentSkillInput,
} from '../claude-runtime-agents.ts';
import type { PiRuntimeAgentDefinitionDescriptor } from '../pi-harness/runtime-agent-definition.ts';
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import type { CapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts';
import type { RuntimeSkillHandle } from '../../capabilities/views.ts';
import {
  MAX_SKILL_INVOCATION_BYTES,
  formatRuntimeSkillInvocation,
  materializeRuntimeSkillInvocation,
  parseSkillToolEntry,
} from '../../capabilities/runtime-skill-content.ts';

const SESSION_MODEL = 'claude-fable-5';

function skillHandle(name: string): RuntimeSkillHandle {
  return {
    key: `skill:native:${name}`,
    logicalName: name,
    description: `the ${name} skill`,
    selectedAsUnqualifiedAlias: true,
    resource: {
      source: 'managed-global',
      scope: { kind: 'global' },
      resourceId: `skill:native:${name}`,
      absolutePath: `/skills/${name}/SKILL.md`,
      revision: '1',
      contentHash: createHash('sha256').update(name).digest('hex'),
    },
  };
}

/** Serves each skill's SKILL.md by its resourceId, so one rig holds several. */
function materializer(bodies: Record<string, string>): CapabilitySnapshotMaterializer {
  return {
    assertActive() {},
    async verifyPlugin() {},
    async resolvePath(resource) {
      return `/skills/${(resource as { resourceId: string }).resourceId}/SKILL.md`;
    },
    async resolveSkillDirectory(resource) {
      return `/skills/${(resource as { resourceId: string }).resourceId}`;
    },
    async readText(resource) {
      const id = (resource as { resourceId: string }).resourceId;
      const body = bodies[id];
      if (body === undefined) throw new Error(`no fixture for ${id}`);
      return body;
    },
    resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
  };
}

function descriptor(
  overrides: Partial<PiRuntimeAgentDefinitionDescriptor> & { key: string; name: string },
): PiRuntimeAgentDefinitionDescriptor {
  return {
    schemaVersion: 2,
    description: 'reviews code',
    selectedAsUnqualifiedAlias: true,
    systemPrompt: 'You are an auditor.',
    sha256: 'deadbeef',
    provenance: `${overrides.key}@gen-1`,
    capabilityGeneration: 'gen-1',
    definitionDigest: 'digest-1',
    ...overrides,
  };
}

/** The whole composition, end to end, the way a wired turn would run it. */
async function compose(input: {
  definitions: readonly PiRuntimeAgentDefinitionDescriptor[];
  bodies: Record<string, string>;
  skills?: readonly RuntimeSkillHandle[];
  sessionModel?: string;
}): Promise<{ skills: ClaudeRuntimeAgentSkillInput; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const skills = await materializeClaudeRuntimeAgentSkills({
    definitions: input.definitions,
    materializer: materializer(input.bodies),
    skills: input.skills ?? Object.keys(input.bodies).map(id => skillHandle(id.replace('skill:native:', ''))),
    generation: 'gen-1',
    sessionModel: input.sessionModel ?? SESSION_MODEL,
    onDiagnostic: message => diagnostics.push(message),
  });
  return { skills, diagnostics };
}

const HOUSE_STYLE = 'skill:native:house-style';
const HOUSE_STYLE_BODY = '---\ndescription: house style\n---\nAlways use tabs.';

/**
 * P3.277 — `buildClaudeRuntimeAgents` now seeds the bundled four. These suites
 * are about the DESCRIPTORS, so they filter the bundled names out rather than
 * restating them in every key assertion.
 */
const BUNDLED_AGENT_NAMES = new Set<string>(BUILTIN_AGENT_NAMES);

describe('R10 — the before-state, kept as the discriminating control', () => {
  /**
   * The FIRST negative control the evidence rule asks for: it proves the
   * assertions below can distinguish present from absent, because the identical
   * assertions fail on the identical descriptor when nothing is inlined.
   */
  it('carries no skill content when the descriptor declares none', async () => {
    const definitions = [descriptor({ key: 'agent.plain', name: 'plain' })];
    const { skills } = await compose({ definitions, bodies: { [HOUSE_STYLE]: HOUSE_STYLE_BODY } });

    const agents = buildClaudeRuntimeAgents(definitions, undefined, skills);

    expect(agents.plain!.prompt).toBe('You are an auditor.');
    expect(agents.plain!.prompt).not.toContain('<invoked-skill');
    expect(skills.byAgentKey.size).toBe(0);
  });

  it('carried none either when the descriptor DID declare one — the shipped defect', () => {
    // No `skills` argument at all: byte-identical to the seam before this row.
    const agents = buildClaudeRuntimeAgents([descriptor({
      key: 'agent.auditor',
      name: 'auditor',
      skillKeys: [HOUSE_STYLE],
      disallowedTools: ['WebSearch'],
    })]);

    expect(agents.auditor!.prompt).toBe('You are an auditor.');
    expect(agents.auditor!.prompt).not.toContain('Always use tabs.');
    // POSITIVE CONTROL on the same rig: a field that IS translated arrives.
    expect(agents.auditor!.disallowedTools).toEqual(['WebSearch']);
  });
});

describe('R10 — the skill bodies are inlined', () => {
  it('appends one <invoked-skill> block per declared skill, in declaration order', async () => {
    const definitions = [descriptor({
      key: 'agent.auditor',
      name: 'auditor',
      skillKeys: [HOUSE_STYLE, 'skill:native:security'],
    })];
    const { skills } = await compose({
      definitions,
      bodies: {
        [HOUSE_STYLE]: HOUSE_STYLE_BODY,
        'skill:native:security': '---\ndescription: security\n---\nNever log secrets.',
      },
    });

    const prompt = buildClaudeRuntimeAgents(definitions, undefined, skills).auditor!.prompt;

    expect(prompt).toContain('Always use tabs.');
    expect(prompt).toContain('Never log secrets.');
    expect(prompt.indexOf('Always use tabs.')).toBeLessThan(prompt.indexOf('Never log secrets.'));
    expect(prompt.startsWith('You are an auditor.\n\n')).toBe(true);
  });

  /**
   * The row's acceptance criterion, asserted against the SAME renderer Pi's
   * child-session admission calls rather than against a string this test
   * spells for itself — a hand-written expectation would go on passing after a
   * change to the block format that made the two runtimes disagree.
   */
  it('produces byte-identically what the Pi child-session path produces', async () => {
    const definitions = [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: [HOUSE_STYLE] })];
    const bodies = { [HOUSE_STYLE]: HOUSE_STYLE_BODY };
    const { skills } = await compose({ definitions, bodies });

    const piInvocation = await materializeRuntimeSkillInvocation({
      materializer: materializer(bodies),
      skill: skillHandle('house-style'),
      generation: 'gen-1',
    });
    const piPrompt = ['You are an auditor.', formatRuntimeSkillInvocation(piInvocation)].join('\n\n');

    expect(buildClaudeRuntimeAgents(definitions, undefined, skills).auditor!.prompt).toBe(piPrompt);
  });

  it('never sets the SDK skills field — the refusal this row is built on', async () => {
    const definitions = [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: [HOUSE_STYLE] })];
    const { skills } = await compose({ definitions, bodies: { [HOUSE_STYLE]: HOUSE_STYLE_BODY } });

    const agent = buildClaudeRuntimeAgents(definitions, undefined, skills).auditor!;

    expect(agent).not.toHaveProperty('skills');
    expect(agent).not.toHaveProperty('mcpServers');
  });

  it('reaches the turn through the seam claude-agent.ts actually calls', async () => {
    const definitions = [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: [HOUSE_STYLE] })];
    const { skills } = await compose({ definitions, bodies: { [HOUSE_STYLE]: HOUSE_STYLE_BODY } });

    const wired = buildClaudeRuntimeAgentOptions({ definitions, mini: false, skills });
    expect(wired.agents!.auditor!.prompt).toContain('Always use tabs.');

    // The mini branch still withholds every agent, skills included.
    expect(buildClaudeRuntimeAgentOptions({ definitions, mini: true, skills })).toEqual({});
  });
});

describe('R10 — the restrictions ride along', () => {
  const DENY_BASH = '---\ndescription: styled\ndisallowed-tools: Bash\n---\nAlways use tabs.';

  it("removes a skill's disallowed-tools from a declared tool grant", async () => {
    const definitions = [descriptor({
      key: 'agent.auditor',
      name: 'auditor',
      tools: ['Read', 'Bash', 'Grep'],
      skillKeys: [HOUSE_STYLE],
    })];
    const { skills } = await compose({ definitions, bodies: { [HOUSE_STYLE]: DENY_BASH } });

    const agent = buildClaudeRuntimeAgents(definitions, undefined, skills).auditor!;

    expect(agent.tools).toEqual(['Read', 'Grep']);
    expect(agent.disallowedTools).toEqual(['Bash']);
  });

  /**
   * The case the SDK field could never have covered and the tool filter alone
   * does not either: `tools` omitted means "inherits all tools from parent"
   * (`sdk.d.ts:44`), so the removal has to be stated as a denial or it does not
   * exist.
   *
   * P2.327 — THIS is that row's whole question, and the page answers it in the
   * runtime's own words rather than leaving it to a host invention.
   * `sub-agents.md#available-tools`: *"This example uses `disallowedTools` to
   * inherit the subagent's tool pool except Write and Edit. The subagent keeps
   * Bash, MCP tools, and the rest of its pool"*, and the frontmatter table's own
   * row: *"`disallowedTools` | No | Tools to deny, removed from inherited or
   * specified list"*. So "everything except X" for a ceiling-less child is a
   * SUBTRACTION on a documented field, never an enumerated allowlist — which is
   * exactly why P2.301 was right to refuse enumerating the parent pool, and why
   * Pi's `PiChildRestrictionsV1.skillDisallowedTools` is the same shape rather
   * than a second mechanism.
   */
  it('states the removal as a denial when the agent declares no tool list', async () => {
    const definitions = [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: [HOUSE_STYLE] })];
    const { skills } = await compose({ definitions, bodies: { [HOUSE_STYLE]: DENY_BASH } });

    const agent = buildClaudeRuntimeAgents(definitions, undefined, skills).auditor!;

    expect(agent.tools).toBeUndefined();
    expect(agent.disallowedTools).toEqual(['Bash']);
  });

  /**
   * P2.327 — the documented PRECEDENCE, and the proof we do not re-implement it.
   *
   * `sub-agents.md#available-tools`: *"If both are set, `disallowedTools` is
   * applied first, then `tools` is resolved against the remaining pool. A tool
   * listed in both is removed."* The author's OWN denial is forwarded beside
   * their own grant, untouched — the runtime owns that resolution and a host
   * that pre-resolved it would be a second copy of a rule the SDK already has,
   * free to drift. The skill-derived denial is filtered out of `tools` (the case
   * above) only because the SKILL's names must survive a `tools` list the author
   * wrote without knowing about them.
   */
  it("forwards the author's own denial beside their own grant, letting the runtime resolve the overlap", async () => {
    const definitions = [descriptor({
      key: 'agent.auditor',
      name: 'auditor',
      tools: ['Read', 'Bash'],
      disallowedTools: ['Bash'],
    })];

    const agent = buildClaudeRuntimeAgents(definitions).auditor!;

    // Both fields cross verbatim; `Bash` is NOT pre-subtracted here.
    expect(agent.tools).toEqual(['Read', 'Bash']);
    expect(agent.disallowedTools).toEqual(['Bash']);
  });

  it("unions the skill's denial with the agent author's own, without duplicating", async () => {
    const definitions = [descriptor({
      key: 'agent.auditor',
      name: 'auditor',
      disallowedTools: ['WebSearch', 'Bash'],
      skillKeys: [HOUSE_STYLE],
    })];
    const { skills } = await compose({ definitions, bodies: { [HOUSE_STYLE]: DENY_BASH } });

    expect(buildClaudeRuntimeAgents(definitions, undefined, skills).auditor!.disallowedTools)
      .toEqual(['WebSearch', 'Bash']);
  });

  /**
   * `parseSkillToolEntry` canonicalizes through `canonicalTool`, which lowercases
   * AND maps Claude's spellings onto Pi's. That is right for matching our own two
   * lists against each other and wrong for the value handed to the SDK, which
   * knows only its own spellings — `web_search` in `disallowedTools` would deny
   * nothing while reading as enforced. This pins the split.
   */
  it("hands the SDK the author's spelling while matching on the canonical one", async () => {
    expect(parseSkillToolEntry('WebSearch').name).toBe('web_search');
    const definitions = [descriptor({
      key: 'agent.auditor',
      name: 'auditor',
      tools: ['Read', 'WebSearch'],
      skillKeys: [HOUSE_STYLE],
    })];
    const { skills } = await compose({
      definitions,
      bodies: { [HOUSE_STYLE]: '---\ndescription: s\ndisallowed-tools: WebSearch(https://*)\n---\nAlways use tabs.' },
    });

    const agent = buildClaudeRuntimeAgents(definitions, undefined, skills).auditor!;

    // Matched canonically, so the grant really lost it …
    expect(agent.tools).toEqual(['Read']);
    // … and the SDK is told in the spelling it knows, with the parameterization
    // dropped — `sdk.d.ts:48` is an "Array of tool names to explicitly disallow
    // for this agent", and `web_search` is not one of the SDK's names.
    expect(agent.disallowedTools).toEqual(['WebSearch']);
  });

  it("refuses the agent when a skill's model ceiling cannot be met", async () => {
    const definitions = [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: [HOUSE_STYLE] })];
    const { skills } = await compose({
      definitions,
      bodies: { [HOUSE_STYLE]: '---\ndescription: s\nmodel: opus\n---\nAlways use tabs.' },
    });
    const diagnostics: string[] = [];

    const agents = buildClaudeRuntimeAgents(definitions, undefined, {
      ...skills,
      onDiagnostic: message => diagnostics.push(message),
    });

    expect(agents.auditor).toBeUndefined();
    expect(diagnostics.join('\n')).toContain('runtime-agent-skill-model-unavailable:opus');
  });

  it('accepts the ceiling the session can meet, and the inherit keyword', async () => {
    for (const declared of [SESSION_MODEL, 'inherit']) {
      const definitions = [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: [HOUSE_STYLE] })];
      const { skills } = await compose({
        definitions,
        bodies: { [HOUSE_STYLE]: `---\ndescription: s\nmodel: ${declared}\n---\nAlways use tabs.` },
      });

      expect(buildClaudeRuntimeAgents(definitions, undefined, skills).auditor!.prompt)
        .toContain('Always use tabs.');
    }
  });

  /**
   * The ceiling is compared against the model the agent will ACTUALLY run, not
   * against the one it declares: on a gateway connection a declared alias the
   * upstream cannot serve is substituted for the session model, and a skill
   * pinned to that session model must still pass.
   */
  it('compares against the substituted model on a gateway connection', async () => {
    const definitions = [descriptor({
      key: 'agent.auditor',
      name: 'auditor',
      model: 'opus',
      skillKeys: [HOUSE_STYLE],
    })];
    const { skills } = await compose({
      definitions,
      bodies: { [HOUSE_STYLE]: `---\ndescription: s\nmodel: ${SESSION_MODEL}\n---\nAlways use tabs.` },
    });

    const agents = buildClaudeRuntimeAgents(definitions, {
      servedModels: [SESSION_MODEL],
      sessionModel: SESSION_MODEL,
      onDiagnostic: () => {},
    }, skills);

    expect(agents.auditor!.model).toBeUndefined();
    expect(agents.auditor!.prompt).toContain('Always use tabs.');
  });

  it("refuses the agent when a skill's agent ceiling names someone else", async () => {
    const definitions = [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: [HOUSE_STYLE] })];
    const { skills } = await compose({
      definitions,
      bodies: { [HOUSE_STYLE]: '---\ndescription: s\nagent: someone-else\n---\nAlways use tabs.' },
    });
    const diagnostics: string[] = [];

    const agents = buildClaudeRuntimeAgents(definitions, undefined, {
      ...skills,
      onDiagnostic: message => diagnostics.push(message),
    });

    expect(agents.auditor).toBeUndefined();
    expect(diagnostics.join('\n')).toContain('runtime-agent-skill-agent-unavailable:someone-else');
  });

  it('accepts the agent ceiling naming this agent by key or by name', async () => {
    for (const declared of ['agent.auditor', 'auditor', 'inherit']) {
      const definitions = [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: [HOUSE_STYLE] })];
      const { skills } = await compose({
        definitions,
        bodies: { [HOUSE_STYLE]: `---\ndescription: s\nagent: ${declared}\n---\nAlways use tabs.` },
      });

      expect(buildClaudeRuntimeAgents(definitions, undefined, skills).auditor!.prompt)
        .toContain('Always use tabs.');
    }
  });

  it('refuses the agent when one skill body blows its own cap', async () => {
    const definitions = [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: [HOUSE_STYLE] })];
    const { skills } = await compose({
      definitions,
      bodies: { [HOUSE_STYLE]: `---\ndescription: s\n---\n${'x'.repeat(MAX_SKILL_INVOCATION_BYTES)}` },
    });
    const diagnostics: string[] = [];

    const agents = buildClaudeRuntimeAgents(definitions, undefined, {
      ...skills,
      onDiagnostic: message => diagnostics.push(message),
    });

    expect(agents.auditor).toBeUndefined();
    expect(diagnostics.join('\n')).toContain('Skill body exceeds');
  });

  /**
   * The AGGREGATE budget — `assertSkillInvocationBudget` over the whole set,
   * the call `SessionManager` makes once per child. Each body below is legal on
   * its own, so nothing but the sum can refuse this agent.
   */
  it('refuses the agent when the combined invocation budget is exceeded', async () => {
    const keys = ['a', 'b', 'c', 'd', 'e'].map(name => `skill:native:big-${name}`);
    const bodies = Object.fromEntries(keys.map(key =>
      [key, `---\ndescription: s\n---\n${'x'.repeat(250_000)}`]));
    const definitions = [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: keys })];
    const { skills } = await compose({ definitions, bodies });
    const diagnostics: string[] = [];

    const agents = buildClaudeRuntimeAgents(definitions, undefined, {
      ...skills,
      onDiagnostic: message => diagnostics.push(message),
    });

    expect(agents.auditor).toBeUndefined();
    expect(diagnostics.join('\n')).toContain(`Skill invocation snapshot exceeds ${MAX_SKILL_INVOCATION_BYTES} bytes`);
  });

  /**
   * REGRESSION. This case was first written the other way round — the agent was
   * REFUSED when a skill emptied its declared grant — and that was an overshoot
   * caught in review: it withheld, on Claude only, an agent both runtimes admit.
   *
   * Claude launches it. `errors.md` § *Agent would be spawned with zero tools*,
   * fetched raw 2026-08-16, the sentence after the one the refusal was built on:
   * "Omitting the `tools` field never triggers this refusal. If you leave the
   * `tools` list empty, or `disallowedTools` removes every entry in it, Claude
   * Code also skips the refusal and launches the subagent without tools."
   *
   * Pi admits it too: its "empty intersection" throw is upstream of the skill's
   * `disallowed-tools` removal and cannot be reached by one, and the removal
   * runs after it with no refusal behind it.
   *
   * A toolless subagent can still reason and return text. Refusing would have
   * made the model unable to delegate to it at all — the opposite of the row.
   */
  it('admits the agent with an empty grant when the removal empties it — both runtimes do', async () => {
    const definitions = [descriptor({
      key: 'agent.auditor',
      name: 'auditor',
      tools: ['Bash'],
      skillKeys: [HOUSE_STYLE],
    })];
    const { skills } = await compose({ definitions, bodies: { [HOUSE_STYLE]: DENY_BASH } });
    const diagnostics: string[] = [];

    const agents = buildClaudeRuntimeAgents(definitions, undefined, {
      ...skills,
      onDiagnostic: message => diagnostics.push(message),
    });

    expect(agents.auditor).toBeDefined();
    expect(agents.auditor?.tools).toEqual([]);
    // The skill's removal is still enforced, and still recorded on the SDK's own
    // field — an empty grant is not a reason to stop denying.
    expect(agents.auditor?.disallowedTools).toContain('Bash');
    // The skill content rode along, which is the row's whole point.
    expect(agents.auditor?.prompt).toContain('<invoked-skill');
    // No refusal was announced, because nothing was refused.
    expect(diagnostics.join('\n')).not.toContain('runtime-agent-skill-tools-empty');
  });

  it('refuses the agent when a declared skill key is not in the pinned view', async () => {
    const definitions = [descriptor({
      key: 'agent.auditor',
      name: 'auditor',
      skillKeys: ['skill:native:ghost'],
    })];
    const { skills } = await compose({ definitions, bodies: { [HOUSE_STYLE]: HOUSE_STYLE_BODY } });
    const diagnostics: string[] = [];

    const agents = buildClaudeRuntimeAgents(definitions, undefined, {
      ...skills,
      onDiagnostic: message => diagnostics.push(message),
    });

    expect(agents.auditor).toBeUndefined();
    expect(diagnostics.join('\n')).toContain('runtime-agent-skill-unavailable:skill:native:ghost');
  });
});

describe('R10 — one bad agent must not delete the others', () => {
  /**
   * The single most important difference from the Pi path this ports. Pi THROWS
   * and the throw costs one spawn; here the CLI parses the whole `agents` record
   * through one `z.record(...)` inside a `try` whose `catch` returns `[]`, so a
   * throw would delete EVERY agent and say nothing. Measured against the same
   * rig that produces the refusal, so this is not a vacuous pass.
   */
  it('withholds only the refused agent and keeps its neighbours', async () => {
    const definitions = [
      descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: ['skill:native:pinned'] }),
      descriptor({ key: 'agent.probe', name: 'probe', skillKeys: [HOUSE_STYLE] }),
      descriptor({ key: 'agent.plain', name: 'plain' }),
    ];
    const { skills } = await compose({
      definitions,
      bodies: {
        'skill:native:pinned': '---\ndescription: s\nmodel: opus\n---\nPinned.',
        [HOUSE_STYLE]: HOUSE_STYLE_BODY,
      },
    });

    const agents = buildClaudeRuntimeAgents(definitions, undefined, skills);

    expect(Object.keys(agents).filter(key => !BUNDLED_AGENT_NAMES.has(key)).sort())
      .toEqual(['plain', 'probe']);
    expect(agents.probe!.prompt).toContain('Always use tabs.');
  });

  it('scopes a materialization failure to its own agent', async () => {
    const definitions = [
      descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: ['skill:native:broken'] }),
      descriptor({ key: 'agent.probe', name: 'probe', skillKeys: [HOUSE_STYLE] }),
    ];
    // The handle is in the pinned view, so selection succeeds; reading it fails.
    const skills = await materializeClaudeRuntimeAgentSkills({
      definitions,
      materializer: materializer({ [HOUSE_STYLE]: HOUSE_STYLE_BODY }),
      skills: [skillHandle('broken'), skillHandle('house-style')],
      generation: 'gen-1',
      sessionModel: SESSION_MODEL,
    });

    expect(skills.byAgentKey.get('agent.auditor')!.refusal).toContain('no fixture for');
    expect(Object.keys(buildClaudeRuntimeAgents(definitions, undefined, skills))
      .filter(key => !BUNDLED_AGENT_NAMES.has(key))).toEqual(['probe']);
  });
});

describe('R10 — the un-materialized state is announced, never silent', () => {
  it('says so when a skill-declaring agent is built without materialized skills', () => {
    const diagnostics: string[] = [];

    const agents = buildClaudeRuntimeAgents(
      [descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: [HOUSE_STYLE, 'skill:native:security'] })],
      { sessionModel: SESSION_MODEL, onDiagnostic: message => diagnostics.push(message) },
    );

    // The agent still runs — withholding every skill-bearing agent would be a
    // regression, not a fix — but the degradation is on the record.
    expect(agents.auditor).toBeDefined();
    expect(diagnostics).toEqual([
      'Imported agent agent.auditor declares 2 skill(s), which this turn did not materialize; '
      + 'the agent runs without them',
    ]);
  });

  it('stays quiet for an agent that declares no skills', () => {
    const diagnostics: string[] = [];

    buildClaudeRuntimeAgents(
      [descriptor({ key: 'agent.plain', name: 'plain' })],
      { sessionModel: SESSION_MODEL, onDiagnostic: message => diagnostics.push(message) },
    );

    expect(diagnostics).toEqual([]);
  });
});
