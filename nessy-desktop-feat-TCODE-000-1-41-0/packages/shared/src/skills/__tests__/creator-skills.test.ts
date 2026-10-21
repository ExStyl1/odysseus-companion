/**
 * Content test for the bundled creator skills (C3).
 *
 * Proves the two shipped built-in skills — `skill-creator` and `plugin-creator`
 * — parse through the SAME on-disk loader the native-sources inventory uses
 * (`loadSkillFromDir`, exercised here via `loadWorkspaceSkills`), with valid
 * frontmatter (non-empty `name` + `description`) and a non-empty body. This is
 * the C3 gate: the C2 macros reference these skills by name, so they must load.
 *
 * Also confirms the C1 placeholder (`_seed-check`) was removed — only the two
 * real creator skills ship now — while the C1 seed invariant (≥1 skill seeds
 * and loads) still holds; that invariant is separately asserted by `seed.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureBundledSkills } from '../seed.ts';
import { loadWorkspaceSkills } from '../storage.ts';

const PACKAGED_SKILLS_DIR = join(
  import.meta.dir,
  '..', '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'skills',
);

const CREATOR_SLUGS = ['skill-creator', 'plugin-creator'] as const;

/**
 * The full bundled set this suite expects to seed. `loop` joined in R39
 * (scheduled-tasks.md:35 — /loop is a bundled skill); the creator pair is
 * still what THIS suite is about, but the seed call enumerates the whole
 * bundled directory, so the expectation must name every shipped slug or the
 * next bundled skill re-breaks it. `code-review` joined in R71
 * (code-review.md:281 — the `/code-review` command). `workflow-authoring`
 * joined in P6.405 (workflows.md#turn-workflows-off names it as one of the
 * things `disableBundledSkills` removes, and it shipped in no bundle here).
 * `simplify` and `security-review` joined in P6.307 — `commands.md`
 * § *All commands* carries a row for each, and both are presets over the same
 * reviewer rather than review paths of their own. Keep sorted.
 */
const BUNDLED_SLUGS = [
  'code-review',
  'loop',
  'security-review',
  'simplify',
  'workflow-authoring',
  ...CREATOR_SLUGS,
] as const;

