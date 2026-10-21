/**
 * What a plugin mutation did to a live session's runtime (P2.107).
 *
 * A module of its OWN, holding two type declarations and importing nothing, for
 * a measured reason: `session-manager-interface.ts` and the `plugin-runtime-refresh`
 * RPC helper both need this vocabulary, and declaring it in `SessionManager.ts`
 * made them import from that module for the first time. `import type` still
 * pulls a file into the checker's program, so that single edge dragged the
 * whole of `SessionManager.ts` into `packages/shared`'s typecheck — which runs
 * with stricter options than `packages/server-core`'s own — and surfaced
 * ELEVEN pre-existing latent errors (`noUncheckedIndexedAccess` shapes in
 * `getLastFinalAssistantMessageId`, the durable-approval sweep, source
 * loading) in code no row had touched. A vocabulary file with no imports of its
 * own cannot do that to anybody.
 */

/**
 * - `applied`   — the session was between turns, its runtime was torn down and
 *                 its capability snapshot rebuilt: the plugin is LIVE.
 * - `deferred`  — a turn was in flight, so the refresh is parked on the session
 *                 and flushes at the next turn boundary; until then that turn
 *                 still holds the previous paths.
 * - `untouched` — there was no runtime to refresh. NOT a deferral: the next turn
 *                 builds its snapshot from the mutated state, so nothing stale
 *                 is held and nothing needs refreshing.
 * - `reloaded`  — P6.412. The session's own runtime reloaded its plugins in
 *                 place (`Query.reloadPlugins()`), so the plugin is live WITHOUT
 *                 a teardown. Distinguished from `applied` because it is the
 *                 only outcome with a cost the user should be told about:
 *                 `plugins/loading.md#check-which-stage-a-plugin-reached`
 *                 — "Reloading has a token cost on the next request".
 */
export type PluginRuntimeRefreshOutcome = 'applied' | 'deferred' | 'untouched' | 'reloaded'

/** {@link PluginRuntimeRefreshOutcome} counted across every session a mutation touched. */
export interface PluginRuntimeRefreshSummary {
  applied: number
  deferred: number
  untouched: number
  /**
   * P6.412 — sessions whose runtime took the RUNTIME'S OWN reload rather than a
   * teardown. Optional so every existing producer and every existing test keeps
   * meaning exactly what it meant; absent reads as zero.
   */
  reloaded?: number
  /**
   * F1.265 — sessions whose refresh THREW (a strict dispose that failed), each named with its error in
   * `failures`. Both keys are absent when nothing failed, so every all-success summary is byte-identical to the
   * one before F1.265. A summary with `failed` is never a success: see {@link pluginRuntimeRefreshFailure}.
   */
  failed?: number
  failures?: Array<{ sessionId: string; error: string }>
  /**
   * F1.407 — present only on a summary SCOPED to one workspace (`answerForWorkspaceId`) whose refresh also touched
   * other workspaces' sessions, and only when something failed: how many of those sessions there were and how many
   * failed, as bare counts. Their ids, errors and outcome counts are not in the summary at all.
   */
  otherWorkspaces?: { sessions: number; failed: number }
}

/**
 * F1.265 — the error a caller throws for a summary with `failed` sessions, carrying the WHOLE summary so the
 * sessions that did apply are not lost with it. Its message is the first failure's own error, which keeps a
 * single-session failure's text exactly what the rejected refresh used to carry
 * (`codex-runtime-session-disposal-failed`, F1.211's reading).
 */
export function pluginRuntimeRefreshFailure(summary: PluginRuntimeRefreshSummary): Error & { summary: PluginRuntimeRefreshSummary } {
  return Object.assign(new Error(summary.failures?.[0]?.error ?? 'plugin-runtime-refresh-failed'), { summary })
}

/**
 * F1.407 + F1.408 (origin WJ-ff verifier on F1.265, 2026-09-23; DECIDED by the controller the same day) — the
 * failure half of a refresh summary, SCOPED to the workspace whose model will read it.
 *
 * A global plugin mutation refreshes every workspace's live sessions, and `SessionManager.afterAgentPluginMutation`
 * throws the summary to the agent tool that asked, which relays it to the model (`runtimeRefreshSessions`). So
 * workspace B's session ids reached workspace A's model (F1.407), and an id repeated across workspaces read as the
 * wrong session (F1.408). `failures` holds only the asking workspace's sessions; the rest are `otherWorkspaces`,
 * two bare numbers. `failed` is present whenever ANYTHING failed — zero when only another workspace did — so the
 * caller still reports a failed refresh; and an unscoped caller (`otherFailed` and `otherSessions` both zero) gets
 * exactly the shape F1.265 produced, byte for byte.
 */
export function refreshFailureFields(
  failures: NonNullable<PluginRuntimeRefreshSummary['failures']>,
  otherFailed: number,
  otherSessions: number,
): Pick<PluginRuntimeRefreshSummary, 'failed' | 'failures' | 'otherWorkspaces'> {
  if (failures.length === 0 && otherFailed === 0) return {}
  return {
    failed: failures.length,
    failures,
    ...(otherSessions > 0 ? { otherWorkspaces: { sessions: otherSessions, failed: otherFailed } } : {}),
  }
}
