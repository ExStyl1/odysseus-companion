/**
 * Skill-creation macro prompt for the `/create-skill` command and the add-skill
 * EditPopover seed (plan: ecosystem-1_10_0 C2).
 *
 * The prompt body is adapted VERBATIM where it fits from the openai/codex
 * `skill-creator` bundled creator skill (Apache-2.0). C3 finalizes the source +
 * license record in `docs/architecture/pi-extension-adoption-scorecard.md`
 * (candidate source: github.com/openai/codex bundled `skill-creator` skill).
 * Nessy-specific parts — targeting OUR on-disk skill schema (a `<slug>/SKILL.md`
 * with YAML frontmatter `name`/`description` + markdown instructions), OUR
 * global skills root (`~/.nessy-agent/skills/`), OUR skill docs
 * (`~/.nessy-agent/docs/skills.md`), and OUR validation tool (`skill_validate`)
 * — are written in our own words. No Codex/Claude provider labels persisted.
 *
 * Mechanism: `/create-skill` is a PROMPT MACRO, not a tool (exact `/init`
 * precedent). The renderer expands this constant into a normal user message; the
 * agent interviews the user, then scaffolds the skill through the NORMAL
 * permission-gated Write path and verifies it with the existing `skill_validate`
 * tool. The macro grants no elevated access and adds no new tool.
 *
 * The bundled `skill-creator` skill (C3 authors its SKILL.md body) carries the
 * full step-by-step authoring guidance; this macro points the agent at that
 * skill by name so the interactive flow and the bundled skill stay one source of
 * truth for authoring convention.
 */

/** The bundled built-in skill this macro drives (C3 authors its SKILL.md). */
export const CREATE_SKILL_CREATOR_SKILL_NAME = 'skill-creator';

/** The global skills root a created skill is scaffolded into. */
export const CREATE_SKILL_SKILLS_ROOT = '~/.nessy-agent/skills/';

/**
 * The user-message body `/create-skill` (and the add-skill EditPopover) expands
 * to. Adapted verbatim-where-fits from the openai/codex `skill-creator` skill
 * (Apache-2.0). Kept English by design, like the other prompt constants here.
 */
export const CREATE_SKILL_PROMPT = `Help me create a new skill. Use the bundled ${CREATE_SKILL_CREATOR_SKILL_NAME} skill as your guide for the authoring conventions and steps.

First interview me to ground the skill in a real need: what should the skill do, when should it trigger (the description is what the agent matches on, so make it specific and action-oriented), and what instructions or examples does it need to be useful? Ask clarifying questions before writing anything; do not invent a purpose I did not ask for.

A skill is a folder ${CREATE_SKILL_SKILLS_ROOT}<slug>/ containing a SKILL.md file. SKILL.md has YAML frontmatter with two required fields — name and description — followed by markdown instructions. Choose a short, lowercase, hyphenated slug that matches the name. Follow the patterns in ~/.nessy-agent/docs/skills.md.

Scaffold the skill into ${CREATE_SKILL_SKILLS_ROOT}<slug>/SKILL.md through your normal file-writing tool so it goes through the usual approval. Keep the instructions concise, direct, and specific to the task; add any supporting asset files the skill genuinely needs, and nothing more.

After writing the skill, call skill_validate with the skill slug to confirm the SKILL.md file is valid, and fix anything it reports. Confirm clearly when the skill is created and validated.`;
