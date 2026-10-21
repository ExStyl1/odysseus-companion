/**
 * Tests for Skills Storage
 *
 * Verifies the three-tier skill loading system:
 * 1. Global skills: ~/.agents/skills/ (lowest priority)
 * 2. Workspace skills: {workspaceRoot}/skills/ (medium priority)
 * 3. Project skills: {projectRoot}/.agents/skills/ (highest priority)
 *
 * Uses real temp directories to test actual filesystem operations.
 *
 * Note: The global skills directory (~/.agents/skills/) is a module-level constant
 * that cannot be mocked reliably when tests run in parallel with other test files.
 * The loadAllSkills tests account for any pre-existing global skills by capturing a
 * baseline count and validating relative to it.
 *
 * The fourth tier, administrator-owned skills (P6.8), would have the same
 * problem — `loadAllSkills` reads codex's and Claude's machine-wide managed
 * directories, and a managed corporate host can have them populated, which would
 * move the baseline counts below. Unlike the global directory, this one CAN be
 * neutralized: `getAdminAgentSkillsDirs()` reads the environment on every call,
 * so the file-wide `beforeEach` empties the override and the counts hold on any
 * machine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  ADMIN_SKILLS_DIR_ENV,
  getAdminAgentSkillsDirs,
  loadAllSkills,
  loadSkillBySlug,
  loadWorkspaceSkills,
  loadSkill,
  skillExists,
  listSkillSlugs,
  deleteSkill,
} from '../storage.ts';
import type { LoadedSkill } from '../types.ts';

// ============================================================
// Temp Directory Setup
// ============================================================

let tempDir: string;
let workspaceRoot: string;
let projectRoot: string;

// The real global skills directory — we cannot mock this reliably.
const REAL_GLOBAL_SKILLS_DIR = join(homedir(), '.agents', 'skills');

// ============================================================
// Helpers
// ============================================================

/** Create a valid SKILL.md file in a skill directory */
function createSkill(
  skillsDir: string,
  slug: string,
  opts: { name?: string; description?: string; globs?: string[]; content?: string; icon?: string; requiredSources?: string[] } = {}
): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });

  const name = opts.name ?? slug.charAt(0).toUpperCase() + slug.slice(1);
  const description = opts.description ?? `A ${slug} skill`;
  const content = opts.content ?? `Instructions for ${slug}`;
  const globs = opts.globs ? `\nglobs:\n${opts.globs.map(g => `  - "${g}"`).join('\n')}` : '';
  const icon = opts.icon ? `\nicon: "${opts.icon}"` : '';
  const requiredSources = opts.requiredSources
    ? `\nrequiredSources:\n${opts.requiredSources.map(source => `  - "${source}"`).join('\n')}`
    : '';

  const skillMd = `---
name: "${name}"
description: "${description}"${globs}${icon}${requiredSources}
---

${content}
`;
  writeFileSync(join(skillDir, 'SKILL.md'), skillMd);
  return skillDir;
}

/** Create an invalid SKILL.md (missing required fields) */
function createInvalidSkill(skillsDir: string, slug: string): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\ntitle: "No name or description"\n---\nContent');
  return skillDir;
}

/** Create a directory without SKILL.md */
function createEmptySkillDir(skillsDir: string, slug: string): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });
  return skillDir;
}

/** Get the set of slugs currently in the real global skills directory */
function getExistingGlobalSlugs(): Set<string> {
  const emptyWs = mkdtempSync(join(tmpdir(), 'skills-baseline-'));
  mkdirSync(join(emptyWs, 'skills'), { recursive: true });
  try {
    const skills = loadAllSkills(emptyWs);
    // These are all global skills since the workspace is empty
    return new Set(skills.map(s => s.slug));
  } finally {
    rmSync(emptyWs, { recursive: true, force: true });
  }
}

// ============================================================
// Test Setup
// ============================================================

