import { describe, expect, it } from 'bun:test'
import {
  DISABLE_BUNDLED_SKILLS_COMPAT_ENV_VAR,
  DISABLE_BUNDLED_SKILLS_ENV_VAR,
  bundledSkillsDisabled,
  bundledSkillsDisabledByEnv,
  bundledSkillsDisabledBySetting,
} from '../bundled-skills-settings.ts'

describe('bundledSkillsDisabledByEnv', () => {
  it('is off when neither spelling is set', () => {
    expect(bundledSkillsDisabledByEnv({})).toBe(false)
  })

  it.each(['1', 'true', 'yes', 'on'])('accepts %p under either spelling', value => {
    expect(bundledSkillsDisabledByEnv({ [DISABLE_BUNDLED_SKILLS_ENV_VAR]: value })).toBe(true)
    expect(bundledSkillsDisabledByEnv({ [DISABLE_BUNDLED_SKILLS_COMPAT_ENV_VAR]: value })).toBe(true)
  })

  it('lets the Nessy name win when both are set', () => {
    expect(bundledSkillsDisabledByEnv({
      [DISABLE_BUNDLED_SKILLS_ENV_VAR]: '0',
      [DISABLE_BUNDLED_SKILLS_COMPAT_ENV_VAR]: '1',
    })).toBe(false)
  })
})

describe('bundledSkillsDisabledBySetting', () => {
  it('reads only the JSON boolean true', () => {
    expect(bundledSkillsDisabledBySetting({ disableBundledSkills: true })).toBe(true)
    expect(bundledSkillsDisabledBySetting({ disableBundledSkills: false })).toBe(false)
    expect(bundledSkillsDisabledBySetting({ disableBundledSkills: 'true' })).toBe(false)
    expect(bundledSkillsDisabledBySetting({})).toBe(false)
    expect(bundledSkillsDisabledBySetting(null)).toBe(false)
    expect(bundledSkillsDisabledBySetting(undefined)).toBe(false)
  })
})

describe('bundledSkillsDisabled', () => {
  it('is on when either half asks for it, and neither half can cancel the other', () => {
    expect(bundledSkillsDisabled({}, {})).toBe(false)
    expect(bundledSkillsDisabled({ disableBundledSkills: true }, {})).toBe(true)
    expect(bundledSkillsDisabled({}, { [DISABLE_BUNDLED_SKILLS_ENV_VAR]: '1' })).toBe(true)
    expect(bundledSkillsDisabled(
      { disableBundledSkills: true },
      { [DISABLE_BUNDLED_SKILLS_ENV_VAR]: '0' },
    )).toBe(true)
  })
})
