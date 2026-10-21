/**
 * Guardian consult state machine (plan: guardian-command-judge G2).
 *
 * The deterministic `permission-service` stays the ONLY permission authority.
 * In `auto` mode, the existing rule tiers classify a proposed
 * shell/network/MCP-mutation action into allow / BORDERLINE (would ask) /
 * ask-or-deny. Only the BORDERLINE band — the exact set that resolves to ASK
 * today — consults the guardian judge, with ONE exemption: the three check
 * classes the owner moved to the classifier on 2026-08-22 (P2.3 in
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` — dangerous
 * `rm`, background jobs, suspicious Windows paths). All three are exempt in
 * `auto`; in `plan`, and under the preconditions spelled out below, the
 * dangerous-`rm` class ALONE is. No other mode. Dangerous `rm` is a FLOOR,
 * outside the band by construction, and it is consulted anyway wherever the
 * gate has marked its prompt `autoClassifierAdjudicated`; the reasoning and the
 * upstream reconciliation live on the removal-circuit-breaker comment
 * (`pre-tool-use.ts`, the block whose second paragraph reads "It is NOT skipped
 * by `allow-all`, it is ADJUDICATED BY THE CLASSIFIER IN `auto` (and, under the
 * `:577` row's preconditions, in `plan`)" — quote it, not the number, when the
 * file moves).
 * The other two have no floor and reach the band through
 * `auto-classifier-bands.ts`, and stay `auto`-only.
 *
 * `plan` joined the exemption on 2026-08-23 (P2.21, OQ-1 resolved ALIGN) for
 * the removal class ALONE, because the page routes it there itself —
 * `permission-modes.md:577`: "Asks you to approve it. With auto mode available
 * during planning and no bypass permissions available, sends it to the
 * classifier instead". Plan's own shell band already consulted — that band is
 * the page's sentence "When auto mode is available and the
 * `useAutoModeDuringPlan` setting is on, which it is by default, the classifier
 * reviews shell commands during planning instead of prompting you", which the
 * 2026-08-23 fetch puts at `:240`; the sentence is the anchor and the number is
 * only a convenience (`:156` is a UI-label table row on that same fetch). What
 * is new is that one floor now reaches this file from plan too, under the two
 * preconditions `planClassifierEligible` (pi-agent.ts) checks. Outside those
 * two modes this file's remit is byte-for-byte what it was. This module owns
 * the host-side glue that keeps that consult cheap and bounded:
 *
 *  - a per-session verdict cache keyed by (normalized action, cwd), invalidated
 *    on mode switch (via `modeVersion`); a judge failure never enters it (F1.742);
 *  - a per-turn circuit breaker (Codex pattern): 3 consecutive judge denies, or
 *    10 within the last 50 consulted actions, stops consulting for the rest of
 *    the turn and falls the whole band back to asking the user;
 *  - a per-turn guardian deny loop-guard so a model re-issuing a judge-denied
 *    action cannot loop forever (the H1 hook loop-cap only counts HOOK denies,
 *    which guardian denies are not — this is the parallel guard);
 *  - a post-denial override set (Codex precedence): once the user explicitly
 *    approves a judge-denied action, that exact (action, cwd) is never
 *    re-consulted for the rest of the session — the human wins.
 *
 * NONE of these can widen an action: the guardian only converts a "would ask"
 * into allow/deny inside the band — or, under the `auto`/`plan` exemption
 * above, a "would prompt unconditionally" into the same two — and otherwise
 * falls back to ask. A missing port, a disabled setting, an open circuit, an
 * `unsure` verdict, or any judge failure all resolve to the band's existing ASK
 * behavior, and for the exempt classes to the exact prompt they would have
 * shown — fail-closed to a human, never to auto-run.
 *
 * A port that resolves NOTHING — `null`/`undefined` where a verdict object was
 * promised — belongs to that same judge-failure list and is not an exception to
 * it (P2.20). It used to be one: the value flowed past `runJudge`'s catch into
 * `applyVerdict`'s `switch (verdict.verdict)`, whose TypeError escaped `consult`
 * entirely, and the host's un-awaited dispatch turned that into a tool call that
 * was never answered — a HANG, not a fail-closed prompt. `runJudge` now
 * normalizes it to `unsure` + `malformed` at the source, so it asks, it is
 * marked to the user as a judge FAILURE rather than an honest `unsure`, and it
 * advances the breaker's window like any other consult.
 */