/** Saved so each test restores whatever the process actually had (P6.8). */
let savedAdminSkillsDirEnv: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skills-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  projectRoot = join(tempDir, 'project');

  // Neutralize the administrator-owned tier so the baseline counts below do not
  // depend on whether this machine is centrally managed. See the file header.
  savedAdminSkillsDirEnv = process.env[ADMIN_SKILLS_DIR_ENV];
  process.env[ADMIN_SKILLS_DIR_ENV] = '';

  // Create base directories
  mkdirSync(join(workspaceRoot, 'skills'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  if (savedAdminSkillsDirEnv === undefined) {
    delete process.env[ADMIN_SKILLS_DIR_ENV];
  } else {
    process.env[ADMIN_SKILLS_DIR_ENV] = savedAdminSkillsDirEnv;
  }

  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================
// Tests: loadSkill (single workspace skill)
// ============================================================

describe('loadSkill', () => {
  it('should load a valid skill from workspace', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'commit', {
      name: 'Git Commit',
      description: 'Helps with git commits',
      content: 'Run git commit with a good message',
    });

    const skill = loadSkill(workspaceRoot, 'commit');

    expect(skill).not.toBeNull();
    expect(skill!.slug).toBe('commit');
    expect(skill!.metadata.name).toBe('Git Commit');
    expect(skill!.metadata.description).toBe('Helps with git commits');
    expect(skill!.content).toContain('Run git commit with a good message');
    expect(skill!.source).toBe('workspace');
    expect(skill!.path).toBe(join(skillsDir, 'commit'));
  });

  it('should return null for non-existent skill slug', () => {
    const skill = loadSkill(workspaceRoot, 'nonexistent');
    expect(skill).toBeNull();
  });

  it('should return null for directory without SKILL.md', () => {
    createEmptySkillDir(join(workspaceRoot, 'skills'), 'empty-skill');

    const skill = loadSkill(workspaceRoot, 'empty-skill');
    expect(skill).toBeNull();
  });

  it('should degrade instead of disappearing when required fields are missing', () => {
    // Claude's documented contract (code.claude.com/docs/en/skills.md, frontmatter
    // reference): `name` is optional and defaults to the directory name;
    // `description` is only "Recommended" and falls back to the first paragraph.
    createInvalidSkill(join(workspaceRoot, 'skills'), 'bad-skill');

    const skill = loadSkill(workspaceRoot, 'bad-skill');
    expect(skill).not.toBeNull();
    expect(skill!.metadata.name).toBe('bad-skill');
  });

  it('should load skill with optional globs', () => {
    createSkill(join(workspaceRoot, 'skills'), 'frontend', {
      globs: ['*.tsx', '*.css'],
    });

    const skill = loadSkill(workspaceRoot, 'frontend');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.globs).toEqual(['*.tsx', '*.css']);
    // `globs` is the legacy spelling of the documented `paths` (`skills.md:267`)
    // and now populates it, so the one field the runtime reads has a value.
    expect(skill!.metadata.paths).toEqual(['*.tsx', '*.css']);
  });

  it('should prefer the documented paths spelling and split it on commas', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    const write = (slug: string, frontmatter: string) => {
      mkdirSync(join(skillsDir, slug), { recursive: true });
      writeFileSync(
        join(skillsDir, slug, 'SKILL.md'),
        `---\nname: "${slug}"\ndescription: "d"\n${frontmatter}\n---\n\nBody.\n`,
      );
    };

    // "Accepts a comma-separated string or a YAML list" — and a glob may contain
    // a space, so whitespace is NOT a delimiter the way it is for `arguments`.
    write('commas', 'paths: "src/**/*.py, docs/my notes/**"');
    expect(loadSkill(workspaceRoot, 'commas')!.metadata.paths)
      .toEqual(['src/**/*.py', 'docs/my notes/**']);

    write('both', 'paths: ["a/**"]\nglobs: ["b/**"]');
    expect(loadSkill(workspaceRoot, 'both')!.metadata.paths).toEqual(['a/**']);
  });

  /**
   * `skills.md:256` (`arguments`) and `:255` (`argument-hint`). Both documented
   * spellings and the camelCase spelling parse, like every other field here.
   */
  it('should load the documented argument fields in both spellings', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    const write = (slug: string, frontmatter: string) => {
      mkdirSync(join(skillsDir, slug), { recursive: true });
      writeFileSync(
        join(skillsDir, slug, 'SKILL.md'),
        `---\nname: "${slug}"\ndescription: "d"\n${frontmatter}\n---\n\nUse $issue.\n`,
      );
    };

    write('yaml-list', 'arguments: [issue, branch]\nargument-hint: "[issue-number]"');
    expect(loadSkill(workspaceRoot, 'yaml-list')!.metadata.argumentNames).toEqual(['issue', 'branch']);
    expect(loadSkill(workspaceRoot, 'yaml-list')!.metadata.argumentHint).toBe('[issue-number]');

    // "Accepts a space-separated string" — the delimiter `paths` does NOT use.
    write('spaced', 'arguments: issue branch');
    expect(loadSkill(workspaceRoot, 'spaced')!.metadata.argumentNames).toEqual(['issue', 'branch']);

    write('camel', 'argumentNames: [a, b]\nargumentHint: "[a] [b]"');
    expect(loadSkill(workspaceRoot, 'camel')!.metadata.argumentNames).toEqual(['a', 'b']);
    expect(loadSkill(workspaceRoot, 'camel')!.metadata.argumentHint).toBe('[a] [b]');

    // Order is the position mapping, so a repeat keeps its own slot.
    write('dup', 'arguments: [a, a, b]');
    expect(loadSkill(workspaceRoot, 'dup')!.metadata.argumentNames).toEqual(['a', 'a', 'b']);
  });

  it('should load skill with normalized requiredSources', () => {
    createSkill(join(workspaceRoot, 'skills'), 'with-sources', {
      requiredSources: ['linear', ' github ', 'linear'],
    });

    const skill = loadSkill(workspaceRoot, 'with-sources');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.requiredSources).toEqual(['linear', 'github']);
  });

  it('should normalize single-string requiredSources into an array', () => {
    const skillDir = join(workspaceRoot, 'skills', 'single-source');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: "Single Source"
description: "Skill with scalar requiredSources"
requiredSources: linear
---

Use linear tools.
`);

    const skill = loadSkill(workspaceRoot, 'single-source');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.requiredSources).toEqual(['linear']);
  });

  it('should ignore invalid requiredSources entries', () => {
    const skillDir = join(workspaceRoot, 'skills', 'invalid-sources');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: "Invalid Sources"
description: "Skill with mixed requiredSources values"
requiredSources:
  - linear
  - 123
  - true
  - "  "
---

Use linear tools.
`);

    const skill = loadSkill(workspaceRoot, 'invalid-sources');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.requiredSources).toEqual(['linear']);
  });

  it('should set iconPath when icon file exists', () => {
    const skillDir = createSkill(join(workspaceRoot, 'skills'), 'with-icon');
    writeFileSync(join(skillDir, 'icon.svg'), '<svg></svg>');

    const skill = loadSkill(workspaceRoot, 'with-icon');

    expect(skill).not.toBeNull();
    expect(skill!.iconPath).toBe(join(skillDir, 'icon.svg'));
  });

  it('should not set iconPath when no icon file exists', () => {
    createSkill(join(workspaceRoot, 'skills'), 'no-icon');

    const skill = loadSkill(workspaceRoot, 'no-icon');

    expect(skill).not.toBeNull();
    expect(skill!.iconPath).toBeUndefined();
  });
});

