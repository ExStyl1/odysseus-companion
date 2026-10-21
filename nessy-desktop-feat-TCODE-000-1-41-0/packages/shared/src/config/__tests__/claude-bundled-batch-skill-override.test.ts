/**
 * C3.326 — the vendor's bundled `/batch` is OFF on this fork's claude sessions.
 *
 * The whole argument, the measured roster arms and the alternatives refused are
 * in `config/skill-overrides.ts` (`CLAUDE_BUNDLED_BATCH_SKILL_NAME`). What this
 * file pins is the pair a later edit could break in opposite directions:
 *
 * 1. the posture REACHES the spawn — the override is in the single seam onto
 *    `Options.settings`, so a refactor that drops the spread is loud;
 * 2. the posture stays NARROW — it is one skill, not the blunt
 *    `disableBundledSkills`, which the measurement recorded as taking twelve
 *    siblings with it.
 *
 * Plus one binary marker, because the failure this file cannot otherwise see is
 * the vendor RENAMING or removing the skill: our override would then be a key
 * matching nothing, and every assertion below would still pass.
 */
import { describe, expect, it } from 'bun:test'

import {
  CLAUDE_BUNDLED_BATCH_SKILL_DISCLOSURE,
  CLAUDE_BUNDLED_BATCH_SKILL_NAME,
  CLAUDE_BUNDLED_BATCH_SKILL_OVERRIDE,
  SKILL_OVERRIDES_SETTING_KEY,
  skillOverrideRefusesInvocation,
} from '../skill-overrides.ts'
import { DISABLE_BUNDLED_SKILLS_SETTING_KEY } from '../bundled-skills-settings.ts'
import { buildClaudeFlagSettingsOptions } from '../../agent/claude-auto-mode-policy.ts'

const NATIVE_BINARY = (() => {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir)
  const nodeModules = sdkEntry.slice(0, sdkEntry.lastIndexOf('/@anthropic-ai/'))
  return `${nodeModules}/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
})()

/** One `grep -a -q -F` pass; `-q` stops at the first hit. */
const inBinary = (marker: string): boolean =>
  Bun.spawnSync(['grep', '-a', '-q', '-F', '-e', marker, NATIVE_BINARY]).exitCode === 0

const haveBinary = (): boolean => {
  try {
    return Bun.file(NATIVE_BINARY).size > 0
  } catch {
    return false
  }
}

function flagSettings(): Record<string, unknown> {
  return buildClaudeFlagSettingsOptions({}).settings as Record<string, unknown>
}

describe('C3.326 — the bundled /batch is turned off on the flag tier', () => {
  it('a claude spawn with nothing else to say still carries the override', () => {
    const overrides = flagSettings()[SKILL_OVERRIDES_SETTING_KEY] as Record<string, string> | undefined
    expect(overrides).toBeDefined()
    expect(overrides?.[CLAUDE_BUNDLED_BATCH_SKILL_NAME]).toBe('off')
  })

  it("is the state that refuses the invocation, from BOTH origins — not merely one that hides it", () => {
    // Read through the module's own rule rather than by re-spelling `'off'`, so
    // relaxing the constant to `'name-only'` or `'user-invocable-only'` fails
    // here instead of shipping a `/batch` the user can still type.
    const state = CLAUDE_BUNDLED_BATCH_SKILL_OVERRIDE
      .skillOverrides[CLAUDE_BUNDLED_BATCH_SKILL_NAME]
    expect(skillOverrideRefusesInvocation(state, 'user')).toBe(true)
    expect(skillOverrideRefusesInvocation(state, 'model')).toBe(true)
  })

  it('takes ONE skill and not the blunt switch — the twelve siblings stay', () => {
    // The negative that gives the positive above its meaning. `disableBundledSkills`
    // measured a roster of 25 against 38, i.e. it would also remove
    // `deep-research`, `code-review`, `debug`, `loop`, `claude-api` and seven more.
    const settings = flagSettings()
    expect(settings[DISABLE_BUNDLED_SKILLS_SETTING_KEY]).toBeUndefined()
    expect(Object.keys(settings[SKILL_OVERRIDES_SETTING_KEY] as Record<string, string>))
      .toEqual([CLAUDE_BUNDLED_BATCH_SKILL_NAME])
  })

  it('says where it went, and says what replaces it', () => {
    // The vendor's own refusal names the key and not the reason; this sentence
    // is the one a person reads. It has to survive a well-meaning trim.
    expect(CLAUDE_BUNDLED_BATCH_SKILL_DISCLOSURE).toContain('/batch')
    expect(CLAUDE_BUNDLED_BATCH_SKILL_DISCLOSURE).toContain('branch')
  })

  it('the skill this key names still exists in the binary we ship', () => {
    if (!haveBinary()) return // darwin-arm64 artefact; absent on other hosts.
    // The bundled skill's own refusal string, read out of the vendored
    // `2.1.247` binary by W18-e and re-pinned here: if the vendor renames or
    // drops `/batch`, this goes red and the override above becomes a key
    // matching nothing rather than a silent no-op.
    expect(inBinary('The `/batch` command requires a git repo because it spawns agents in isolated git worktrees')).toBe(true)
    // Zero control on the identical instrument, so a `grep` that matched
    // everything cannot make the line above pass for no reason.
    expect(inBinary('The `/zzNotARealBundledSkillC3326` command requires a git repo')).toBe(false)
  }, 180_000)
})
