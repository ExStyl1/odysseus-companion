/**
 * The bundled-skills off switch.
 *
 * `settings-reference.md#disablebundledskills`, quoted whole (read 2026-09-10 —
 * the key-by-key reference is no longer a table row, so this is the section's
 * own prose rather than the cell this comment used to carry):
 *
 * > Turn off the [skills](/docs/en/skills) and workflows included with Claude
 * > Code. Claude Code removes bundled skills and workflows entirely, while
 * > built-in commands such as `/init` stay typable but are hidden from the
 * > model.
 * >
 * > **Per-session overrides**: [`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`](/docs/en/env-vars)
 * > set to `1` turns bundled skills off for one session; whichever of the two
 * > turns them off, the other can't turn them back on
 * >
 * > Skills from plugins, `.claude/skills/`, and `.claude/commands/` are
 * > unaffected. `/doctor` stays typable like the built-in commands; to hide it,
 * > set [`DISABLE_DOCTOR_COMMAND`](/docs/en/env-vars) instead.
 *
 * `env-vars.md:225`, quoted whole:
 *
 * > | `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`                    | Set to `1` to
 * > disable the [skills](/docs/en/skills) and workflows included with Claude
 * > Code: bundled skills and workflows are removed entirely, while built-in
 * > commands like `/init` stay typable but are hidden from the model. `/doctor`
 * > stays typable like the built-in commands; hide it with
 * > `DISABLE_DOCTOR_COMMAND` instead. Skills from plugins, `.claude/skills/`,
 * > and `.claude/commands/` are unaffected. Equivalent to the
 * > [`disableBundledSkills`](/docs/en/settings#available-settings) setting |
 *
 * ## Two halves, one switch
 *
 * The doc names bundled skills AND workflows, so this switch reaches both:
 *
 * 1. **Skills.** Nessy ships built-in skills as a packaged bundle that is
 *    SEEDED into the managed skills root on first run (`skills/seed.ts`). With
 *    the switch on, nothing is seeded, and any copy already on disk from a
 *    previous run is dropped from the capability inventory — otherwise the
 *    switch would only work on a fresh profile, which is the one profile an
 *    administrator turning it on is least likely to have.
 * 2. **Workflows.** It contributes a `disableWorkflows: true` layer rather than
 *    replacing `NESSY_DISABLE_WORKFLOWS`. `resolveWorkflowSettings` composes
 *    `disableWorkflows` tighter-wins, so the two switches cannot disagree in
 *    any direction that matters: whichever asks for OFF wins, and neither can
 *    turn workflows back on over the other. `disableBundledSkills: true` with
 *    `disableWorkflows: false` still leaves workflows off; the reverse also
 *    leaves them off, and additionally leaves bundled skills alone.
 *
 * Plugin skills, project skills and project commands are NOT affected, which is
 * still one of the section's closing sentences and falls out of the
 * implementation: only records under the managed bundled-skill root are dropped.
 *
 * ## What it costs on codex, and why it costs it (P6.534)
 *
 * Until P6.534 this switch reached codex NOWHERE: a cold managed `CODEX_HOME`
 * came back holding codex's own bundled tree — 87 entries measured on the
 * shipped `darwin-arm64` build — and nothing the host did could touch them, so
 * a documented off switch was half true. It now projects onto codex's own key,
 * `[skills.bundled] enabled = false` (`SkillsConfig.bundled.enabled` in the
 * vendored release schema, default `true`), written only in the OFF position.
 *
 * **The consequence the person flipping this switch pays:** codex's own bundled
 * skills are useful and they all go, including `$skill-installer` — the only
 * skill-by-name installer in the product. There is no per-skill middle setting
 * on this key; codex's own `[[skills.config]]` selectors are the finished shape
 * and wait on `skills/list` being wired (P6.404).
 *
 * ## Which bundled skills this fork can carry, and the one arm it cannot (P6.405)
 *
 * `workflows.md#turn-workflows-off` names `/workflow-authoring` as one of the
 * things this switch removes — verbatim: "When workflows are disabled, the
 * bundled workflow commands and the `/workflow-authoring` skill are
 * unavailable". The skill itself scored ZERO in this tree until P6.405, so the
 * switch had a documented subject it could not turn off.
 *
 * It is now authored into the seed at
 * `apps/electron/resources/skills/workflow-authoring/SKILL.md`, as OUR text
 * about OUR `workflow` tool — the helper set, the two caps, the `null`-on-failure
 * rule and resume — rather than an extraction of the vendor's copy. That reaches
 * Pi and codex, which read the managed skills root the seed writes.
 *
 * **The claude arm is NOT inheritable, and the reason is a version.** The page
 * dates the vendor's own `/workflow-authoring` to Claude Code v2.1.248; the SDK
 * this fork vendors declares `claudeCodeVersion 2.1.247` (read from
 * `@anthropic-ai/claude-agent-sdk/package.json` and from `claude --version`,
 * which agree; 2.1.233 on 2026-09-06, re-read 2026-09-12), still ONE patch
 * version short of v2.1.248, so the skill is
 * not in the binary we ship — measured rather than inferred from the version:
 * `workflow-authoring` scores 0 lines / 0 occurrences in the native binary,
 * against `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` 3/3 in the
 * same probe run as the control that proves the probe read the file (C3.252). And it would not surface even once that gap closes:
 * per the owner sitting §2.3, skills reach a claude session as host-rendered
 * prompt text rather than as bundled-skill records, so a vendor bundled skill is
 * not a thing a claude session here enumerates. Recorded rather than built: the
 * honest state is "the seeded copy serves Pi and codex; claude's own copy is two
 * bumps away and would arrive through a different door".
 */

