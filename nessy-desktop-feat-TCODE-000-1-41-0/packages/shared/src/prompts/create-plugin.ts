/**
 * Plugin-creation macro prompt for the `/create-plugin` command and the browse
 * "Create ▾ → Create plugin" menu item (plan: ecosystem-1_10_0 C2).
 *
 * The prompt body is adapted VERBATIM where it fits from the openai/codex
 * `plugin-creator` bundled creator skill (Apache-2.0). C3 finalizes the source +
 * license record in `docs/architecture/pi-extension-adoption-scorecard.md`
 * (candidate source: github.com/openai/codex bundled `plugin-creator` skill).
 * Nessy-specific parts — targeting OUR plugin bundle manifest
 * (`nessy-extension.json`), OUR global scaffold root (`~/.nessy-agent/`), and OUR
 * existing local-folder install path — are written in our own words. No
 * Codex/Claude provider labels persisted.
 *
 * Mechanism: `/create-plugin` is a PROMPT MACRO, not a tool (exact `/init`
 * precedent). The renderer expands this constant into a normal user message; the
 * agent interviews the user, scaffolds the plugin bundle through the NORMAL
 * permission-gated Write path, and installs it locally through the EXISTING
 * plugin-management install path (the same repository/local-folder install the
 * "Add plugin" URL flow uses). The macro grants no elevated access and adds no
 * new tool.
 *
 * The bundled `plugin-creator` skill (C3 authors its SKILL.md body) carries the
 * full bundle-layout and install guidance; this macro points the agent at that
 * skill by name so the interactive flow and the bundled skill stay one source of
 * truth for authoring convention.
 */

/** The bundled built-in skill this macro drives (C3 authors its SKILL.md). */
export const CREATE_PLUGIN_CREATOR_SKILL_NAME = 'plugin-creator';

/** The plugin bundle manifest filename Nessy installs from. */
export const CREATE_PLUGIN_MANIFEST_FILENAME = 'nessy-extension.json';

/**
 * The user-message body `/create-plugin` (and the Create ▾ → Create plugin menu
 * item) expands to. Adapted verbatim-where-fits from the openai/codex
 * `plugin-creator` skill (Apache-2.0). Kept English by design, like the other
 * prompt constants here.
 */
export const CREATE_PLUGIN_PROMPT = `Help me create a new plugin. Use the bundled ${CREATE_PLUGIN_CREATOR_SKILL_NAME} skill as your guide for the bundle layout and install steps.

First interview me to ground the plugin in a real need: what capabilities should the plugin bundle (skills, prompt commands, MCP servers, or a mix), when should it be used, and what configuration does it require? Ask clarifying questions before writing anything; do not invent a purpose I did not ask for.

A plugin is a folder containing a ${CREATE_PLUGIN_MANIFEST_FILENAME} manifest describing the bundle, plus the component files it ships (for example a skill's SKILL.md, prompt-command markdown, or MCP server config). Choose a short, lowercase, hyphenated name and scaffold the bundle into a folder under ~/.nessy-agent/ through your normal file-writing tool so it goes through the usual approval. Keep the bundle minimal — include only the components the plugin genuinely needs.

Once the bundle is scaffolded, install it locally through the existing plugin install flow (the same local-folder / repository install the "Add plugin" flow uses) rather than any new mechanism, and fix anything the install reports. Confirm clearly when the plugin is created and installed.`;
