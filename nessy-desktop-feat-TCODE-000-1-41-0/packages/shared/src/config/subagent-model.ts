/**
 * The subagent model override.
 *
 * `model-config.md#environment-variables`, the `CLAUDE_CODE_SUBAGENT_MODEL`
 * row, quoted whole and re-read 2026-09-05:
 *
 * > | `CLAUDE_CODE_SUBAGENT_MODEL`     | The default model for
 * > [subagents](/docs/en/sub-agents#choose-a-model), [agent
 * > team](/docs/en/agent-teams#specify-teammates-and-models) teammates, and
 * > [workflow](/docs/en/workflows) agents that aren't assigned a model another
 * > way. Accepts an alias such as `haiku` or a full model name. A
 * > per-invocation model or a definition's `model` field, including `inherit`,
 * > takes precedence. To change that, set
 * > [`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`](/docs/en/sub-agents#run-every-subagent-on-one-model) |
 *
 * ## The precedence INVERTED, and since 0.3.267 the bundle agrees (P6.154, F1.588)
 *
 * This docblock previously quoted the row as it read at `model-config.md:611`,
 * ending *"and overrides the per-invocation `model` parameter and the subagent
 * definition's `model` frontmatter"* — the OPPOSITE of the sentence above. The
 * page now says the definition's field WINS, and introduces
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` for operators who want the old behaviour.
 * The line number is gone too, which is why the citation is a section anchor
 * plus the verbatim row.
 *
 * **Through 2.1.251 the vendored binary had NOT caught up**, and this block said
 * so: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` scored **0/0** (lines/occurrences,
 * C3.294's two instruments) against `CLAUDE_CODE_SUBAGENT_MODEL` 5/9 and
 * `ANTHROPIC_API_KEY` 77/139 at 2.1.247 (C3.252), and a binary that had never
 * heard of FORCE could not implement the rule FORCE exists to escape — so an
 * exported variable could outrank the `model` we put on an agent definition.
 *
 * **At 2.1.267 (the F1.255 lift, both self-reports) it has.** FORCE scores 14/17
 * by the same two instruments, and F1.588 DROVE the order on the vendored binary
 * rather than grepping it: with the variable set, a definition `model` won;
 * without one, the variable did; with FORCE=1, the variable beat the definition;
 * with nothing set, the main model ran. That is the page's order arm for arm,
 * which is why `applySubagentModelOverride` (`agent/options.ts`) now projects our
 * spelling unconditionally. The counts are readings with dates; the drive is the
 * evidence. And the AGENTS.md union rule ran in reverse here: the guard derived
 * from the BUNDLE is retired because the bundle now matches the DOCUMENTATION —
 * the documentation is the denominator for what we must accept, the bundle for
 * what the runtime does today, and on this knob the two finally say the same
 * thing.
 *
 * Consequence for P6.154, recorded so nobody re-derives it: the bundled agents'
 * tier is mapped onto `AgentDefinition.model` and NOT onto this variable —
 * one variable cannot express three tiers — and the tier arms hold both
 * spellings unset, because a set variable would decide the assertion instead of
 * the code under test.
 *
 * The second document moved the same way, so the pair no longer says what this
 * block used to conclude from it. `workflows.md` § *Model selection* now reads,
 * verbatim (re-read 2026-09-05):
 *
 * > Claude Code picks each workflow agent's model in the same [order it uses
 * > for subagents](/docs/en/sub-agents#choose-a-model). A model the script
 * > names for a stage counts as the per-invocation model in that order. When
 * > nothing else assigns one, the agent runs on your session's model.
 *
 * It used to read *"Every agent in a workflow uses your session's model unless
 * the script routes a stage to a different one or the
 * `CLAUDE_CODE_SUBAGENT_MODEL` environment variable is set, which overrides
 * both"*. So the sentence this file drew its rule from — "two documents, one
 * rule: this outranks BOTH delegated model inputs" — is gone from both pages,
 * and that conclusion is REFUTED as a statement about the documented contract.
 * It survives only as a statement about the binary we ship, for the version
 * reason measured above.
 *
 * `inherit` is not a model name and is deliberately resolved here rather than
 * at the call site: it means "there is no override", so it must not reach the
 * managed allowlist check and be reported as a refused model.
 */

export type SubagentModelEnvRecord = Record<string, string | undefined>

/** The Nessy spelling. */
export const SUBAGENT_MODEL_ENV_VAR = 'NESSY_SUBAGENT_MODEL'

/** The documented Claude spelling, accepted as a compat alias. */
export const SUBAGENT_MODEL_COMPAT_ENV_VAR = 'CLAUDE_CODE_SUBAGENT_MODEL'

/**
 * The operator's model for every delegated child, or `undefined` when normal
 * resolution applies.
 *
 * Follows the `isCronDisabled` precedent for an aliased pair: the Nessy name
 * wins when both are present. An empty or whitespace-only value is `undefined`
 * — an exported-but-blank variable is an accident, not a request for a model
 * with no name.
 */
export function resolveSubagentModelOverride(
  env: SubagentModelEnvRecord = process.env,
): string | undefined {
  const raw = env[SUBAGENT_MODEL_ENV_VAR] !== undefined
    ? env[SUBAGENT_MODEL_ENV_VAR]
    : env[SUBAGENT_MODEL_COMPAT_ENV_VAR]
  const value = (raw ?? '').trim()
  if (value.length === 0) return undefined
  // "Set to `inherit` to use normal model resolution instead."
  if (value === 'inherit') return undefined
  return value
}

/**
 * The documented FORCE knob (`sub-agents.md#run-every-subagent-on-one-model`,
 * re-read 2026-09-06, HTTP 200):
 *
 * > `CLAUDE_CODE_SUBAGENT_MODEL` is a default, so a subagent's definition or a
 * > model Claude passes still takes precedence over it. To apply one model to
 * > every subagent, teammate, and workflow agent, also set
 * > `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` to `1`. Requires Claude Code v2.1.257 or
 * > later.
 *
 * There is deliberately NO Nessy spelling of this one. The pair is a compat
 * surface: the Nessy name exists for the value because an operator sets it in
 * our own config, and the FORCE knob only ever appears beside the Claude
 * spelling in the settings `env` block the page's example shows. One name is
 * less to keep in step, and a second alias would be a mechanism we invented.
 */
export const SUBAGENT_MODEL_FORCE_ENV_VAR = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'

/**
 * True when the operator asked for the override to outrank the delegated model
 * inputs — the pre-v2.1.251 order, restored on purpose.
 *
 * The page documents the value as `1`; the usual truthy spellings are accepted
 * for the same reason `isRetryWatchdogEnabled` accepts them.
 *
 * Note the asymmetry the page states and this function preserves: FORCE alone,
 * with no model named, is NOT an error and NOT a model — *"If you set only
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, subagents run on the main conversation's
 * model."* So callers read this flag only to decide the ORDER, never to decide
 * the value.
 */
export function isSubagentModelOverrideForced(
  env: SubagentModelEnvRecord = process.env,
): boolean {
  const raw = env[SUBAGENT_MODEL_FORCE_ENV_VAR]
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}