// ============================================================
// Tests: lenient frontmatter + documented control fields (P7 Task 1)
// ============================================================

/** Write a raw SKILL.md, bypassing createSkill's always-valid frontmatter. */
function writeRawSkill(skillsDir: string, slug: string, content: string): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content);
  return skillDir;
}

describe('skill frontmatter leniency', () => {
  it('derives a name from the directory when frontmatter omits it', () => {
    writeRawSkill(join(workspaceRoot, 'skills'), 'code-reviewer', '---\ndescription: Reviews code\n---\n\nBody.\n');

    const skill = loadSkill(workspaceRoot, 'code-reviewer');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.name).toBe('code-reviewer');
    expect(skill!.metadata.description).toBe('Reviews code');
  });

  it('derives a description from the first body paragraph when frontmatter omits it', () => {
    writeRawSkill(
      join(workspaceRoot, 'skills'),
      'review',
      '---\nname: Review\n---\n\n# Heading\n\nReviews code for correctness.\n\nMore prose that must not leak in.\n',
    );

    const skill = loadSkill(workspaceRoot, 'review');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.name).toBe('Review');
    expect(skill!.metadata.description).toBe('Reviews code for correctness.');
  });

  it('accepts a skill with no frontmatter at all', () => {
    writeRawSkill(join(workspaceRoot, 'skills'), 'plain', 'Just a body.\n');

    const skill = loadSkill(workspaceRoot, 'plain');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.name).toBe('plain');
    expect(skill!.content.trim()).toBe('Just a body.');
  });

  it('accepts a skill whose frontmatter YAML is malformed', () => {
    // Documented Claude behaviour: "If the frontmatter YAML is malformed,
    // Claude Code loads the skill body with empty metadata."
    writeRawSkill(join(workspaceRoot, 'skills'), 'broken', '---\nname: [unclosed\n---\n\nBody text.\n');

    const skill = loadSkill(workspaceRoot, 'broken');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.name).toBe('broken');
  });

  it('keeps the documented control fields, including the hyphenated spellings', () => {
    writeRawSkill(join(workspaceRoot, 'skills'), 'controlled', [
      '---',
      'name: review',
      'description: d',
      'allowed-tools: [Read, Grep]',
      'disallowed-tools: AskUserQuestion',
      'disable-model-invocation: true',
      'user-invocable: false',
      'model: inherit',
      'when_to_use: When a diff needs a second pair of eyes',
      '---',
      'Body.',
    ].join('\n'));

    const skill = loadSkill(workspaceRoot, 'controlled');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.allowedTools).toEqual(['Read', 'Grep']);
    expect(skill!.metadata.disallowedTools).toEqual(['AskUserQuestion']);
    expect(skill!.metadata.disableModelInvocation).toBe(true);
    expect(skill!.metadata.userInvocable).toBe(false);
    expect(skill!.metadata.model).toBe('inherit');
    expect(skill!.metadata.whenToUse).toBe('When a diff needs a second pair of eyes');
  });

  it('accepts the camelCase spelling of every control field', () => {
    writeRawSkill(join(workspaceRoot, 'skills'), 'camel', [
      '---',
      'name: review',
      'description: d',
      'allowedTools: Read Grep',
      'disableModelInvocation: true',
      'userInvocable: false',
      'whenToUse: Trigger phrase',
      '---',
      'Body.',
    ].join('\n'));

    const skill = loadSkill(workspaceRoot, 'camel');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.allowedTools).toEqual(['Read', 'Grep']);
    expect(skill!.metadata.disableModelInvocation).toBe(true);
    expect(skill!.metadata.userInvocable).toBe(false);
    expect(skill!.metadata.whenToUse).toBe('Trigger phrase');
  });

  it.each([
    ['yes', true], ['YES', true], ['on', true], ['1', true], ['true', true],
    ['no', false], ['Off', false], ['0', false], ['false', false],
  ])('reads the documented boolean spelling %s as %s', (written, expected) => {
    // `skills.md:248` — booleans accept yes/no/on/off/1/0 in any case. An
    // unrecognised spelling would read as "not stated", and the absent default
    // for `disable-model-invocation` is permissive, so the author who wrote
    // `yes` to stop model invocation would get model invocation.
    writeRawSkill(join(workspaceRoot, 'skills'), `bool-${written.toLowerCase()}`, [
      '---',
      'name: review',
      'description: d',
      `disable-model-invocation: "${written}"`,
      '---',
      'Body.',
    ].join('\n'));

    const skill = loadSkill(workspaceRoot, `bool-${written.toLowerCase()}`);

    expect(skill!.metadata.disableModelInvocation).toBe(expected);
  });

  it('still treats an unrecognised boolean spelling as not stated', () => {
    writeRawSkill(join(workspaceRoot, 'skills'), 'bool-junk', [
      '---',
      'name: review',
      'description: d',
      'disable-model-invocation: maybe',
      '---',
      'Body.',
    ].join('\n'));

    const skill = loadSkill(workspaceRoot, 'bool-junk');

    expect('disableModelInvocation' in skill!.metadata).toBe(false);
  });

  it('omits a control field the skill does not state', () => {
    // Absent, not false: `userInvocable` defaults to true, so a stored `false`
    // must stay distinguishable from "not stated".
    createSkill(join(workspaceRoot, 'skills'), 'defaults');

    const skill = loadSkill(workspaceRoot, 'defaults');

    expect(skill).not.toBeNull();
    expect('disableModelInvocation' in skill!.metadata).toBe(false);
    expect('userInvocable' in skill!.metadata).toBe(false);
  });

  it('reports the derivation as a diagnostic the caller can surface', () => {
    writeRawSkill(join(workspaceRoot, 'skills'), 'undeclared', 'Body only.\n');

    const skill = loadSkill(workspaceRoot, 'undeclared');

    expect(skill!.diagnostics).toContain('skill-name-derived-from-directory');
  });

  it('still refuses a file with no name derivable from anything', () => {
    // Leniency is not "accept anything": with no frontmatter name and no usable
    // directory name there is nothing to invoke the skill by.
    writeRawSkill(join(workspaceRoot, 'skills'), ' ', '---\ndescription: d\n---\n\nBody.\n');

    expect(loadSkill(workspaceRoot, ' ')).toBeNull();
    expect(loadWorkspaceSkills(workspaceRoot)).toEqual([]);
  });

  it('keeps two skills that derive the same display name instead of last-write-wins', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    writeRawSkill(skillsDir, 'first', '---\nname: review\ndescription: a\n---\n\nA.\n');
    writeRawSkill(skillsDir, 'second', '---\nname: review\ndescription: b\n---\n\nB.\n');

    const skills = loadWorkspaceSkills(workspaceRoot);

    // The directory slug is the identity; a duplicate `name` is a display-label
    // collision only and must not silently drop either skill.
    expect(skills.map(skill => skill.slug).sort()).toEqual(['first', 'second']);
    expect(skills.every(skill => skill.metadata.name === 'review')).toBe(true);
  });
});