import type {
  GuardianJudgeInput,
  GuardianVerdict,
  GuardianVerdictResult,
} from '../../prompts/guardian.ts';
import type { GuardianRunResult } from './guardian-judge-core.ts';

export type { GuardianRunResult } from './guardian-judge-core.ts';

/**
 * The judge runner as seen by the host: server-core's `createGuardianJudgePort` over
 * `runGuardianJudgeCore` (F1.829: pi-agent-server's `runGuardianJudge` has no production
 * caller). It spawns a read-only child session through the host-owned child-session
 * authority, never the subprocess spawner. Injected via `CoreBackendConfig.guardianJudgePort`.
 *
 * ANY failure the runner cannot classify still resolves to `verdict: 'unsure'`
 * with a `failure` tag (the runner's fail-closed contract), so the host never
 * has to catch here — but `consult` guards against a throwing port too, and
 * against one that resolves no verdict object at all (P2.20).
 */
export interface GuardianJudgePort {
  judge(request: {
    input: GuardianJudgeInput;
    cwd: string;
    /** Judge model id; when omitted the runner resolves the gateway `fast` alias. */
    modelId?: string;
    signal?: AbortSignal;
  }): Promise<GuardianRunResult>;
}

/**
 * The permission-relevant outcome the host applies after consulting. This is
 * NOT a decision — it only tells `handlePreToolUseRequest` which branch of the
 * EXISTING permission flow to take. `allow`/`deny` still travel through
 * `permissionService.authorize`, which mints the receipt (the audit record).
 */
export type GuardianConsultOutcome =
  | { kind: 'allow'; verdict: GuardianRunResult }
  | { kind: 'deny'; verdict: GuardianRunResult; diagnostic: string; fresh?: boolean }
  | { kind: 'ask'; reason: GuardianAskReason; verdict?: GuardianRunResult; diagnostic?: string };

/** Why the consult fell back to asking the user (all fail-closed to a human). */
export type GuardianAskReason =
  | 'disabled' // no port / setting off
  | 'override' // user already approved this exact action — skip the judge
  | 'circuit-open' // circuit breaker tripped this turn
  | 'unsure' // judge could not decide confidently
  | 'failure' // judge timed out / errored / returned malformed output
  | 'mode-changed'; // the permission mode moved while the judge was running (P6.204)

/** 3 consecutive judge denies in one turn trips the breaker (Codex). */
export const GUARDIAN_CONSECUTIVE_DENY_LIMIT = 3;
/** …or 10 denies within the last 50 consulted actions in one turn. */
export const GUARDIAN_WINDOW_DENY_LIMIT = 10;
export const GUARDIAN_WINDOW_SIZE = 50;
/**
 * A model re-issuing the SAME judge-denied (action, cwd) this many times in one
 * turn is looping — stop the turn. Mirrors the hook loop-guard threshold.
 */
export const GUARDIAN_DENY_LOOP_LIMIT = 3;
/**
 * Hard cap on the session-scoped verdict cache. A long session judging many
 * distinct (action, cwd) pairs must not grow the map without bound; evict the
 * least-recently-used entry on write (delete+set = move-to-end, the T1/L1
 * precedent). The cache is only a cost/latency optimization — evicting an entry
 * costs one extra judge call, never a correctness change.
 */
export const GUARDIAN_VERDICT_CACHE_MAX = 200;
/**
 * Hard cap on the session-scoped denied-action set (the arming record for a
 * post-denial human override). Bounded for the same reason as the cache; over
 * the cap the oldest denial is forgotten, which only means a later human
 * approval of that specific action would not auto-arm the override — the action
 * is simply re-judged, never widened.
 */
