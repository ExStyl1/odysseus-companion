/**
 * The two host-side skill gates — P6.384 (denominator L17, L58).
 *
 * Both are read where the skill listing and the skill body are composed
 * (`BaseAgent`), which is the one seam all three runtimes share: the host owns
 * the skill catalogue for Pi, claude and codex alike (`prompt-builder.ts`:
 * "the host owns the skill catalog for all three backends … codex is told about
 * skills only through this listing"), so one predicate here is one behaviour
 * everywhere rather than three that drift.
 *
 * ## `disableSkillShellExecution` — the vendor's own key, spelled its way
 *
 * NOT invented. It is in the shipped binary and in the vendored SDK's settings
 * schema (`sdk.d.ts`), described there verbatim:
 *
 * > Disable inline shell execution in skills and custom slash commands from
 * > user, project, or plugin sources. Commands are replaced with a placeholder
 * > instead of being run.
 *
 * The binary reads it from BOTH tiers — `if(dn("policySettings")?.disableSkillShellExecution===!0)return!0;
 * return ka().disableSkillShellExecution===!0` — so it is a managed key over
 * there as well. Measured in `claude-agent-sdk-darwin-arm64/claude`: 4
 * occurrences, against `Cookie` 82 and `git-subdir` 37 as positive controls.
 *
 * **And "replaced with a placeholder" is the behaviour, not a paraphrase**, which
 * is why {@link SKILL_SHELL_EXECUTION_DISABLED_PLACEHOLDER} exists and why the
 * gate does not simply skip the render: leaving the author's `` !`cmd` `` text
 * in the body would hand the model a shell instruction to run itself, which is
 * the one thing `skills.md` says must not happen.
 *
 * Settings-only, deliberately: the binary reads no environment alias for it and
 * `env-vars.md` names none, so adding a `NESSY_…` spelling would be inventing a
 * surface the documented one does not have.
 *
 * **It gates a SECOND surface here, and this line is the disclosure (P6.361).**
 * Beside the skill body, this key also decides whether a saved workspace action
 * — a project's own named command, launched from the app's header — may run at
 * all: `workspaceActionsDisabled` in `config/workspace-actions.ts` is this
 * predicate, and `getWorkspaceActions` answers `[]` while it is on, so the menu
 * disappears rather than offering something that would be refused. The reading
 * is deliberate rather than convenient: the key's documented subject is *"inline
 * shell execution in skills and custom slash commands from user, project, or
 * plugin sources"*, and a saved user command the app runs on a click is the same
 * class of thing under a different button — an operator who turned that off did
 * not mean "except from the toolbar", and a second key would let the two answer
 * differently, which is how a kill switch stops being one.
 *
 * The residue, stated because it is a real narrowing: an operator who wants
 * saved actions but not `!`-syntax in skills cannot express that today. That
 * needs its own key and its own row, not a widened reading of this one.
 *
 * ## `disableSkills` — ours, because the vendor has none
 *
 * Measured in the same binary: `disableAllSkills` **0**, `disableSkills` **0**,
 * against the same two controls. The nearest documented key is
 * `disableBundledSkills`, which is narrower by its own words — it removes the
 * skills shipped WITH the product and says "Skills from plugins,
 * `.claude/skills/`, and `.claude/commands/` are unaffected". A session-wide off
 * switch is a different question, so it gets a different key rather than a
 * widened reading of that one.
 *
 * Named under the owner rule for a silent documentation (2026-08-28): decided
 * rather than queued, and written down here. The name is the vendor's own
 * `disable…` family shape so an operator meets one vocabulary; it hides skills
 * from the MODEL listing and leaves `[skill:name]` dispatch alone, which is the
 * same split `disable-model-invocation` already draws one level down.
 *
 * **The command half of that switch is NOT here, and the reason is a
 * measurement rather than an omission.** There is no host-side model-visible
 * COMMAND listing to empty: our prompt carries `<available_skills>` and nothing
 * equivalent for slash commands, so on Pi and codex the model is never handed a
 * command list in the first place. Claude's own listing is behind its CLI's
 * `disableSlashCommands` — real in the binary (17 occurrences) but a LAUNCH
 * option we cannot reach, since it appears **0** times in `sdk.d.ts` and the
 * Agent SDK is the only door we have. Recorded so the next reader does not
 * re-derive it.
 */

/** The vendor's spelling, kept exactly (`sdk.d.ts`, and the binary's own read). */
export const DISABLE_SKILL_SHELL_EXECUTION_SETTING_KEY = 'disableSkillShellExecution'

/** Ours; the vendor has no counterpart (measured — see this file's header). */
export const DISABLE_SKILLS_SETTING_KEY = 'disableSkills'

/**
 * What an inline `` !`<command>` `` becomes when execution is gated off.
 *
 * It names the KEY that did it, because the person who meets this text — in a
 * transcript, in a bug report, in the model's own reply — has no other route
 * back to the cause. Model-facing text, so English (i18n rule 3), like every
 * other marker in a skill body.
 */
export const SKILL_SHELL_EXECUTION_DISABLED_PLACEHOLDER =
  `[shell execution disabled by ${DISABLE_SKILL_SHELL_EXECUTION_SETTING_KEY}]`

function settingIsTrue(config: unknown, key: string): boolean {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
  return (config as Record<string, unknown>)[key] === true
}

/**
 * Is inline shell execution in skill bodies off for this session?
 *
 * Only the JSON boolean `true` counts, on `bundled-skills-settings.ts`'s rule:
 * an unrecognised value is "not set" rather than an error that would take the
 * whole config layer down.
 */
export function skillShellExecutionDisabled(config: unknown): boolean {
  return settingIsTrue(config, DISABLE_SKILL_SHELL_EXECUTION_SETTING_KEY)
}

/** Is the model's skill listing off for this session? Same rule. */
export function skillListingDisabled(config: unknown): boolean {
  return settingIsTrue(config, DISABLE_SKILLS_SETTING_KEY)
}