// ============================================================
// Tests: loadWorkspaceSkills (all skills from workspace)
// ============================================================

describe('loadWorkspaceSkills', () => {
  it('should load multiple skills from workspace', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'commit');
    createSkill(skillsDir, 'review');
    createSkill(skillsDir, 'deploy');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(3);
    const slugs = skills.map(s => s.slug).sort();
    expect(slugs).toEqual(['commit', 'deploy', 'review']);
    // All should be workspace source
    for (const skill of skills) {
      expect(skill.source).toBe('workspace');
    }
  });

  it('should return empty array for empty skills directory', () => {
    // workspaceRoot/skills/ exists but has no subdirectories
    const skills = loadWorkspaceSkills(workspaceRoot);
    expect(skills).toEqual([]);
  });

  it('should return empty array for non-existent workspace root', () => {
    const skills = loadWorkspaceSkills(join(tempDir, 'nonexistent'));
    expect(skills).toEqual([]);
  });

  it('should skip directories without SKILL.md', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'valid-skill');
    createEmptySkillDir(skillsDir, 'no-skill-md');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe('valid-skill');
  });

  it('should keep SKILL.md files that omit frontmatter fields', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'valid');
    createInvalidSkill(skillsDir, 'invalid');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills.map(skill => skill.slug).sort()).toEqual(['invalid', 'valid']);
  });

  it('should skip non-directory entries', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'real-skill');
    // Create a plain file in the skills directory (not a subdirectory)
    writeFileSync(join(skillsDir, 'readme.txt'), 'This is not a skill');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe('real-skill');
  });

  it('should discover a skill directory reached through a symlink', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    // Real skill lives outside the skills dir; skills/<slug> is a symlink to it.
    const realTarget = join(tempDir, 'external-skill');
    createSkill(realTarget, 'linked', {
      name: 'Linked Skill',
      description: 'Reached via symlink',
    });
    symlinkSync(join(realTarget, 'linked'), join(skillsDir, 'linked'), 'dir');

    // Also create a normal (non-symlink) skill to prove both are found.
    createSkill(skillsDir, 'plain');

    const skills = loadWorkspaceSkills(workspaceRoot);

    const slugs = skills.map(s => s.slug).sort();
    expect(slugs).toEqual(['linked', 'plain']);
    const linked = skills.find(s => s.slug === 'linked');
    expect(linked!.metadata.name).toBe('Linked Skill');
  });

  it('should ignore a broken (dangling) symlink in the skills directory', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'real');
    // Symlink whose target does not exist.
    symlinkSync(join(tempDir, 'does-not-exist'), join(skillsDir, 'broken'), 'dir');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills.map(s => s.slug)).toEqual(['real']);
  });
});

