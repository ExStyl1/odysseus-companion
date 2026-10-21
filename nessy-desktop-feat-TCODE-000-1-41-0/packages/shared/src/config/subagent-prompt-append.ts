/**
 * P6.314 (H34) — one operator knob that appends text to EVERY subagent's system
 * prompt.
 *
 * ## Native mechanism, asked per runtime before anything was built
 *
 * - **claude** — the vendored 2.1.247 binary carries the CLI flag
 *   `--append-subagent-system-prompt` (5 lines / 6 occurrences, positive control
 *   `ultracode` -> 43/156) and its internal identifier
 *   `appendSubagentSystemPrompt` (15/51) — re-measured 2026-09-12 (C3.252), both
 *   instruments named because they disagree on a minified artefact (C3.294); the
 *   2.1.233 reading was 7 / 135 / 24. It publishes NO environment spelling: both
 *   `CLAUDE_CODE_APPEND_SUBAGENT_SYSTEM_PROMPT` and
 *   `APPEND_SUBAGENT_SYSTEM_PROMPT` score 0 on the same file.
 * - **codex** — `MultiAgentV2ConfigToml.subagent_developer_instructions` is the
 *   native equivalent, and the V2 surface it belongs to is not enabled here.
 * - **Pi** — none. Subagent prompts are composed by our own spawner.
 *
 * So no runtime offers a single append-to-all knob and the HOST is the seam,
 * which is native-first step 2. The variable NAME is therefore ours, exactly as
 * `NESSY_PLAN_MODE_EFFORT`'s was for the same reason (P6.368) — there is no
 * documented spelling to be compatible with, and a compat alias invented here
 * would claim a contract the binary does not publish.
 *
 * ## What this deliberately does NOT do
 *
 * It does not narrow, gate or filter the text. The knob is an operator's, the
 * value is prose, and a host that edited it would be inventing a policy no page
 * describes. What it DOES refuse is an exported-but-blank value, the rule every
 * explicit-only reader in this tree follows: an empty variable is an accident
 * (an unset shell expansion, a settings `env` block spelling "leave it alone"),
 * not a request to append nothing.
 */

/** Our own spelling. The binary publishes no environment name to alias. */
export const SUBAGENT_PROMPT_APPEND_ENV_VAR = 'NESSY_APPEND_SUBAGENT_SYSTEM_PROMPT'

export type SubagentPromptAppendEnvRecord = Record<string, string | undefined>

/**
 * The operator's append text, or `undefined` when none was set.
 *
 * Trimmed at the edges only: interior newlines are the operator's own
 * paragraphing and are the reason this is a prompt fragment rather than a
 * setting. A value that is only whitespace reads as unset.
 */
export function resolveSubagentPromptAppend(
  env: SubagentPromptAppendEnvRecord = process.env,
): string | undefined {
  const raw = env[SUBAGENT_PROMPT_APPEND_ENV_VAR]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
