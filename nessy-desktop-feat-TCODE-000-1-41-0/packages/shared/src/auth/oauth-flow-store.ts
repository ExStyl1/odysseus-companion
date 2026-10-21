/**
 * OAuthFlowStore — in-memory store for pending OAuth flows.
 *
 * Lives server-side. Never serialized, never sent to clients.
 * Keyed by `state` (CSRF token) for O(1) lookup on oauth:complete.
 * 5-minute TTL with lazy + periodic cleanup.
 *
 * Single flight (UB3.10, upstream v0.15.1): the newest flow per
 * (workspace, source) is indexed so `oauth:start` can let a second caller JOIN
 * it instead of opening another browser sign-in. Ended flows leave a
 * short-lived outcome for the clients that joined them (they poll
 * `oauth:status`). Our ownership model is kept on top: takes still go through
 * `takeByStateMatching` (flow-id + owner + request binding), and the
 * single-flight index is maintenance-only — a taken flow stops being joinable
 * immediately.
 */

import type { LoadedSource } from '../sources/types.ts';
import type { OAuthProvider } from './oauth-flow-types.ts';

const FLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // sweep every minute
/** How long a joined client can still read how a flow ended (it polls every couple of seconds). */
const OUTCOME_TTL_MS = 2 * 60 * 1000;

const EXPIRED: OAuthFlowOutcome = { success: false, error: 'The sign-in expired before it was completed.' };
const SIGN_IN_CANCELLED: OAuthFlowOutcome = { success: false, error: 'The sign-in was cancelled.' };

function sourceKey(workspaceId: string, sourceSlug: string): string {
  return `${workspaceId}\u0000${sourceSlug}`;
}

/** A caller that asked to sign in to a source while a flow for it was already live. */
export interface OAuthFlowWaiter {
  clientId: string;
  sessionId?: string;
  authRequestId?: string;
}

/** How a flow ended, as reported to the clients that joined it. */
export interface OAuthFlowOutcome {
  success: boolean;
  error?: string;
  email?: string;
}

export type OAuthFlowStatus =
  | { live: true; expiresInMs: number }
  | { live: false; outcome?: OAuthFlowOutcome };

export interface PendingOAuthFlow {
  flowId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  /** Source target. Absent for a plugin-server flow (`pluginServer` set). */
  source?: LoadedSource;
  /**
   * C3 (capability-path): plugin-server target. The completed exchange stores
   * into the server's GLOBAL plugin credential slot; `sourceSlug` carries the
   * serverName as display/binding identity only.
   */
  pluginServer?: { pluginKey: string; serverName: string };
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  /** Server-only RFC 8707 protected-resource indicator. */
  oauthResource?: string;
  provider: OAuthProvider;

  /**
   * Optional server-owned revocation/binding check run immediately before the
   * token exchange. Kept only in this in-memory store and never serialized.
   */
  validateBeforeExchange?: () => Promise<void>;
  /** Shared plugin lifecycle/trust authority for an atomic revalidate + exchange. */
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;

  // Binding fields — validated on oauth:complete
  ownerClientId: string;
  workspaceId: string;
  sourceSlug: string;

  // Optional session binding (when initiated from auth request card)
  sessionId?: string;
  authRequestId?: string;

  /** Callers that joined this flow instead of starting their own (UB3.10). */
  waiters: OAuthFlowWaiter[];

  createdAt: number;
  expiresAt: number;
}

export interface OAuthFlowRequestBinding {
  workspaceId: string;
  sessionId: string;
  authRequestId: string;
  sourceSlug: string;
}

export type OAuthFlowTakeExpectation =
  | { kind: 'state-bearer' }
  | {
      kind: 'owner';
      flowId: string;
      ownerClientId: string;
      workspaceId: string;
      /** Omitted for COMPLETE; null requires an explicitly unbound flow. */
      requestBinding?: OAuthFlowRequestBinding | null;
    };

export type OAuthFlowTakeResult =
  | { status: 'taken'; flow: PendingOAuthFlow }
  | { status: 'missing' }
  | { status: 'mismatch'; reason: 'flow-id' | 'owner' | 'request' };

