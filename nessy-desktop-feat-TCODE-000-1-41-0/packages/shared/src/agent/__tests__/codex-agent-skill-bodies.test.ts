/**
 * P6.309 (1) — a codex role that names a skill gets the skill's BODY.
 *
 * Until this arm it got the name and nothing else. The machinery existed and was
 * claude-named (`materializeClaudeRuntimeAgentSkills` + `applyAgentSkills`), and
 * codex was simply not a caller: `codex-agent.ts` hands `writeCodexConfig` the
 * SAME descriptors the Claude backend hands the SDK, so prepending each skill's
 * blocks to the descriptor's `systemPrompt` before that hand-off gives codex the
 * same body — one implementation with two callers, not a second projection.
 *
 * ## The hazard W8-g raised against building this blind, and how it is answered
 *
 * `applyAgentSkills` also narrows `tools`/`disallowedTools` from a skill's own
 * `disallowed-tools` frontmatter, and codex has NO per-role tool policy. W8-g's
 * hand-off said building without deciding that would put a role on codex with
 * more tools than its skill declares and say nothing. The answer is to carry the
 * fields THROUGH rather than strip them: `buildCodexAgentRoles` already records
 * any descriptor carrying them as an unhonoured grant (P6.485) and
 * `formatCodexUnhonouredRoleToolGrantNotice` says so out loud. Stripping them
 * would widen the child's surface AND remove the sentence that admits it.
 *
 * WHAT EACH TEST KILLS:
 *  - the body arm dies if the prompt stops being replaced — the shipped state.
 *  - the pass-through arms are the POSITIVE CONTROLS: a descriptor with no skills
 *    and a session with no materialized view must come back untouched, or "the
 *    prompt changed" would be satisfied by a function that rewrites everything.
 *  - the refusal arm dies if a withheld agent starts reaching codex anyway.
 *  - the announcement arms die if a degradation goes silent — the whole reason
 *    R12's channel exists.
 *  - the tool-grant arm dies if someone "tidies" the fields away, which would
 *    silently disable P6.485's notice.
 *  - the call-site arm dies if `codex-agent.ts` stops feeding the result to
 *    `writeCodexConfig`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyRuntimeAgentSkillsToDescriptors } from '../claude-runtime-agents.ts';

type Descriptor = Parameters<typeof applyRuntimeAgentSkillsToDescriptors>[0]['definitions'];

const descriptor = (over: Record<string, unknown> = {}) => ({
  key: 'agent.auditor',
  name: 'auditor',
  description: 'audits',
  systemPrompt: 'You audit things.',
  definitionDigest: 'd1',
  ...over,
} as unknown as NonNullable<Descriptor>[number]);

const invocation = (over: Record<string, unknown> = {}) => ({
  key: 'skill.review',
  name: 'review',
  body: 'Run the review checklist.',
  supportingResources: [],
  sourceDigest: 'sd1',
  generation: 'g1',
  invocationDigest: 'id1',
  states: { resourceLoaded: true },
  restrictions: {},
  ...over,
} as never);

const skillsFor = (
  payloads: Record<string, unknown>,
  sessionModel = 'tgpt/qwen35-397b-a17b-fp8',
) => ({
  byAgentKey: new Map(Object.entries(payloads)),
  sessionModel,
} as never);

describe('P6.309 (1) · the skill body reaches the codex descriptor', () => {
  it('replaces the systemPrompt with the prompt+blocks join', () => {
    const [out] = applyRuntimeAgentSkillsToDescriptors({
      definitions: [descriptor({ skillKeys: ['skill.review'] })],
      skills: skillsFor({ 'agent.auditor': { invocations: [invocation()] } }),
    });
    expect(out!.systemPrompt).toContain('You audit things.');
    expect(out!.systemPrompt).not.toBe('You audit things.');
    expect(out!.systemPrompt).toContain('Run the review checklist.');
  });

  it('POSITIVE CONTROL — a descriptor with no skills comes back untouched', () => {
    const input = descriptor();
    const [out] = applyRuntimeAgentSkillsToDescriptors({
      definitions: [input],
      skills: skillsFor({}),
    });
    expect(out).toEqual(input);
  });

  it('POSITIVE CONTROL — no materialized view at all leaves every descriptor alone', () => {
    // This is the ordinary path when the runtime config is written before the
    // first turn pins a capability view, so it must be byte-identical.
    const input = [descriptor({ skillKeys: ['skill.review'] }), descriptor({ key: 'agent.b' })];
    expect(applyRuntimeAgentSkillsToDescriptors({ definitions: input, skills: undefined }))
      .toEqual(input);
  });

  it('returns an empty list for no definitions rather than throwing', () => {
    expect(applyRuntimeAgentSkillsToDescriptors({ definitions: undefined, skills: undefined }))
      .toEqual([]);
  });
});

describe('P6.309 (1) · degradations are announced, never silent', () => {
  it('says so when a declared skill did not materialize', () => {
    const said: string[] = [];
    applyRuntimeAgentSkillsToDescriptors({
      definitions: [descriptor({ skillKeys: ['skill.review'] })],
      skills: skillsFor({}),
      announce: message => said.push(message),
    });
    expect(said.join('\n')).toContain('declares 1 skill(s)');
    expect(said.join('\n')).toContain('the agent runs without them');
  });

  it('WITHHOLDS an agent whose payload refused, and says why', () => {
    const said: string[] = [];
    const out = applyRuntimeAgentSkillsToDescriptors({
      definitions: [descriptor({ skillKeys: ['skill.review'] }), descriptor({ key: 'agent.b' })],
      skills: skillsFor({
        'agent.auditor': { invocations: [], refusal: 'runtime-agent-skill-unavailable:skill.review' },
      }),
      announce: message => said.push(message),
    });
    expect(out.map(d => d.key)).toEqual(['agent.b']);
    expect(said.join('\n')).toContain('unavailable this turn: runtime-agent-skill-unavailable:skill.review');
  });

  it('refuses an agent whose skill demands a model this session does not run', () => {
    const said: string[] = [];
    const out = applyRuntimeAgentSkillsToDescriptors({
      definitions: [descriptor({ skillKeys: ['skill.review'] })],
      skills: skillsFor({
        'agent.auditor': { invocations: [invocation({ restrictions: { model: 'some-other-model' } })] },
      }),
      announce: message => said.push(message),
    });
    expect(out).toEqual([]);
    expect(said.join('\n')).toContain('runtime-agent-skill-model-unavailable:some-other-model');
  });
});

describe('P6.309 (1) · the tool grant is carried THROUGH, not stripped', () => {
  it('keeps the narrowed disallowedTools on the descriptor so P6.485 can name it', () => {
    // Stripping would hand the child a wider surface than its skill declares AND
    // remove the one sentence that admits codex cannot honour the grant.
    const [out] = applyRuntimeAgentSkillsToDescriptors({
      definitions: [descriptor({ skillKeys: ['skill.review'], tools: ['Read', 'Bash'] })],
      skills: skillsFor({
        'agent.auditor': {
          invocations: [invocation({ restrictions: { disallowedTools: ['Bash'] } })],
        },
      }),
    });
    expect(out!.tools).toBeDefined();
    expect(out!.disallowedTools).toBeDefined();
    expect(out!.disallowedTools).toContain('Bash');
  });
});

describe('P6.309 (1) · codex-agent actually feeds it to the writer', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

  it('materializes before writeCodexConfig and passes the result as `agents`', () => {
    const materialize = SOURCE.indexOf('const codexAgentDefinitions = await this.materializeCodexAgentSkills();');
    const write = SOURCE.indexOf('writeCodexConfig({');
    expect(materialize).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(materialize);
    expect(SOURCE).toContain('? { agents: codexAgentDefinitions }');
    // The raw descriptors must no longer reach the writer, or the body would be
    // materialized and then thrown away.
    expect(SOURCE).not.toContain('{ agents: this.config.piRuntimeAgentDefinitions }');
  });
});