export const GUARDIAN_DENIED_SET_MAX = 200;

/** Stable digest of an action for the cache/loop keys. Injected so the host reuses its hasher. */
export type ActionHasher = (action: GuardianJudgeInput['action']) => string;

/** Options for {@link GuardianConsultState.consult}. */
export interface GuardianConsultParams {
  input: GuardianJudgeInput;
  cwd: string;
  modeVersion: number;
  modelId?: string;
  signal?: AbortSignal;
  /**
   * Reads the session's LIVE mode version, called once after the judge answers
   * (P6.204). `modeVersion` above is the version at consult ENTRY; this is the
   * version when the answer arrives, and a difference between the two means the
   * verdict was reached under a mode that no longer holds. Optional so a caller
   * with no mode of its own (tests, a future non-session consult) keeps today's
   * behaviour explicitly rather than by omission.
   */
  readModeVersion?: () => number;
}

/**
 * Per-agent (per-session) guardian consult state. One instance lives on the
 * PiAgent host. Turn-scoped counters reset at the turn boundary via
 * {@link resetTurn}; the verdict cache is session-scoped but invalidated when
 * the mode changes.
 */
export class GuardianConsultState {
  private readonly cache = new Map<string, GuardianRunResult>();
  private cacheModeVersion: number | undefined;
  /** Actions the user explicitly approved after a judge deny — never re-consulted. */
  private readonly overrides = new Set<string>();
  /**
   * Session-scoped set of every (action, cwd) the judge has DENIED this session.
   * Unlike the per-turn `denyLoopCounts`, this survives `resetTurn` so the host
   * can recognize a later human approval of a previously judge-denied action —
   * even when it reaches the human on a later turn (via the circuit breaker,
   * loop-guard fallback, or an allow-all downgrade-to-ask). The host queries it
   * with {@link wasDenied} on a user-approved prompt to arm the post-denial
   * override. Bounded like the cache: a session denying many distinct actions
   * must not grow it without bound (eviction only relaxes the override arming,
   * never widens a decision — the action would simply be re-judged).
   */
  private readonly denied = new Set<string>();

  // Per-turn circuit-breaker + loop-guard state.
  private consecutiveDenies = 0;
  private recentDenies: boolean[] = [];
  private circuitOpen = false;
  private readonly denyLoopCounts = new Map<string, number>();

  constructor(
    private readonly hashAction: ActionHasher,
    private readonly port: GuardianJudgePort | undefined,
    private readonly enabled: boolean = true,
  ) {}

  /** Whether the guardian is wired and enabled at all (no port / setting off => never consults). */
  get active(): boolean {
    return this.enabled && this.port !== undefined;
  }

  private key(action: GuardianJudgeInput['action'], cwd: string): string {
    return `${this.hashAction(action)}\u0000${cwd}`;
  }

  /** Turn boundary: clear per-turn circuit-breaker + loop-guard state. */
  resetTurn(): void {
    this.consecutiveDenies = 0;
    this.recentDenies = [];
    this.circuitOpen = false;
    this.denyLoopCounts.clear();
  }

  /**
   * Record that the user explicitly approved a previously judge-denied action
   * through the normal ask flow (Codex precedence). That exact (action, cwd) is
   * never re-consulted for the rest of the session. The arming record is dropped
   * — once overridden the human has won and there is nothing left to re-arm.
   */
  recordPostDenialOverride(action: GuardianJudgeInput['action'], cwd: string): void {
    const key = this.key(action, cwd);
    this.overrides.add(key);
    this.denied.delete(key);
  }

  /**
   * Whether the judge has DENIED this exact (action, cwd) earlier in the
   * session. The host calls this when a user APPROVES a permission prompt: a
   * true result means the human is overriding a prior guardian deny, so the host
   * arms {@link recordPostDenialOverride}. Session-scoped (survives `resetTurn`).
   */
  wasDenied(action: GuardianJudgeInput['action'], cwd: string): boolean {
    return this.denied.has(this.key(action, cwd));
  }