export type BundledSkillsEnvRecord = Record<string, string | undefined>

/** The Nessy spelling. */
export const DISABLE_BUNDLED_SKILLS_ENV_VAR = 'NESSY_DISABLE_BUNDLED_SKILLS'

/** The documented Claude spelling, accepted as a compat alias. */
export const DISABLE_BUNDLED_SKILLS_COMPAT_ENV_VAR = 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'

/** The settings-file key, spelled exactly as `settings-reference.md#disablebundledskills` names it. */
export const DISABLE_BUNDLED_SKILLS_SETTING_KEY = 'disableBundledSkills'

function isTruthyFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/**
 * The env half. Follows the `isCronDisabled` precedent for an aliased pair: the
 * Nessy name wins when both are present, values `1/true/yes/on`.
 */
export function bundledSkillsDisabledByEnv(env: BundledSkillsEnvRecord = process.env): boolean {
  if (env[DISABLE_BUNDLED_SKILLS_ENV_VAR] !== undefined) {
    return isTruthyFlag(env[DISABLE_BUNDLED_SKILLS_ENV_VAR])
  }
  return isTruthyFlag(env[DISABLE_BUNDLED_SKILLS_COMPAT_ENV_VAR])
}

/**
 * The settings-file half, read off an already-loaded config object.
 *
 * Only the JSON boolean `true` counts. A restricting switch reads its own
 * enforcing pole on a malformed value elsewhere in this package, but this one
 * is a plain user preference with no managed tier yet, so an unrecognised value
 * is simply "not set" rather than an error that would take the whole config
 * layer down.
 */
export function bundledSkillsDisabledBySetting(config: unknown): boolean {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
  return (config as Record<string, unknown>)[DISABLE_BUNDLED_SKILLS_SETTING_KEY] === true
}

/**
 * The composed switch: either half turns it on, and neither can turn the other
 * off. Same "tighter wins" direction `resolveWorkflowSettings` applies to
 * `disableWorkflows`, because this is the same kind of restriction.
 */
export function bundledSkillsDisabled(
  config: unknown,
  env: BundledSkillsEnvRecord = process.env,
): boolean {
  return bundledSkillsDisabledBySetting(config) || bundledSkillsDisabledByEnv(env)
}