// ============================================================
// Tests: loadAllSkills (three-tier loading)
//
// These tests account for pre-existing global skills at ~/.agents/skills/.
// We capture a baseline and verify our test skills appear with correct sources.
// ============================================================

describe('loadAllSkills', () => {
  const getWorkspaceSkillsDir = () => join(workspaceRoot, 'skills');
  const getProjectSkillsDir = () => join(projectRoot, '.agents', 'skills');

  // Use unique slugs that won't collide with real global skills
  const TEST_PREFIX = '_test_storage_';

  it('should load workspace and project skills alongside any existing global skills', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(wsDir, `${TEST_PREFIX}ws`, { name: 'Workspace Skill', description: 'From workspace' });
    createSkill(projDir, `${TEST_PREFIX}proj`, { name: 'Project Skill', description: 'From project' });

    const skills = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true });

    // Should have baseline global skills + our 2 test skills
    expect(skills.length).toBe(baselineGlobal.size + 2);

    const wsSkill = skills.find(s => s.slug === `${TEST_PREFIX}ws`);
    const projSkill = skills.find(s => s.slug === `${TEST_PREFIX}proj`);

    expect(wsSkill).toBeDefined();
    expect(wsSkill!.source).toBe('workspace');

    expect(projSkill).toBeDefined();
    expect(projSkill!.source).toBe('project');

    // All baseline global skills should still be present with source 'global'
    for (const globalSlug of baselineGlobal) {
      const skill = skills.find(s => s.slug === globalSlug);
      expect(skill).toBeDefined();
      expect(skill!.source).toBe('global');
    }
  });

  it('should override global skills with workspace skills when slug matches', () => {
    const baselineGlobal = getExistingGlobalSlugs();

    // Only test override if there are actually global skills to override
    if (baselineGlobal.size === 0) {
      // No global skills — just verify workspace skills load
      const wsDir = getWorkspaceSkillsDir();
      createSkill(wsDir, `${TEST_PREFIX}ws_only`, { name: 'WS Only', description: 'WS only skill' });
      const skills = loadAllSkills(workspaceRoot);
      expect(skills.find(s => s.slug === `${TEST_PREFIX}ws_only`)).toBeDefined();
      return;
    }

    // Override one of the existing global skills with a workspace skill
    const globalSlugToOverride = [...baselineGlobal][0]!;
    const wsDir = getWorkspaceSkillsDir();
    createSkill(wsDir, globalSlugToOverride, {
      name: 'Workspace Override',
      description: 'This overrides the global skill',
    });

    const skills = loadAllSkills(workspaceRoot);

    const overridden = skills.find(s => s.slug === globalSlugToOverride);
    expect(overridden).toBeDefined();
    expect(overridden!.source).toBe('workspace');
    expect(overridden!.metadata.name).toBe('Workspace Override');

    // Total count should be same as baseline (overridden, not added)
    expect(skills.length).toBe(baselineGlobal.size);
  });

  it('should override workspace skills with project skills (same slug)', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(wsDir, `${TEST_PREFIX}deploy`, { name: 'Workspace Deploy', description: 'Workspace version' });
    createSkill(projDir, `${TEST_PREFIX}deploy`, { name: 'Project Deploy', description: 'Project version' });

    const skills = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true });

    // Only 1 skill for this slug (project overrides workspace), plus baseline globals
    expect(skills.length).toBe(baselineGlobal.size + 1);
    const deploy = skills.find(s => s.slug === `${TEST_PREFIX}deploy`);
    expect(deploy).toBeDefined();
    expect(deploy!.source).toBe('project');
    expect(deploy!.metadata.name).toBe('Project Deploy');
    expect(deploy!.metadata.description).toBe('Project version');
  });

  it('should handle full three-tier override: project > workspace > global', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    // Same slug at workspace and project tiers
    createSkill(wsDir, `${TEST_PREFIX}shared`, { name: 'Workspace', description: 'Workspace version' });
    createSkill(projDir, `${TEST_PREFIX}shared`, { name: 'Project', description: 'Project version' });

    // Unique skills at each controllable tier
    createSkill(wsDir, `${TEST_PREFIX}only_ws`, { description: 'Only in workspace' });
    createSkill(projDir, `${TEST_PREFIX}only_proj`, { description: 'Only in project' });

    const skills = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true });

    // Shared skill should be project version (highest priority)
    const shared = skills.find(s => s.slug === `${TEST_PREFIX}shared`);
    expect(shared).toBeDefined();
    expect(shared!.source).toBe('project');
    expect(shared!.metadata.name).toBe('Project');

    // Unique skills should keep their sources
    expect(skills.find(s => s.slug === `${TEST_PREFIX}only_ws`)!.source).toBe('workspace');
    expect(skills.find(s => s.slug === `${TEST_PREFIX}only_proj`)!.source).toBe('project');

    // Total: baseline globals + shared (1, deduplicated) + only_ws + only_proj = baseline + 3
    expect(skills.length).toBe(baselineGlobal.size + 3);
  });

  it('should handle missing project directory gracefully', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    createSkill(wsDir, `${TEST_PREFIX}ws_skill`);

    // Pass a non-existent project root
    const skills = loadAllSkills(workspaceRoot, join(tempDir, 'nonexistent-project'));

    expect(skills.length).toBe(baselineGlobal.size + 1);
    const wsSkill = skills.find(s => s.slug === `${TEST_PREFIX}ws_skill`);
    expect(wsSkill).toBeDefined();
    expect(wsSkill!.source).toBe('workspace');
  });

  it('should skip project tier when projectRoot is undefined', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });
    createSkill(projDir, `${TEST_PREFIX}project_only`);

    const wsDir = getWorkspaceSkillsDir();
    createSkill(wsDir, `${TEST_PREFIX}ws_skill`);

    // No projectRoot passed — project tier should be skipped
    const skills = loadAllSkills(workspaceRoot);

    // Should NOT contain the project-only skill
    expect(skills.find(s => s.slug === `${TEST_PREFIX}project_only`)).toBeUndefined();
    // Should contain the workspace skill
    expect(skills.find(s => s.slug === `${TEST_PREFIX}ws_skill`)).toBeDefined();
    expect(skills.length).toBe(baselineGlobal.size + 1);
  });

  it('should return only global skills when workspace and project are empty', () => {
    const baselineGlobal = getExistingGlobalSlugs();

    const skills = loadAllSkills(workspaceRoot);

    // With empty workspace and no project, only global skills remain
    expect(skills.length).toBe(baselineGlobal.size);
    for (const skill of skills) {
      expect(skill.source).toBe('global');
    }
  });

  it('should correctly assign source for workspace and project tiers', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(wsDir, `${TEST_PREFIX}w1`);
    createSkill(wsDir, `${TEST_PREFIX}w2`);
    createSkill(projDir, `${TEST_PREFIX}p1`);

    const skills = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true });

    const testSkills = skills.filter(s => s.slug.startsWith(TEST_PREFIX));
    expect(testSkills.filter(s => s.source === 'workspace')).toHaveLength(2);
    expect(testSkills.filter(s => s.source === 'project')).toHaveLength(1);

    // Global skills should all have source 'global'
    const globalSkills = skills.filter(s => !s.slug.startsWith(TEST_PREFIX));
    for (const skill of globalSkills) {
      expect(skill.source).toBe('global');
    }
  });

  it('should withhold project skills when the project is untrusted (fail-closed)', () => {
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(wsDir, `${TEST_PREFIX}ws_visible`);
    createSkill(projDir, `${TEST_PREFIX}proj_gated`);

    // projectRoot passed but NOT trusted -> project tier is skipped.
    const untrusted = loadAllSkills(workspaceRoot, projectRoot);
    expect(untrusted.find(s => s.slug === `${TEST_PREFIX}ws_visible`)?.source).toBe('workspace');
    expect(untrusted.find(s => s.slug === `${TEST_PREFIX}proj_gated`)).toBeUndefined();

    // Once trusted, the project skill appears.
    const trusted = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true });
    expect(trusted.find(s => s.slug === `${TEST_PREFIX}proj_gated`)?.source).toBe('project');
  });

  it('should deduplicate by slug across workspace and project tiers', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    // Same slug in workspace and project — only project should remain
    createSkill(wsDir, `${TEST_PREFIX}dup`, { name: 'WS Dup', description: 'From workspace' });
    createSkill(projDir, `${TEST_PREFIX}dup`, { name: 'Proj Dup', description: 'From project' });
    // Unique skills
    createSkill(wsDir, `${TEST_PREFIX}unique_ws`);
    createSkill(projDir, `${TEST_PREFIX}unique_proj`);

    const skills = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true });

    // 3 test skills (dup deduplicated to 1 + 2 uniques) + baseline
    const testSkills = skills.filter(s => s.slug.startsWith(TEST_PREFIX));
    expect(testSkills).toHaveLength(3);

    const dup = skills.find(s => s.slug === `${TEST_PREFIX}dup`);
    expect(dup!.source).toBe('project');
    expect(dup!.metadata.name).toBe('Proj Dup');
  });

  it('should add plugin-origin skills without overriding native skills', () => {
    const wsDir = getWorkspaceSkillsDir();
    createSkill(wsDir, `${TEST_PREFIX}review`, {
      name: 'Workspace Review',
      description: 'Native workspace review',
    });

    const skills = loadAllSkills(workspaceRoot, projectRoot, {
      pluginSkills: [
        pluginSkill(`${TEST_PREFIX}review`, 'Plugin Review'),
        pluginSkill(`${TEST_PREFIX}plugin_only`, 'Plugin Only'),
      ],
    });
    const review = skills.find(s => s.slug === `${TEST_PREFIX}review`);
    const pluginOnly = skills.find(s => s.slug === `${TEST_PREFIX}plugin_only`);

    expect(review?.source).toBe('workspace');
    expect(review?.metadata.name).toBe('Workspace Review');
    expect(review?.content).toContain(`Instructions for ${TEST_PREFIX}review`);
    expect(review?.readOnly).toBeUndefined();
    expect(review?.origin).toBeUndefined();
    expect(pluginOnly).toEqual(expect.objectContaining({
      slug: `${TEST_PREFIX}plugin_only`,
      source: 'plugin',
      readOnly: true,
      origin: expect.objectContaining({
        pluginInstanceId: 'plugin://internal/toolkit@1.0.0',
      }),
    }));
  });
});