  /** LRU-on-write insert into the bounded denied-action set. */
  private recordDenied(key: string): void {
    this.denied.delete(key);
    this.denied.add(key);
    if (this.denied.size > GUARDIAN_DENIED_SET_MAX) {
      const oldest = this.denied.values().next().value;
      if (oldest !== undefined) this.denied.delete(oldest);
    }
  }

  /** Invalidate the verdict cache when the session mode changes. */
  private syncMode(modeVersion: number): void {
    if (this.cacheModeVersion !== modeVersion) {
      this.cache.clear();
      this.cacheModeVersion = modeVersion;
    }
  }

  /**
   * Consult the guardian for one borderline action. Returns the outcome the
   * host applies. Never throws — a throwing/absent port resolves to ask.
   */
  async consult(params: GuardianConsultParams): Promise<GuardianConsultOutcome> {
    this.syncMode(params.modeVersion);
    const key = this.key(params.input.action, params.cwd);

    // Human precedence: an approved action is never re-judged.
    if (this.overrides.has(key)) {
      return { kind: 'ask', reason: 'override' };
    }
    if (!this.active) {
      return { kind: 'ask', reason: 'disabled' };
    }
    if (this.circuitOpen) {
      return { kind: 'ask', reason: 'circuit-open' };
    }

    const cached = this.cache.get(key);
    const fromCache = cached !== undefined;
    const verdict = cached ?? (await this.runJudge(params));

    // P6.204 — `syncMode` above runs at consult ENTRY, so until now a verdict
    // AWAITED across a mode switch was cached and applied under a mode that had
    // already been replaced. A judge call is seconds long and a mode switch is a
    // keystroke, so the window is real rather than theoretical.
    //
    // Discard it: the verdict never enters the cache, and the call falls back to
    // the human, which is the only re-decision available at this layer and is a
    // TIGHTENING in every direction (the host gate may only tighten — see
    // `shouldAllowToolInMode`'s own rule). The cache is cleared and re-stamped
    // here too, so the next consult does not re-clear it for the same reason.
    //
    // Only on a FRESH verdict: a cache hit did not cross the switch — it was
    // already invalidated at entry by `syncMode` if the version had moved.
    if (!fromCache) {
      const liveModeVersion = params.readModeVersion?.();
      if (liveModeVersion !== undefined && liveModeVersion !== params.modeVersion) {
        this.cache.clear();
        this.cacheModeVersion = liveModeVersion;
        return { kind: 'ask', reason: 'mode-changed' };
      }
    }
    // LRU-on-write: delete+set moves the entry to the end; over the cap the oldest (Map order =
    // insertion order) is evicted. F1.742: only a DECISION is cached, never a judge FAILURE (timeout,
    // spawn-error, malformed, aborted): it is transient, so the next identical action asks the judge
    // again (errors.md#auto-mode-cannot-determine-the-safety-of-an-action: "retrying works").
    if (!verdict.failure) { this.cache.delete(key); this.cache.set(key, verdict); }
    if (this.cache.size > GUARDIAN_VERDICT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }

    return this.applyVerdict(verdict, params, key, fromCache);
  }

