import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SKILL_OVERRIDES_SETTING_KEY,
  mergeSkillOverrideLayers,
  parseSkillOverrides,
  resolveSkillOverride,
  resolveSkillOverrides,
  skillOverrideHidesDescriptionFromModel,
  skillOverrideHidesFromCommandLists,
  skillOverrideHidesFromModelListing,
  skillOverrideRefusesInvocation,
  type SkillOverrideState,
} from '../skill-overrides.ts'
import { StoredConfigTopLevelSchema } from '../validators.ts';
import { bundledSkillsDisabledBySetting } from '../bundled-skills-settings.ts';

const roots: string[] = []

function projectFixture(files: Partial<Record<'project' | 'local', string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-skill-overrides-'))
  roots.push(root)
  mkdirSync(join(root, '.claude'), { recursive: true })
  if (files.project !== undefined) writeFileSync(join(root, '.claude', 'settings.json'), files.project)
  if (files.local !== undefined) writeFileSync(join(root, '.claude', 'settings.local.json'), files.local)
  return root
}

describe('parseSkillOverrides', () => {
  it('reads the documented example verbatim', () => {
    // skills.md:680-687, copied from the page.
    const parsed = parseSkillOverrides({
      skillOverrides: { 'legacy-context': 'name-only', deploy: 'off' },
    })
    expect([...parsed]).toEqual([['legacy-context', 'name-only'], ['deploy', 'off']])
  })

  it('drops values outside the four states and keeps the rest of the map', () => {
    // A state written by a newer release must be ignored, not fatal, and must
    // not take its neighbours down with it.
    const parsed = parseSkillOverrides({
      skillOverrides: { future: 'listed-quietly', deploy: 'off', broken: 7, empty: null },
    })
    expect([...parsed]).toEqual([['deploy', 'off']])
  })

  it('is empty for every non-map shape', () => {
    for (const config of [undefined, null, 42, 'off', [], { skillOverrides: 'off' }, { skillOverrides: [] }]) {
      expect(parseSkillOverrides(config).size).toBe(0)
    }
  })
})

describe('resolveSkillOverride', () => {
  it('treats a skill absent from the map as "on" (skills.md:678)', () => {
    const overrides = parseSkillOverrides({ skillOverrides: { deploy: 'off' } })
    expect(resolveSkillOverride(overrides, 'deploy')).toBe('off')
    expect(resolveSkillOverride(overrides, 'review')).toBe('on')
    expect(resolveSkillOverride(undefined, 'review')).toBe('on')
  })
})

describe('mergeSkillOverrideLayers', () => {
  it('lets a later layer replace an earlier one per skill name', () => {
    const merged = mergeSkillOverrideLayers(
      new Map<string, SkillOverrideState>([['deploy', 'off'], ['review', 'name-only']]),
      new Map<string, SkillOverrideState>([['deploy', 'on']]),
    )
    expect(merged.get('deploy')).toBe('on')
    expect(merged.get('review')).toBe('name-only')
  })
})

describe('resolveSkillOverrides across scopes', () => {
  it('reads the .claude destination the page names, local over project over user', () => {
    // skills.md:663 — the `/skills` menu saves to `.claude/settings.local.json`.
    const root = projectFixture({
      project: JSON.stringify({ skillOverrides: { deploy: 'name-only', shared: 'off' } }),
      local: '{\n  // a comment, as claude-settings-store already tolerates\n  "skillOverrides": { "deploy": "off" }\n}',
    })
    const resolved = resolveSkillOverrides({
      userConfig: { skillOverrides: { deploy: 'on', mine: 'user-invocable-only' } },
      workingDirectory: root,
      projectTrusted: true,
    })
    expect(resolved.get('deploy')).toBe('off')
    expect(resolved.get('shared')).toBe('off')
    expect(resolved.get('mine')).toBe('user-invocable-only')
  })

  it('reads neither project file for an untrusted project', () => {
    const root = projectFixture({ local: JSON.stringify({ skillOverrides: { deploy: 'off' } }) })
    const resolved = resolveSkillOverrides({
      userConfig: { skillOverrides: { mine: 'off' } },
      workingDirectory: root,
      projectTrusted: false,
    })
    expect(resolved.get('deploy')).toBeUndefined()
    expect(resolved.get('mine')).toBe('off')
  })

  it('fails open on an unparseable settings file rather than throwing', () => {
    const root = projectFixture({ local: '{ not json at all' })
    const resolved = resolveSkillOverrides({
      userConfig: { skillOverrides: { mine: 'off' } },
      workingDirectory: root,
      projectTrusted: true,
    })
    expect(resolved.get('mine')).toBe('off')
  })
})