function pluginSkill(slug: string, name: string): LoadedSkill {
  return {
    slug,
    metadata: {
      name,
      description: `${name} description`,
    },
    content: `${name} instructions`,
    path: `/plugins/toolkit/skills/${slug}`,
    source: 'plugin',
    readOnly: true,
    origin: {
      kind: 'plugin',
      pluginInstanceId: 'plugin://internal/toolkit@1.0.0',
      pluginId: 'toolkit',
      marketplaceId: 'internal',
      version: '1.0.0',
      capabilityId: slug,
      scope: 'workspace',
    },
  };
}

// ============================================================
// Tests: skillExists
// ============================================================

describe('skillExists', () => {
  it('should return true for existing skill with SKILL.md', () => {
    createSkill(join(workspaceRoot, 'skills'), 'exists-skill');
    expect(skillExists(workspaceRoot, 'exists-skill')).toBe(true);
  });

  it('should return false for non-existent skill', () => {
    expect(skillExists(workspaceRoot, 'ghost-skill')).toBe(false);
  });

  it('should return false for directory without SKILL.md', () => {
    createEmptySkillDir(join(workspaceRoot, 'skills'), 'empty');
    expect(skillExists(workspaceRoot, 'empty')).toBe(false);
  });
});

// ============================================================
// Tests: listSkillSlugs
// ============================================================