  private async runJudge(params: GuardianConsultParams): Promise<GuardianRunResult> {
    try {
      const result = await this.port!.judge({
        input: params.input,
        cwd: params.cwd,
        ...(params.modelId ? { modelId: params.modelId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      // A port that resolves NOTHING is broken, not undecided. Normalize it HERE
      // — at the one place a verdict enters this file — so the nullish value can
      // reach neither the verdict cache nor `applyVerdict`'s
      // `switch (verdict.verdict)`, whose dereference sits OUTSIDE this catch
      // and whose TypeError escaped `consult` altogether before P2.20. Tagged
      // `malformed` because that is exactly what it is, and because the tag is
      // what makes the host mark the resulting prompt as a judge FAILURE
      // instead of letting a broken port pass for a careful one.
      return result ?? {
        verdict: 'unsure',
        failure: 'malformed',
        reason: 'guardian judge port resolved no verdict',
      };
    } catch (error) {
      // The runner is contracted never to throw, but a broken port must still
      // fail closed to a human rather than surface as an unhandled rejection.
      return {
        verdict: 'unsure',
        failure: 'spawn-error',
        reason: `guardian judge port failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private applyVerdict(
    verdict: GuardianRunResult,
    params: GuardianConsultParams,
    key: string,
    fromCache = false,
  ): GuardianConsultOutcome {
    switch (verdict.verdict) {
      case 'no_objection':
        this.registerConsult(false);
        return { kind: 'allow', verdict };
      case 'deny': {
        this.registerConsult(true);
        // Session-scoped arming record: remember this exact (action, cwd) was
        // judge-denied so a later human approval of it (through the ask flow the
        // host resolves) can arm the post-denial override. Bounded LRU-on-write.
        this.recordDenied(key);
        // Loop-guard: a model re-issuing this exact judge-denied action.
        const loopCount = (this.denyLoopCounts.get(key) ?? 0) + 1;
        this.denyLoopCounts.set(key, loopCount);
        const diagnostic = this.denyDiagnostic(verdict, loopCount);
        // If the breaker just tripped, the NEXT borderline action falls to ask;
        // this action still carries its own deny. `fresh` marks a verdict the
        // judge actually produced on this call (not a cache replay) — the
        // auto-mode self-downgrade counts only fresh blocks, so a model
        // re-issuing one denied action feeds the loop-guard/circuit here, not
        // the session-level pause.
        return { kind: 'deny', verdict, diagnostic, fresh: !fromCache };
      }
      case 'unsure':
      default: {
        // `unsure` is a real consult (counts toward the window) but not a deny.
        // This arm is also where a port that resolved NOTHING lands: `runJudge`
        // normalizes nullish into `unsure` + `malformed` before the switch above
        // can dereference it, and the cache can only ever hold what `runJudge`
        // returned — so `verdict` is non-nullish here by construction (P2.20).
        this.registerConsult(false);
        return {
          kind: 'ask',
          reason: verdict.failure ? 'failure' : 'unsure',
          verdict,
        };
      }
    }
  }

  /** Update the circuit-breaker counters after one consulted verdict. */
  private registerConsult(denied: boolean): void {
    this.consecutiveDenies = denied ? this.consecutiveDenies + 1 : 0;
    this.recentDenies.push(denied);
    if (this.recentDenies.length > GUARDIAN_WINDOW_SIZE) this.recentDenies.shift();
    const windowDenies = this.recentDenies.reduce((sum, d) => sum + (d ? 1 : 0), 0);
    if (this.consecutiveDenies >= GUARDIAN_CONSECUTIVE_DENY_LIMIT
      || windowDenies >= GUARDIAN_WINDOW_DENY_LIMIT) {
      this.circuitOpen = true;
    }
  }

  private denyDiagnostic(verdict: GuardianVerdictResult, loopCount: number): string {
    const category = verdict.category ? ` [${verdict.category}]` : '';
    const base = `Guardian denied this action${category}: ${verdict.reason}`;
    if (loopCount >= GUARDIAN_DENY_LOOP_LIMIT) {
      return `${base}\nThe guardian has denied this exact action ${loopCount} times this turn. Do not retry it — try a different approach.`;
    }
    return base;
  }

  /** Test/diagnostic accessor: is the per-turn circuit breaker tripped? */
  get isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  /** Test/diagnostic accessor: how many times this exact action was judge-denied this turn. */
  denyLoopCount(action: GuardianJudgeInput['action'], cwd: string): number {
    return this.denyLoopCounts.get(this.key(action, cwd)) ?? 0;
  }
}

/** Convenience: which verdict values map to an allow outcome. */
export function guardianVerdictAllows(verdict: GuardianVerdict): boolean {
  return verdict === 'no_objection';
}
