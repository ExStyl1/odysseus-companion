import { hasTerminalReasonNotice, type AgentTerminalReason, type AgentTerminalReasonWithNotice } from '@nessy-agent/core/types'

/**
 * The transcript verdict marker's structural helpers live in `@nessy-agent/core`
 * (beside `AgentTerminalReason`) so `packages/ui`'s turn grouping can share the
 * exact same string — see the constant's comment there. Re-exported here so
 * renderer callers keep one import site for the whole terminal-reason surface;
 * this module adds only the i18n layer on top.
 */
export {
  TERMINAL_REASON_MARKER,
  terminalReasonMarker,
  parseTerminalReasonMarker,
  hasTerminalReasonNotice,
} from '@nessy-agent/core/types'

/**
 * The reasons that have copy, and ONLY those.
 *
 * `TERMINAL_REASON_VALUES` (`core/types/message.ts`) carries the vocabulary;
 * the members listed in `TERMINAL_REASON_NOTICE_VALUES` are the stops a user is
 * otherwise told nothing about, and those are the ones `chat.terminalReason.*`
 * exists for. The rest are deliberately absent because each already owns a
 * surface that says more than a one-line verdict could: `user_stop` renders the
 * interrupt row, `plan_submitted` the plan card, `auth_request` the auth card,
 * `redirect` / `source_activated` the follow-up turn they start, and the
 * remaining host-side endings (`hook_loop_cap`, `permission_hook_interrupt`,
 * `auto_compaction_thrashing`, `timeout`, `internal_error`) reach the
 * transcript as their own error or info notices. Adding a verdict line beside
 * those would be a second sentence about one event, which is the noise this row
 * exists to avoid — not an oversight.
 *
 * P2.525 — that exemption used to name `tool_deferred` and
 * `tool_deferred_unavailable` too, and for those two it was FALSE. An ordinary
 * deferral is a SUCCESS result with `is_error: false`, so it produced no error
 * notice and no info notice: the turn simply ended, the tool never ran, and
 * nothing on any surface said so. The unavailable ending sets `terminalIsError`,
 * which this fork reads for cost accounting alone. Both now have copy, because
 * a deferral is a promise to come back and a promise nobody was told about is
 * indistinguishable from a lost turn.
 *
 * A reason with no entry here renders NOTHING: a new terminal reason must be
 * silent until someone writes it copy, never a raw enum value shown to a user.
 *
 * P2.98 — WHICH reasons those are is no longer decided here. The server now
 * persists the same row so it survives a reload, which makes it a second writer
 * of the same marker, and membership has to be one fact rather than two copies
 * of one. `AgentTerminalReasonWithNotice` (`core/types/message.ts`) is that
 * fact; typing the map as a TOTAL `Record` over it means adding a reason there
 * without copy here fails the build, and dropping copy for one still listed
 * there fails it too. Only the i18n keys stayed renderer-side, which is the
 * only half a renderer should own.
 */
const NOTICE_KEY_BY_REASON: Record<AgentTerminalReasonWithNotice, string> = {
  max_agent_turns: 'chat.terminalReason.maxAgentTurns',
  max_budget_usd: 'chat.terminalReason.maxBudgetUsd',
  max_budget_tokens: 'chat.terminalReason.maxBudgetTokens',
  structured_output_retry_exhausted: 'chat.terminalReason.maxStructuredOutputRetries',
  provider_error: 'chat.terminalReason.providerError',
  provider_refusal: 'chat.terminalReason.providerRefusal',
  tool_deferred: 'chat.terminalReason.toolDeferred',
  tool_deferred_unavailable: 'chat.terminalReason.toolDeferredUnavailable',
}

/** The i18n key for a terminal reason, or `undefined` when it has no copy. */
export function terminalReasonNoticeKey(
  reason: AgentTerminalReason | undefined,
): string | undefined {
  return hasTerminalReasonNotice(reason) ? NOTICE_KEY_BY_REASON[reason] : undefined
}