describe('listSkillSlugs', () => {
  it('should list all valid skill slugs', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'alpha');
    createSkill(skillsDir, 'beta');
    createEmptySkillDir(skillsDir, 'no-skill-md');

    const slugs = listSkillSlugs(workspaceRoot);
    expect(slugs.sort()).toEqual(['alpha', 'beta']);
  });

  it('should return empty array for empty skills directory', () => {
    const slugs = listSkillSlugs(workspaceRoot);
    expect(slugs).toEqual([]);
  });

  it('should return empty array for non-existent workspace', () => {
    const slugs = listSkillSlugs(join(tempDir, 'nonexistent'));
    expect(slugs).toEqual([]);
  });

  it('should list a symlinked skill directory', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'plain');
    const realTarget = join(tempDir, 'external-slug-skill');
    createSkill(realTarget, 'linked');
    symlinkSync(join(realTarget, 'linked'), join(skillsDir, 'linked'), 'dir');

    const slugs = listSkillSlugs(workspaceRoot);
    expect(slugs.sort()).toEqual(['linked', 'plain']);
  });
});

// ============================================================
// Tests: deleteSkill
// ============================================================

describe('deleteSkill', () => {
  it('should delete an existing skill', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'to-delete');
    expect(skillExists(workspaceRoot, 'to-delete')).toBe(true);

    const result = deleteSkill(workspaceRoot, 'to-delete');

    expect(result).toBe(true);
    expect(skillExists(workspaceRoot, 'to-delete')).toBe(false);
  });

  it('should return false for non-existent skill', () => {
    const result = deleteSkill(workspaceRoot, 'nonexistent');
    expect(result).toBe(false);
  });
});

// ============================================================
// Tests: administrator-owned skills tier (P6.8)
// ============================================================

/**
 * The override is set per test and restored after, never at module scope —
 * module-scope env mutation is what makes two concurrent `bun test` processes
 * manufacture failures.
 *
 * A note for whoever next sees this file run slowly: while writing these tests
 * it looked like a single `process.env` write in the file-wide `beforeEach` took
 * the file from 2 s green to 85 s with timeouts, and that reading was WRONG. The
 * control that killed it was running HEAD's unmodified test file at the same
 * moment: it was equally slow (246 s, 6 failures) with no env write anywhere in
 * it, at load average 11 with fourteen lanes building. The timings were machine
 * load. Timing evidence collected on a loaded box needs a same-moment control,
 * or it invents a cause.
 */
