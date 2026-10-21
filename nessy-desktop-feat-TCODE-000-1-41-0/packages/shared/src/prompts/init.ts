/**
 * Project-instructions scaffold prompt for the `/init` command (plan:
 * prompt-and-review-parity I1).
 *
 * The prompt body is adapted VERBATIM where it fits from the openai/codex init
 * template (`codex-rs/tui/prompt_for_init_command.md`, Apache-2.0). See
 * `docs/architecture/pi-extension-adoption-scorecard.md` for the source +
 * license record. Nessy-specific parts (targeting `AGENTS.md` as our project
 * context filename, and the inspect-first / append-not-overwrite wording tied
 * to our filesystem-scoped, permission-gated tools) are written in our own
 * words.
 *
 * Mechanism: `/init` is a PROMPT MACRO, not a tool. The renderer expands this
 * constant into a normal user message; the agent then inspects the repo with
 * its EXISTING read tools and writes the file through the NORMAL
 * permission-gated Write path. Project context files (`AGENTS.md`, `CLAUDE.md`)
 * are only loaded for trusted projects, and the write obeys the active
 * permission mode — the macro grants no elevated access.
 *
 * `AGENTS.md` is the primary project context file Nessy reads (see
 * `getProjectContextFilesPrompt` / `CONTEXT_FILE_PATTERNS` in
 * `prompts/system.ts`), so `/init` targets it.
 */

/** The project context filename `/init` scaffolds. */
export const INIT_PROJECT_INSTRUCTIONS_FILENAME = 'AGENTS.md';

/**
 * The user-message body `/init` expands to. Adapted verbatim-where-fits from
 * the openai/codex init template (Apache-2.0). Kept English by design, like the
 * other prompt constants in this folder.
 */
export const INIT_PROJECT_INSTRUCTIONS_PROMPT = `Generate a file named ${INIT_PROJECT_INSTRUCTIONS_FILENAME} at the root of this project that serves as a contributor guide for both humans and coding agents.

First inspect the repository to ground every statement in what is actually here: read the existing project files, the build system and package manifests, the test setup, any README or docs, and existing guidance files (${INIT_PROJECT_INSTRUCTIONS_FILENAME}, CLAUDE.md, README). Do not invent commands, conventions, or structure that you cannot verify in the repo.

Before writing, check whether ${INIT_PROJECT_INSTRUCTIONS_FILENAME} already exists at the project root. If it does, do NOT overwrite or replace it — read it, preserve the useful existing instructions, and offer to append or improve it in place instead. Only create a new file when none exists.

Title the document "Repository Guidelines". Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project:

- Project Structure & Module Organization
- Build, Test, and Development Commands (with a one-line description of what each command does)
- Coding Style & Naming Conventions
- Testing Guidelines
- Commit & Pull Request Guidelines
- Security & Configuration Tips (only if relevant)

Use Markdown headings (#, ##) for structure. Keep the document concise: 200-400 words is optimal. Keep explanations short, direct, and specific to this repository, and maintain a professional, instructional tone. Write the file through your normal file-writing tool so it goes through the usual approval, and keep the change scoped to this file only.`;