describe('the four states, and what each one does', () => {
  // skills.md:667-:672, one row per documented state.
  const table: {
    state: SkillOverrideState
    hiddenFromModel: boolean
    descriptionSuppressed: boolean
    hiddenFromCommandLists: boolean
  }[] = [
    { state: 'on', hiddenFromModel: false, descriptionSuppressed: false, hiddenFromCommandLists: false },
    { state: 'name-only', hiddenFromModel: false, descriptionSuppressed: true, hiddenFromCommandLists: false },
    { state: 'user-invocable-only', hiddenFromModel: true, descriptionSuppressed: false, hiddenFromCommandLists: false },
    { state: 'off', hiddenFromModel: true, descriptionSuppressed: false, hiddenFromCommandLists: true },
  ]

  it.each(table)('$state matches the documented row', row => {
    expect(skillOverrideHidesFromModelListing(row.state)).toBe(row.hiddenFromModel)
    expect(skillOverrideHidesDescriptionFromModel(row.state)).toBe(row.descriptionSuppressed)
    expect(skillOverrideHidesFromCommandLists(row.state)).toBe(row.hiddenFromCommandLists)
  })

  it('an absent state behaves exactly like "on"', () => {
    expect(skillOverrideHidesFromModelListing(undefined)).toBe(false)
    expect(skillOverrideHidesDescriptionFromModel(undefined)).toBe(false)
    expect(skillOverrideHidesFromCommandLists(undefined)).toBe(false)
  })
})

describe('skillOverrideRefusesInvocation — four states x both origins', () => {
  // The merged rule. f060 alone would refuse only `off` (leaving a model free to
  // guess a `user-invocable-only` slug); f171 alone would never refuse a user
  // (leaving `off` invocable by full name against skills.md:676).
  const matrix: { state: SkillOverrideState | undefined; model: boolean; user: boolean }[] = [
    { state: undefined, model: false, user: false },
    { state: 'on', model: false, user: false },
    { state: 'name-only', model: false, user: false },
    { state: 'user-invocable-only', model: true, user: false },
    { state: 'off', model: true, user: true },
  ]

  it.each(matrix)('$state refuses model=$model user=$user', row => {
    expect(skillOverrideRefusesInvocation(row.state, 'model')).toBe(row.model)
    expect(skillOverrideRefusesInvocation(row.state, 'user')).toBe(row.user)
  })
})

describe('SKILL_OVERRIDES_SETTING_KEY', () => {
  it("is Claude's exact spelling, not a NESSY_ one", () => {
    expect(SKILL_OVERRIDES_SETTING_KEY).toBe('skillOverrides')
  })
})

process.on('exit', () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('disableBundledSkills is reachable from a real config file', () => {
  // The reader (`bundledSkillsDisabledBySetting`) shipped long before this, but
  // the key was absent from `StoredConfigKnownFields` while the top-level
  // envelope is `.strict()` — so the documented setting did not merely fail to
  // apply, it made the whole config.json unloadable. Both halves are asserted:
  // the schema accepts it, and the reader still resolves a malformed value off.
  it('parses through the strict top-level envelope', () => {
    const parsed = StoredConfigTopLevelSchema.safeParse({ disableBundledSkills: true });
    expect(parsed.success).toBe(true);
  });

  it('resolves a non-true value off rather than bricking', () => {
    expect(bundledSkillsDisabledBySetting({ disableBundledSkills: true })).toBe(true);
    expect(bundledSkillsDisabledBySetting({ disableBundledSkills: 'yes' })).toBe(false);
    expect(bundledSkillsDisabledBySetting({})).toBe(false);
  });
});
