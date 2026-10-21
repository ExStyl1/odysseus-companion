/**
 * IOAuthFlowStore — abstract interface for the pending OAuth flow store.
 *
 * Handlers program against this; concrete implementations satisfy it.
 * See OAuthFlowStore in @nessy-agent/shared/auth for the canonical impl.
 */

import type {
  OAuthFlowOutcome,
  OAuthFlowRequestBinding,
  OAuthFlowStatus,
  OAuthFlowTakeExpectation,
  OAuthFlowTakeResult,
  OAuthFlowWaiter,
  PendingOAuthFlow,
} from '@nessy-agent/shared/auth'

export interface IOAuthFlowStore {
  store(flow: PendingOAuthFlow): void
  getByState(state: string): PendingOAuthFlow | null
  /** UB3.10: the live flow a new sign-in for this source should join, if any. */
  getLiveForSource(workspaceId: string, sourceSlug: string): PendingOAuthFlow | null
  /** UB3.10: record a caller waiting on a live flow instead of starting its own. */
  join(state: string, waiter: OAuthFlowWaiter): PendingOAuthFlow | null
  takeByState(state: string): PendingOAuthFlow | null
  takeByStateMatching(
    state: string,
    expectation: OAuthFlowTakeExpectation,
  ): OAuthFlowTakeResult
  hasLiveByRequest(binding: OAuthFlowRequestBinding): boolean
  takeByRequest(binding: OAuthFlowRequestBinding): PendingOAuthFlow[]
  /** UB3.10: ending records how the flow ended, so joined clients learn it. */
  remove(state: string, outcome?: OAuthFlowOutcome): PendingOAuthFlow | null
  /** UB3.10: record how a TAKEN flow settled (our takes remove the flow first). */
  recordOutcome(flow: Pick<PendingOAuthFlow, 'flowId' | 'workspaceId'>, outcome: OAuthFlowOutcome): void
  /** UB3.10: still live, or how it ended — scoped to the caller's workspace. */
  getStatus(flowId: string, workspaceId: string): OAuthFlowStatus
}
