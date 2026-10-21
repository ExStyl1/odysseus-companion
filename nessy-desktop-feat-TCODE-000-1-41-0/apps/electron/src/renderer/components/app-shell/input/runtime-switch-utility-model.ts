/**
 * P3.70 — the utility model a switch silently re-resolves.
 *
 * ## The defect
 *
 * `LlmConnection.miniModel` is a per-CONNECTION field, and behind it sits
 * `getMiniModel`'s provider-aware heuristic. It feeds the tiers the user never
 * picks a model for: session titles, summaries, mini completions. Switching
 * integration therefore re-picks it — and until this module the pre-switch
 * dialog reported only the MAIN model, so a user who deliberately chose a cheap
 * side model neither kept it nor was told.
 *
 * ## Why a module and not four lines in the dialog
 *
 * So the rule can be driven without rendering a Radix dialog: the interesting
 * behaviour is the three SILENCES below, and a rule that decides when NOT to
 * speak is exactly the kind that rots unobserved.
 *
 * ## The expression is the host's own
 *
 * `getMiniModel(conn) ?? conn.defaultModel` — the same one every call site in
 * this class hands the backend as `config.miniModel`, so the dialog and the
 * runtime name one value rather than two derivations.
 *
 * ## The caveat, deliberate and licensed by the page
 *
 * `getMiniModel` narrows its candidates through the managed model allowlist,
 * and that allowlist lives in a PROCESS registry whose only writer is the host
 * bootstrap (`setManagedModelPolicy`). In the renderer it is always absent, so
 * on a managed install this can name the un-narrowed pick.
 * `model-config.md#surface-coverage` accepts precisely that for a picker:
 *
 * > The model pickers on claude.ai and in the Desktop app hide or grey out
 * > models excluded by your organization's allowlist. The picker state is a
 * > convenience for users; enforcement happens in the session.
 *
 * The AUTHORITATIVE report is the host's own post-switch notice, which runs
 * where the registry is populated. This is the pre-switch convenience, which is
 * why its sentence says the side model "changes" and never claims enforcement.
 */
import { getMiniModel, type LlmConnection } from '@config/llm-connections'

/** The two ends of a side-model change, both resolved and different. */
export interface UtilityModelChange {
  from: string
  to: string
}

/** The connection fields the resolution reads — `LlmConnectionWithStatus` has them all. */
export type UtilityModelConnection = Pick<
  LlmConnection,
  'models' | 'providerType' | 'piAuthProvider' | 'miniModel' | 'defaultModel'
>

/**
 * The side model on one connection, by the host's own expression.
 *
 * Exported so a test can drive the two ends independently of the comparison.
 */
export function resolveUtilityModel(connection: UtilityModelConnection): string | undefined {
  return getMiniModel(connection) ?? connection.defaultModel
}

/**
 * Does this switch change the side model, and to what?
 *
 * `null` — say nothing — in three cases, and each is a different refusal:
 *
 *  - there is no source connection to compare against;
 *  - either end does not resolve. A line naming `undefined` on one side reads
 *    as *"your side model was removed"*, which is a different claim and a false
 *    one;
 *  - the two agree. The common case — all three gateway cards are seeded from
 *    one catalogue — and a dialog that announces a change that is not one
 *    teaches the user to skip the dialog.
 */
export function resolveUtilityModelChange(
  from: UtilityModelConnection | null | undefined,
  to: UtilityModelConnection,
): UtilityModelChange | null {
  if (!from) return null
  const fromModel = resolveUtilityModel(from)
  const toModel = resolveUtilityModel(to)
  if (!fromModel || !toModel) return null
  if (fromModel === toModel) return null
  return { from: fromModel, to: toModel }
}