export class OAuthFlowStore {
  private flows = new Map<string, PendingOAuthFlow>();
  private requestIndex = new Map<string, string>();
  /** (workspace, source) → state of the newest flow for it (UB3.10 single flight). */
  private liveBySource = new Map<string, string>();
  /** flowId → how it ended, for joined clients polling oauth:status. */
  private outcomes = new Map<string, OAuthFlowOutcome & { workspaceId: string; endedAt: number }>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  store(flow: PendingOAuthFlow): void {
    if (this.getByState(flow.state)) {
      throw new Error('OAuth flow state already exists');
    }
    const requestKey = this.requestKey(flow);
    if (requestKey) {
      const activeState = this.requestIndex.get(requestKey);
      if (activeState && this.getByState(activeState)) {
        throw new Error('OAuth request already has an active flow');
      }
    }
    this.flows.set(flow.state, flow);
    if (requestKey) this.requestIndex.set(requestKey, flow.state);
    // UB3.10: the newest flow for a (workspace, source) is the one new callers join.
    this.liveBySource.set(sourceKey(flow.workspaceId, flow.sourceSlug), flow.state);
  }

  getByState(state: string): PendingOAuthFlow | null {
    const flow = this.flows.get(state);
    if (!flow) return null;

    // Check expiry lazily — an expired flow ENDS like any other (UB3.10):
    // joined clients read the outcome instead of a bare miss.
    if (Date.now() > flow.expiresAt) {
      this.remove(state, EXPIRED);
      return null;
    }

    return flow;
  }

  takeByState(state: string): PendingOAuthFlow | null {
    const result = this.takeByStateMatching(state, { kind: 'state-bearer' });
    return result.status === 'taken' ? result.flow : null;
  }

  takeByStateMatching(
    state: string,
    expectation: OAuthFlowTakeExpectation,
  ): OAuthFlowTakeResult {
    const flow = this.flows.get(state);
    if (!flow) return { status: 'missing' };

    if (Date.now() > flow.expiresAt) {
      this.remove(state, EXPIRED);
      return { status: 'missing' };
    }

    if (expectation.kind === 'owner') {
      if (flow.flowId !== expectation.flowId) {
        return { status: 'mismatch', reason: 'flow-id' };
      }
      if (
        flow.ownerClientId !== expectation.ownerClientId
        || flow.workspaceId !== expectation.workspaceId
      ) {
        return { status: 'mismatch', reason: 'owner' };
      }
      if (expectation.requestBinding !== undefined) {
        const requestBinding = expectation.requestBinding;
        const matchesRequest = requestBinding === null
          ? !flow.sessionId && !flow.authRequestId
          : flow.workspaceId === requestBinding.workspaceId
            && flow.sessionId === requestBinding.sessionId
            && flow.authRequestId === requestBinding.authRequestId
            && flow.sourceSlug === requestBinding.sourceSlug;
        if (!matchesRequest) {
          return { status: 'mismatch', reason: 'request' };
        }
      }
    }

    this.deleteFlow(state, flow);
    this.maintainLiveBySource(flow);
    return { status: 'taken', flow };
  }

  hasLiveByRequest(binding: OAuthFlowRequestBinding): boolean {
    const requestKey = this.requestKey(binding);
    const now = Date.now();
    for (const [state, flow] of this.flows) {
      if (this.requestKey(flow) !== requestKey) continue;
      if (now > flow.expiresAt) {
        this.deleteFlow(state, flow);
        continue;
      }
      return true;
    }
    return false;
  }

  takeByRequest(binding: OAuthFlowRequestBinding): PendingOAuthFlow[] {
    const taken: PendingOAuthFlow[] = [];
    for (const [state, flow] of this.flows) {
      if (this.requestKey(flow) !== this.requestKey(binding)) continue;
      this.deleteFlow(state, flow);
      taken.push(flow);
    }
    return taken;
  }

  /** The live flow a new sign-in for this source should join, if any (UB3.10). */
  getLiveForSource(workspaceId: string, sourceSlug: string): PendingOAuthFlow | null {
    const state = this.liveBySource.get(sourceKey(workspaceId, sourceSlug));
    return state ? this.getByState(state) : null;
  }

  /** Record a caller waiting on a live flow. Returns the flow, or null if it is gone. */
  join(state: string, waiter: OAuthFlowWaiter): PendingOAuthFlow | null {
    const flow = this.getByState(state);
    if (!flow) return null;
    const known = flow.waiters.some(w =>
      w.clientId === waiter.clientId && w.sessionId === waiter.sessionId && w.authRequestId === waiter.authRequestId,
    );
    if (!known) flow.waiters.push(waiter);
    return flow;
  }