let tempDir: string;
let workspaceRoot: string;
let skillsRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'creator-skills-test-'));
  workspaceRoot = join(tempDir, 'ws');
  skillsRoot = join(workspaceRoot, 'skills');
  mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('bundled creator skills', () => {
  it('ships both creator skills and no leftover placeholder', () => {
    for (const slug of CREATOR_SLUGS) {
      expect(existsSync(join(PACKAGED_SKILLS_DIR, slug, 'SKILL.md'))).toBe(true);
    }
    // C1 placeholder removed in C3.
    expect(existsSync(join(PACKAGED_SKILLS_DIR, '_seed-check'))).toBe(false);
  });

  it('both creator skills parse via loadSkillFromDir with valid frontmatter', () => {
    const seeded = ensureBundledSkills({ bundledRoot: PACKAGED_SKILLS_DIR, skillsRoot });
    expect(seeded.sort()).toEqual([...BUNDLED_SLUGS].sort());

    const loaded = loadWorkspaceSkills(workspaceRoot);
    // Every seeded slug loads (nothing dropped for bad frontmatter).
    expect(loaded.length).toBe(seeded.length);

    for (const slug of BUNDLED_SLUGS) {
      const skill = loaded.find((s) => s.slug === slug);
      expect(skill).toBeDefined();
      expect(skill?.metadata.name.trim()).toBeTruthy();
      expect(skill?.metadata.description.trim()).toBeTruthy();
      expect(skill?.content.trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * `code-review.md:342` — "`/code-review` is marked `disable-model-invocation`,
   * so if you set it as a scheduled task's prompt, Claude reads it as plain text
   * instead of running the review." The flag is the doc-bound bit and it is
   * silently droppable: without it the skill still loads and still shows in the
   * `/` menu, it just becomes model-invocable. So it is pinned here.
   */
  it('the code-review skill is user-invocable but never model-invocable', () => {
    ensureBundledSkills({ bundledRoot: PACKAGED_SKILLS_DIR, skillsRoot });
    const codeReview = loadWorkspaceSkills(workspaceRoot).find((s) => s.slug === 'code-review');

    expect(codeReview?.metadata.disableModelInvocation).toBe(true);
    // `user-invocable` defaults true, so the `/code-review` entry survives.
    expect(codeReview?.metadata.userInvocable).not.toBe(false);
    expect(codeReview?.metadata.argumentHint).toBe('[effort] [--fix] [target]');
    // The documented default scope, and the two documented targets this build
    // cannot serve — both must be stated, not silently absent.
    expect(codeReview?.content).toContain('commits ahead of');
    expect(codeReview?.content).toContain('pull-request number');
    expect(codeReview?.content).toContain('no_change_needed');
  });

  /**
   * P6.405. `workflows.md:309`, whole sentence: "Before you edit or ask, run the
   * `/workflow-authoring` [bundled skill](/docs/en/skills#bundled-skills) to load
   * the script-writing reference Claude works from." So the body has to BE that
   * reference — the helper names, the two caps and the failure rule a script
   * author gets wrong — not a pointer at one. Each marker below is a thing an
   * author cannot write a correct script without; a body that loses one has
   * stopped being the reference the page sends the model to load.
   */
  it('the workflow-authoring skill carries the script reference, not a pointer to one', () => {
    ensureBundledSkills({ bundledRoot: PACKAGED_SKILLS_DIR, skillsRoot });
    const skill = loadWorkspaceSkills(workspaceRoot).find((s) => s.slug === 'workflow-authoring');

    expect(skill).toBeDefined();
    // The helper set the `workflow` tool actually injects.
    for (const helper of ['agent(', 'parallel(', 'pipeline(', 'phase(', 'budget']) {
      expect(skill?.content).toContain(helper);
    }
    // Both caps, by value — `workflows.md#behavior-and-limits`.
    expect(skill?.content).toContain('4,096');
    expect(skill?.content).toContain('1,000');
    // The failure rule fan-out authors get wrong, and the resume knob.
    expect(skill?.content).toContain('filter(Boolean)');
    expect(skill?.content).toContain('resumeRunId');
    // `meta` requiredness is the loader's own contract.
    expect(skill?.content).toContain('pure literal');
  });

  /**
   * The boundary: the skill is a REFERENCE the user loads before authoring, and
   * loading it is not consent to run anything. A body that omits that line reads
   * as a licence to launch, which is the one failure this skill could cause.
   */
  it('the workflow-authoring skill does not authorize a run', () => {
    ensureBundledSkills({ bundledRoot: PACKAGED_SKILLS_DIR, skillsRoot });
    const skill = loadWorkspaceSkills(workspaceRoot).find((s) => s.slug === 'workflow-authoring');

    expect(skill?.metadata.description.toLowerCase()).toContain('does not authorize');
    expect(skill?.content).toContain('does not authorize a run');
  });

  it('the skill-creator description references skill_validate and the plugin-creator references plugin.json', () => {
    ensureBundledSkills({ bundledRoot: PACKAGED_SKILLS_DIR, skillsRoot });
    const loaded = loadWorkspaceSkills(workspaceRoot);

    const skillCreator = loaded.find((s) => s.slug === 'skill-creator');
    expect(skillCreator?.content).toContain('skill_validate');
    expect(skillCreator?.content).toContain('~/.nessy-agent/skills/');

    const pluginCreator = loaded.find((s) => s.slug === 'plugin-creator');
    expect(pluginCreator?.content).toContain('plugin.json');
    // No new tool / no elevated access: the guide points at the existing install
    // flow, not a bespoke mechanism.
    expect(pluginCreator?.content).toContain('Install locally');
    expect(pluginCreator?.content).toContain('Do not build a new install mechanism');
  });
});
