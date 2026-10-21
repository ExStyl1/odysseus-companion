import { describe, expect, it } from 'bun:test';
import type { RuntimeSkillHandle } from '../../../../capabilities/views.ts';
import {
  NESTOR_SKILL_FAILURE_PREFIX,
  buildNestorCloudSkillMetadata,
  formatNestorSkillContent,
  formatNestorSkillFailure,
  nestorSkillReference,
  restoreSkillResourcePaths,
  selectNestorCloudSkill,
} from '../skills.ts';

function skill(overrides: Partial<RuntimeSkillHandle> & Pick<RuntimeSkillHandle, 'key' | 'logicalName'>): RuntimeSkillHandle {
  return {
    description: `${overrides.logicalName} description`,
    selectedAsUnqualifiedAlias: false,
    resource: { pluginInstanceId: 'plugin://test/pack@1.0.0', relativePath: 'skills/x/SKILL.md', contentHash: 'a'.repeat(64) },
    ...overrides,
  };
}

describe('buildNestorCloudSkillMetadata', () => {
  it('advertises the reference the model must send back, sorted by key', () => {
    const metadata = buildNestorCloudSkillMetadata([
      skill({ key: 'skill::z::deploy', logicalName: 'deploy', directoryQualifier: 'apps/web' }),
      skill({ key: 'skill::a::review', logicalName: 'review', selectedAsUnqualifiedAlias: true }),
    ]);
    expect(metadata).toEqual([
      { name: 'review', description: 'review description' },
      { name: 'apps/web:deploy', description: 'deploy description' },
    ]);
  });

  it('falls back to the fully-qualified key when neither alias nor directory qualifier applies', () => {
    expect(nestorSkillReference(skill({ key: 'skill::project::deploy', logicalName: 'deploy' })))
      .toBe('skill::project::deploy');
  });

  it('omits skills the model may not invoke', () => {
    const metadata = buildNestorCloudSkillMetadata([
      skill({ key: 'a', logicalName: 'a', selectedAsUnqualifiedAlias: true, disableModelInvocation: true }),
      skill({ key: 'b', logicalName: 'b', selectedAsUnqualifiedAlias: true, overrideState: 'off' }),
      skill({ key: 'c', logicalName: 'c', selectedAsUnqualifiedAlias: true, overrideState: 'user-invocable-only' }),
      skill({ key: 'd', logicalName: 'd', selectedAsUnqualifiedAlias: true }),
    ]);
    expect(metadata).toEqual([{ name: 'd', description: 'd description' }]);
  });

  it('never emits an empty description — `SkillV1.Description` is validate:"required" and one bad item drops the WHOLE list', () => {
    const metadata = buildNestorCloudSkillMetadata([
      skill({ key: 'a', logicalName: 'a', selectedAsUnqualifiedAlias: true, description: '' }),
      skill({ key: 'b', logicalName: 'b', selectedAsUnqualifiedAlias: true, overrideState: 'name-only' }),
    ]);
    expect(metadata?.map(entry => entry.name)).toEqual(['a', 'b']);
    for (const entry of metadata ?? []) expect(entry.description.length).toBeGreaterThan(0);
    // `name-only` suppresses the author's description from the model.
    expect(metadata?.[1]?.description).not.toContain('b description');
  });

  it('states a `paths` constraint it cannot enforce, and bounds a runaway description', () => {
    const metadata = buildNestorCloudSkillMetadata([
      skill({ key: 'a', logicalName: 'a', selectedAsUnqualifiedAlias: true, paths: ['apps/**', '*.ts'] }),
      skill({ key: 'b', logicalName: 'b', selectedAsUnqualifiedAlias: true, description: `line\n${'x'.repeat(400)}` }),
    ]);
    expect(metadata?.[0]?.description).toBe('a description [only while working with apps/** *.ts]');
    // Flattened to one line and bounded — this payload rides EVERY message and
    // the gateway rejects a request over 500,000 bytes.
    expect(metadata?.[1]?.description).not.toContain('\n');
    expect(metadata?.[1]?.description.length).toBe(180);
    expect(metadata?.[1]?.description.endsWith('…')).toBe(true);
  });

  it('returns undefined when nothing is invocable', () => {
    expect(buildNestorCloudSkillMetadata([])).toBeUndefined();
    expect(buildNestorCloudSkillMetadata(undefined)).toBeUndefined();
    expect(buildNestorCloudSkillMetadata([skill({ key: 'a', logicalName: 'a', disableModelInvocation: true })]))
      .toBeUndefined();
  });
});

