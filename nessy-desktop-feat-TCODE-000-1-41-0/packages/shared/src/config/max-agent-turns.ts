/**
 * The operator's agentic-turn ceiling, on the runtime that is our own harness
 * (P6.490, tier 1).
 *
 * ## The gap
 *
 * `env-vars.md#variables`, verbatim: "`CLAUDE_CODE_MAX_TURNS` | Cap the number
 * of agentic turns when no explicit limit is passed. Equivalent to passing
 * `--max-turns`, which takes precedence when both are set. A value that is not
 * a positive integer is rejected at startup with an error rather than treated
 * as no cap".
 *
 * On claude-runtime this binds because `buildClaudeSubprocessEnv` spreads
 * `process.env` and the vendored binary reads the name itself. On Pi it bound
 * nothing: `PiAgent.getMaxAgentTurns` read only
 * `workspaceDefaults.maxAgentTurns`, and an absent or zero value meant NO CAP —
 * so an administrator who set the documented variable got a bounded claude
 * session and an unbounded Pi one, from the same environment, with nothing
 * saying so. That asymmetry is tier 1's whole shape, and the owner's Q26
 * ruling closes it by CONSEQUENCE: this is the turn-budget consequence.
 *
 * ## Precedence follows the page, and the mapping is the load-bearing part
 *
 * The page's "explicit limit" is `--max-turns`, a per-invocation flag that
 * outranks the variable. Our analogue is `workspaceDefaults.maxAgentTurns` —
 * the value the user configured for this workspace, which is likewise a
 * deliberate choice rather than an environment default. So a positive
 * configured value WINS and the variable is not consulted at all; the variable
 * fills the hole where no cap was chosen. Reading it the other way round would
 * let an administrator's floor silently override a user's own higher limit,
 * which is not what the sentence says.
 *
 * ## One place where we deliberately differ, and it is a product posture
 *
 * The page ends its row with "rejected at startup with an error rather than
 * treated as no cap". A desktop session cannot refuse to start over an
 * environment variable, and making it do so is an owner's decision rather than
 * a lane's. What we CAN honour is the clause's intent — a malformed value must
 * not silently become "no cap" — so the rejection is REPORTED by name and
 * value through the caller's diagnostic sink, and the session keeps the
 * behaviour it had. Visible instead of silent; the refusal-at-startup half is
 * recorded here rather than invented.
 *
 * ## The Guardian judge keeps its own cap (F1.828, owner decision 2026-09-26)
 *
 * `PiAgent.getMaxAgentTurns` composes this cap with a Pi child's own declared
 * `maxTurns`, and the lower one wins (`capAgentTurnsByChildDefinition`,
 * `agent/pi-agent.ts`, F1.83). There is one exception: the Guardian judge child. The
 * host marks it the same way everywhere (`isHostConsultChildConfig`, `agent/base-agent.ts`):
 * its prompt starts with `GUARDIAN_POLICY_PROMPT`. For that child the value
 * returned here is NOT consulted, and the child keeps its own `maxTurns`
 * (`GUARDIAN_JUDGE_MAX_TURNS`, `agent/core/guardian-judge-core.ts`).
 *
 * Why: the page's own sentence limits the variable to "when no explicit limit
 * is passed", and the judge's definition passes one. Before this change, an
 * operator value from 1 to 7 left the judge fewer round trips than its prompt
 * needs to investigate and answer. It ended `unsure`, so every judged `auto`
 * action became a card again (F1.817's symptom). That failed safe, but it
 * turned the auto mode off without saying so. Neither native judge has a turn
 * cap. Claude's auto classifier is one model request (`permission-modes.md`,
 * the section "How the classifier evaluates actions": "Tool results are
 * stripped from those requests"). codex's guardian reviewer has only a shared
 * deadline (`ext/guardian-reviewer/src/lib.rs` at `rust-v0.156.1`: a 90 s
 * `REVIEW_TIMEOUT`). Whether Claude's `--max-turns` reaches subagents is not
 * documented: `sub-agents.md` names only the subagent's own `maxTurns`. That
 * null is recorded in the F1.828 decision analysis.
 *
 * The residue is bounded. The judge's cost is still limited by its own 8 and
 * its 60 s deadline. The exemption never goes above
 * `GUARDIAN_JUDGE_MAX_TURNS`. A workspace agent whose own body starts with the
 * policy text also passes the identity check (the documented residue), but it
 * gets at most the judge's 8, never a larger value of its own. If it declares
 * no `maxTurns` at all, it keeps this cap. The one product change: an operator
 * can no longer set a judge below 8 turns. That is the owner's decision
 * (option (a) of the analysis).
 *
 * ## The parse
 *
 * `env-vars.md#variables`, the paragraph opening the Variables list: "Numeric
 * variables such as timeouts, token budgets, and retry counts accept scientific
 * notation and digit-separator spellings in addition to plain digits, except
 * where a variable's row notes it takes plain digits only." A turn cap is a
 * count rather than a timeout or a token budget, and its row notes no
 * restriction, so the general rule governs and `resolveNumericSetting` is used
 * as the MCP output limit uses it. `min: 1` is the page's own "positive
 * integer".
 */

import { resolveNumericSetting } from './numeric-setting'

export type MaxAgentTurnsEnvRecord = Record<string, string | undefined>

/** The Nessy spelling, as `background-task-settings.ts` records its family. */
export const MAX_AGENT_TURNS_ENV = 'NESSY_MAX_AGENT_TURNS'

/** The documented Claude spelling, accepted as a compat alias. */
export const MAX_AGENT_TURNS_COMPAT_ENV = 'CLAUDE_CODE_MAX_TURNS'

/** What both this module and `PiAgent` mean by "no cap". */
export const NO_AGENT_TURN_CAP = 0

/**
 * The effective agentic-turn cap.
 *
 * @param configured the workspace's own `maxAgentTurns`, which is this fork's
 *   `--max-turns`: a positive value takes precedence and the environment is not
 *   consulted.
 * @returns a positive integer cap, or {@link NO_AGENT_TURN_CAP} for no cap.
 */
export function resolveMaxAgentTurns(
  configured: number | undefined,
  env: MaxAgentTurnsEnvRecord = process.env,
  write?: (message: string) => void,
): number {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  // Presence decides which name is read, and the SAME choice names the value in
  // the rejection sentence.
  const name = env[MAX_AGENT_TURNS_ENV] !== undefined
    ? MAX_AGENT_TURNS_ENV
    : MAX_AGENT_TURNS_COMPAT_ENV;
  return resolveNumericSetting(name, env[name], NO_AGENT_TURN_CAP, { min: 1 }, write);
}