describe('administrator-owned skills tier', () => {
  const ADMIN_PREFIX = '_test_admin_';
  const getAdminDir = () => join(tempDir, 'managed', 'skills');
  const getWorkspaceSkillsDir = () => join(workspaceRoot, 'skills');
  const getProjectSkillsDir = () => join(projectRoot, '.agents', 'skills');

  // The file-wide beforeEach already emptied the override and the file-wide
  // afterEach restores whatever the process had, so these tests only ever have
  // to point it somewhere they own.

  /** Point the tier at a temp directory this test owns. */
  function useAdminDir(): string {
    const dir = getAdminDir();
    mkdirSync(dir, { recursive: true });
    process.env[ADMIN_SKILLS_DIR_ENV] = dir;
    return dir;
  }

  it('loads administrator-owned skills and tags them source "admin"', () => {
    const adminDir = useAdminDir();
    createSkill(adminDir, `${ADMIN_PREFIX}policy`);

    const skills = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true });

    expect(skills.find(s => s.slug === `${ADMIN_PREFIX}policy`)?.source).toBe('admin');
  });

  it('lets an admin skill override a project skill of the same slug', () => {
    // The one precedence rule in evidence is Claude's, verbatim
    // (skills.md#where-skills-live): "Across levels, enterprise overrides
    // personal, and personal overrides project." So admin must WIN here — this
    // is the assertion that fails if the tier is ever moved to the bottom of
    // loadAllSkills, which is where codex's config-layer precedence would
    // wrongly suggest putting it.
    const adminDir = useAdminDir();
    const projDir = getProjectSkillsDir();
    const wsDir = getWorkspaceSkillsDir();
    mkdirSync(projDir, { recursive: true });

    const slug = `${ADMIN_PREFIX}contested`;
    createSkill(wsDir, slug, { description: 'from workspace' });
    createSkill(projDir, slug, { description: 'from project' });
    createSkill(adminDir, slug, { description: 'from admin' });

    const skills = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true });

    const winner = skills.filter(s => s.slug === slug);
    expect(winner).toHaveLength(1);
    expect(winner[0]?.source).toBe('admin');
    expect(winner[0]?.metadata.description).toBe('from admin');
  });

  it('is NOT gated by project trust — the directory is outside any repository', () => {
    const adminDir = useAdminDir();
    createSkill(adminDir, `${ADMIN_PREFIX}ungated`);

    // Same call the "fail-closed" project test makes with trust withheld.
    const untrusted = loadAllSkills(workspaceRoot, projectRoot);

    expect(untrusted.find(s => s.slug === `${ADMIN_PREFIX}ungated`)?.source).toBe('admin');
  });

  it('resolves the same winner through loadSkillBySlug as through loadAllSkills', () => {
    const adminDir = useAdminDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    const slug = `${ADMIN_PREFIX}bothpaths`;
    createSkill(projDir, slug, { description: 'from project' });
    createSkill(adminDir, slug, { description: 'from admin' });

    const fromAll = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true })
      .find(s => s.slug === slug);
    const bySlug = loadSkillBySlug(workspaceRoot, slug, projectRoot);

    expect(bySlug?.source).toBe('admin');
    expect(bySlug?.source).toBe(fromAll?.source);
    expect(bySlug?.metadata.description).toBe('from admin');
  });

  it('reads nothing when the override is empty, and the empty value is the OFF switch', () => {
    const adminDir = getAdminDir();
    mkdirSync(adminDir, { recursive: true });
    createSkill(adminDir, `${ADMIN_PREFIX}disabled`);

    // beforeEach already set the override to '' — prove that disables the tier.
    expect(getAdminAgentSkillsDirs()).toEqual([]);
    const off = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true });
    expect(off.find(s => s.slug === `${ADMIN_PREFIX}disabled`)).toBeUndefined();

    // ...and that the same directory IS read once the override names it, so the
    // absence above is the switch and not a broken fixture.
    process.env[ADMIN_SKILLS_DIR_ENV] = adminDir;
    const on = loadAllSkills(workspaceRoot, projectRoot, { projectTrusted: true });
    expect(on.find(s => s.slug === `${ADMIN_PREFIX}disabled`)?.source).toBe('admin');
  });

  it('defaults to codex\'s and Claude\'s own administrator-owned roots', () => {
    // Measured defaults, not invented ones: codex `rust-v0.148.0`
    // ext/skills/src/host_roots.rs:114 (system config layer + "skills"), and
    // Claude managed-settings.md#delivery-mechanisms + skills.md#remove-a-skill.
    // Pinned because the whole value of the tier is that an administrator has
    // ALREADY populated these — a typo here makes it silently inert.
    delete process.env[ADMIN_SKILLS_DIR_ENV];

    const dirs = getAdminAgentSkillsDirs();

    expect(dirs).toHaveLength(2);
    if (process.platform === 'win32') {
      expect(dirs[0]?.endsWith(join('OpenAI', 'Codex', 'skills'))).toBe(true);
      expect(dirs[1]).toBe(join('C:\\Program Files', 'ClaudeCode', '.claude', 'skills'));
    } else {
      expect(dirs[0]).toBe('/etc/codex/skills');
      expect(dirs[1]).toBe(process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode/.claude/skills'
        : '/etc/claude-code/.claude/skills');
    }
  });
});
