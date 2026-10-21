/**
 * Pure render-mode decision for the chat-input MODEL list.
 *
 * The integration is deliberately NOT one of these outcomes any more. It used
 * to be — mode `switcher` rendered a provider → connection → model tree, and a
 * tap on a model nested under another connection changed the integration and
 * the model at once. That single gesture is what forced the runtime question
 * to be inferred from where the tap landed. The integration now has its own
 * row (`ConnectionRow`) above this list, so the two gestures cannot be
 * confused and the confirmation attaches to exactly one control.
 *
 * Precedence (highest first):
 *   1. unavailable   — the active connection is gone / errored
 *   2. locked-single — the active connection offers one model; render it as a
 *                      label rather than a list of one
 *   3. flat          — the active connection's models
 *
 * The #727 trap — a single-model `pi_compat` connection making the switcher
 * unreachable, because `switcher` and `locked-single` competed for precedence
 * — stops existing rather than being worked around: with only these three
 * outcomes there is no ordering left to get wrong.
 */

export type PickerMode = 'unavailable' | 'locked-single' | 'flat'

export interface PickerModeInput {
  connectionUnavailable: boolean
  /** Non-null when the active connection is `pi_compat` with ≤1 model. */
  connectionDefaultModel: string | null
}

export function derivePickerMode(input: PickerModeInput): PickerMode {
  if (input.connectionUnavailable) return 'unavailable'
  if (input.connectionDefaultModel != null) return 'locked-single'
  return 'flat'
}