  remove(state: string, outcome: OAuthFlowOutcome = SIGN_IN_CANCELLED): PendingOAuthFlow | null {
    const flow = this.flows.get(state);
    if (!flow) return null;
    this.deleteFlow(state, flow);
    this.maintainLiveBySource(flow);
    this.outcomes.set(flow.flowId, { ...outcome, workspaceId: flow.workspaceId, endedAt: Date.now() });
    return flow;
  }

  /**
   * Record how a TAKEN flow settled (UB3.10): our takes are atomic and happen
   * before the token exchange, so completion records the outcome after the
   * settle — the flow is already out of the map, only the joined clients'
   * `oauth:status` polls read this.
   */
  recordOutcome(flow: Pick<PendingOAuthFlow, 'flowId' | 'workspaceId'>, outcome: OAuthFlowOutcome): void {
    this.outcomes.set(flow.flowId, { ...outcome, workspaceId: flow.workspaceId, endedAt: Date.now() });
  }

  /** Whether a flow is still live, or how it ended — scoped to the caller's workspace (UB3.10). */
  getStatus(flowId: string, workspaceId: string): OAuthFlowStatus {
    for (const flow of this.flows.values()) {
      if (flow.flowId !== flowId || flow.workspaceId !== workspaceId) continue;
      if (this.getByState(flow.state)) return { live: true, expiresInMs: flow.expiresAt - Date.now() };
      break;
    }
    const ended = this.outcomes.get(flowId);
    if (!ended || ended.workspaceId !== workspaceId) return { live: false };
    const { success, error, email } = ended;
    return { live: false, outcome: { success, error, email } };
  }

  /** Prune expired entries. Called on interval + lazily on access. */
  cleanup(): void {
    const now = Date.now();
    for (const flow of Array.from(this.flows.values())) {
      if (now > flow.expiresAt) {
        // An expired flow ENDS like any other: joined clients read the outcome.
        this.remove(flow.state, EXPIRED);
      }
    }
    for (const [flowId, ended] of this.outcomes) {
      if (now - ended.endedAt > OUTCOME_TTL_MS) this.outcomes.delete(flowId);
    }
  }

  /** Stop the periodic cleanup timer (for graceful shutdown). */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.flows.clear();
    this.requestIndex.clear();
    this.liveBySource.clear();
    this.outcomes.clear();
  }

  /** Number of pending flows (for diagnostics). */
  get size(): number {
    return this.flows.size;
  }

  /**
   * UB3.10 single-flight maintenance: when `flow` leaves the map, the
   * (workspace, source) slot must stop pointing at it. Another flow for the
   * source may still be live (an older client, or a restart race started one
   * too) — new callers then join the newest of those, exactly as upstream's
   * `end` does.
   */
  private maintainLiveBySource(flow: PendingOAuthFlow): void {
    const key = sourceKey(flow.workspaceId, flow.sourceSlug);
    if (this.liveBySource.get(key) !== flow.state) return;
    let next: PendingOAuthFlow | undefined;
    const now = Date.now();
    for (const other of this.flows.values()) {
      if (sourceKey(other.workspaceId, other.sourceSlug) !== key || now > other.expiresAt) continue;
      if (!next || other.createdAt >= next.createdAt) next = other;
    }
    if (next) this.liveBySource.set(key, next.state);
    else this.liveBySource.delete(key);
  }

  private requestKey(binding: Partial<OAuthFlowRequestBinding>): string | null {
    if (!binding.workspaceId || !binding.sessionId || !binding.authRequestId || !binding.sourceSlug) {
      return null;
    }
    return JSON.stringify([
      binding.workspaceId,
      binding.sessionId,
      binding.authRequestId,
      binding.sourceSlug,
    ]);
  }

  private deleteFlow(state: string, flow: PendingOAuthFlow): void {
    this.flows.delete(state);
    const requestKey = this.requestKey(flow);
    if (requestKey && this.requestIndex.get(requestKey) === state) {
      this.requestIndex.delete(requestKey);
    }
  }
}

/**
 * Create a PendingOAuthFlow with default TTL.
 * Convenience helper used by the oauth:start handler.
 */
export function createPendingFlow(
  params: Omit<PendingOAuthFlow, 'createdAt' | 'expiresAt' | 'waiters'> & { waiters?: OAuthFlowWaiter[] }
): PendingOAuthFlow {
  const now = Date.now();
  return {
    ...params,
    waiters: params.waiters ?? [],
    createdAt: now,
    expiresAt: now + FLOW_TTL_MS,
  };
}