describe('selectNestorCloudSkill', () => {
  const skills = [
    skill({ key: 'skill::a::review', logicalName: 'review', selectedAsUnqualifiedAlias: true }),
    skill({ key: 'skill::z::deploy', logicalName: 'deploy', directoryQualifier: 'apps/web' }),
  ];

  it('resolves every form the advertised reference can take', () => {
    expect(selectNestorCloudSkill(skills, 'review')?.key).toBe('skill::a::review');
    expect(selectNestorCloudSkill(skills, 'skill::a::review')?.key).toBe('skill::a::review');
    expect(selectNestorCloudSkill(skills, 'apps/web:deploy')?.key).toBe('skill::z::deploy');
    expect(selectNestorCloudSkill(skills, 'skill::z::deploy')?.key).toBe('skill::z::deploy');
    expect(selectNestorCloudSkill(skills, '  review  ')?.key).toBe('skill::a::review');
  });

  it('refuses a skill the model may not invoke, and an unknown name', () => {
    expect(selectNestorCloudSkill(skills, 'deploy')).toBeUndefined();
    expect(selectNestorCloudSkill(skills, 'nope')).toBeUndefined();
    expect(selectNestorCloudSkill([skill({ key: 'a', logicalName: 'a', selectedAsUnqualifiedAlias: true, disableModelInvocation: true })], 'a'))
      .toBeUndefined();
    expect(selectNestorCloudSkill([skill({ key: 'b', logicalName: 'b', selectedAsUnqualifiedAlias: true, overrideState: 'user-invocable-only' })], 'b'))
      .toBeUndefined();
  });
});

describe('formatNestorSkillContent', () => {
  it('matches the reference connector envelope', () => {
    expect(formatNestorSkillContent({
      name: 'review',
      body: 'Do the review.',
      directory: '/skills/review',
      resources: ['checklist.md', 'rubric.md'],
    })).toBe([
      '<skill_content name="review">',
      'Do the review.',
      '',
      'Skill directory: /skills/review',
      '<skill_resources>',
      '  <file>checklist.md</file>',
      '  <file>rubric.md</file>',
      '</skill_resources>',
      '</skill_content>',
    ].join('\n'));
  });

  it('drops the resources block when there are none', () => {
    expect(formatNestorSkillContent({ name: 'review', body: 'B', directory: '/d' })).toBe(
      '<skill_content name="review">\nB\n\nSkill directory: /d\n</skill_content>',
    );
  });

  it('omits the directory line rather than writing an unknown path', () => {
    expect(formatNestorSkillContent({ name: 'review', body: 'B' })).toBe(
      '<skill_content name="review">\nB\n</skill_content>',
    );
  });

  it('states the author\'s disallowed tools the way `paths` is stated, since nothing here can enforce them', () => {
    expect(formatNestorSkillContent({
      name: 'review',
      body: 'B',
      directory: '/d',
      disallowedTools: ['Bash', 'Write'],
    })).toBe([
      '<skill_content name="review">',
      'B',
      '',
      'Skill directory: /d',
      '',
      'Disallowed tools (author restriction, not enforced remotely): Bash, Write',
      '</skill_content>',
    ].join('\n'));
    expect(formatNestorSkillContent({ name: 'review', body: 'B', disallowedTools: [] }))
      .not.toContain('Disallowed tools');
  });
});

describe('restoreSkillResourcePaths', () => {
  it('undoes the materializer\'s handle rewrite so the remote model can read the file it names', () => {
    // `runtime-skill-content.ts:1175` rewrites every supporting-file reference into
    // `skill-resource:<hex>`. That handle resolves through OUR capability runtime,
    // which the remote model has no vocabulary for — it has `read_file`. Put the
    // author's relative path back and the `Skill directory:` line makes it readable.
    const body = 'See skill-resource:abc123 and skill-resource:abc123 again, plus skill-resource:def456.';
    expect(restoreSkillResourcePaths(body, [
      { handle: 'skill-resource:abc123', relativePath: 'references/checklist.md' },
      { handle: 'skill-resource:def456', relativePath: 'scripts/run.sh' },
    ])).toBe('See references/checklist.md and references/checklist.md again, plus scripts/run.sh.');
  });

  it('leaves a pre-R17 handle that carries no relativePath alone, and tolerates no resources', () => {
    expect(restoreSkillResourcePaths('x skill-resource:abc', [{ handle: 'skill-resource:abc' }]))
      .toBe('x skill-resource:abc');
    expect(restoreSkillResourcePaths('x', undefined)).toBe('x');
  });
});

describe('formatNestorSkillFailure', () => {
  it('starts with the literal prefix the backend greps for', () => {
    // `codeagent/skills.go:59-61` — a tool result that does NOT start with this
    // marks the skill activated for the whole conversation, so a later successful
    // activation is replaced by "Skill content is already loaded" forever.
    expect(formatNestorSkillFailure('skill not found: nope'))
      .toBe('Skills registry has throw an error: skill not found: nope');
    expect(formatNestorSkillFailure('x').startsWith(NESTOR_SKILL_FAILURE_PREFIX)).toBe(true);
  });
});
