/**
 * Reading a turn-ending provider verdict out of Pi's own error message
 * (P6.443, denominators M4/M5).
 *
 * **The row's native clause is CORRECTED here, and the correction is what makes
 * this a step-1 row rather than a step-3 one.** It reads *"none as a refusal —
 * the gateway is OpenAI-wire, whose `finish_reason` vocabulary has no `refusal`
 * member at all (nearest is `content_filter`), and the only reader in the
 * harness is the stall detector."* The first half is right about the wire and
 * wrong about the harness: the installed `@earendil-works/pi-ai` already reads
 * `finish_reason` in `mapStopReason` and turns every non-terminal member into
 * `{ stopReason: "error", errorMessage: "Provider finish_reason: <reason>" }`.
 * So the signal does reach us, in a stable spelling minted by the runtime — it
 * simply arrived as an untyped string and ended the turn with no verdict at
 * all, which is the silence M4/M5 record.
 *
 * We therefore read what Pi already produces rather than building a second
 * channel down from the wire. `nestor-reasoning-proxy.ts` sees `finish_reason`
 * too, but only on the Nestor gateway path — a reader there would cover one
 * provider, and this one covers every OpenAI-wire provider Pi can talk to.
 */

import type { AgentTerminalReason } from '@nessy-agent/core/types';

/** The exact prefix `mapStopReason` mints. Matching it is what keeps this from
 * claiming a verdict over unrelated provider errors (a 500, a socket hang-up),
 * which end the turn with `stopReason: "error"` too and are NOT finish reasons. */
const PI_FINISH_REASON_PREFIX = 'Provider finish_reason: ';

/**
 * Map a Pi assistant-message error into the shared terminal vocabulary.
 *
 * - `content_filter` is the OpenAI wire's own refusal member — content was
 *   withheld by the provider's filter — so it is the one member that earns
 *   `provider_refusal`.
 * - every OTHER finish reason (`network_error`, and anything a provider invents
 *   that Pi passes through unrecognised) earns `provider_error`: we know the
 *   turn ended abnormally and we do NOT know it was a refusal, and saying so is
 *   the honest half.
 * - anything that is not one of Pi's finish-reason messages returns undefined
 *   and the turn keeps whatever verdict it already had — silence stays silence
 *   here rather than becoming a guess.
 */
export function terminalReasonFromPiErrorMessage(
  errorMessage: string | undefined,
): AgentTerminalReason | undefined {
  if (!errorMessage || !errorMessage.startsWith(PI_FINISH_REASON_PREFIX)) return undefined;
  const reason = errorMessage.slice(PI_FINISH_REASON_PREFIX.length).trim();
  if (!reason) return undefined;
  return reason === 'content_filter' ? 'provider_refusal' : 'provider_error';
}

/**
 * F1.297 — whether the `agent_end` closing this attempt may carry the verdict
 * read off its error. Not when another authority already stamped one (the
 * thrashing guard, the structured-output loop), and not when the SDK reports
 * `willRetry: true`: pi-coding-agent computes that flag from the SAME failed
 * message (`_willRetryAfterAgentEnd` → `isRetryableAssistantError`, which
 * matches `network.?error`), and then really runs another attempt
 * (`_prepareRetry` → `continue()`). A verdict there is a verdict on an attempt
 * the SDK is about to replace, and every reader downstream treats it as final —
 * F1.235's host machine lets an own-side verdict win over `willRetry`, and the
 * structured-output loop stands down on it — so the retried answer was dropped.
 * The pending verdict is still SPENT (cleared) on this `agent_end`: the retried
 * attempt re-arms its own from its own `message_end` if it fails the same way,
 * and the exhausted ladder's last `agent_end` carries `willRetry: false`.
 */
export function mayStampProviderVerdict(agentEnd: { terminalReason?: unknown; willRetry?: unknown }): boolean {
  return !agentEnd.terminalReason && agentEnd.willRetry !== true;
}
