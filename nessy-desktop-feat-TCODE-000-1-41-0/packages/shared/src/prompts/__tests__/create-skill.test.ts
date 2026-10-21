import { describe, expect, it } from 'bun:test';

import {
  CREATE_SKILL_CREATOR_SKILL_NAME,
  CREATE_SKILL_PROMPT,
  CREATE_SKILL_SKILLS_ROOT,
} from '../create-skill.ts';

describe('create-skill macro prompt', () => {
  it('matches the creator prompt snapshot', () => {
    // Snapshot the load-bearing macro contract: interview-first, our SKILL.md
    // schema + skills root, and the skill_validate step.
    expect(CREATE_SKILL_PROMPT).toMatchSnapshot();
  });

  it('drives the bundled skill-creator skill', () => {
    expect(CREATE_SKILL_CREATOR_SKILL_NAME).toBe('skill-creator');
    expect(CREATE_SKILL_PROMPT).toContain('skill-creator');
  });

  it('targets our skill schema and paths', () => {
    expect(CREATE_SKILL_SKILLS_ROOT).toBe('~/.nessy-agent/skills/');
    expect(CREATE_SKILL_PROMPT).toContain('~/.nessy-agent/skills/');
    expect(CREATE_SKILL_PROMPT).toContain('SKILL.md');
    // YAML frontmatter with the two required fields.
    expect(CREATE_SKILL_PROMPT).toContain('name and description');
  });

  it('interviews the user before writing', () => {
    expect(CREATE_SKILL_PROMPT).toContain('interview me');
    expect(CREATE_SKILL_PROMPT).toContain('clarifying questions');
    expect(CREATE_SKILL_PROMPT).toContain('do not invent');
  });

  it('routes creation through the normal write + skill_validate path', () => {
    // No elevated access: the agent writes through its usual approval-gated tool
    // and verifies with the existing skill_validate tool.
    expect(CREATE_SKILL_PROMPT).toContain('normal file-writing tool');
    expect(CREATE_SKILL_PROMPT).toContain('usual approval');
    expect(CREATE_SKILL_PROMPT).toContain('skill_validate');
  });
});
