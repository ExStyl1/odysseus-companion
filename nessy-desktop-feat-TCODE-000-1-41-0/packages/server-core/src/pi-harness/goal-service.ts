import { randomUUID } from 'node:crypto';

import type { PiHarnessGoalSummaryV1, PiHarnessSessionSettlementV1 } from '@nessy-agent/core/types';
import type {
  PiGoalAccountingV1,
  PiGoalBudgetsV1,
  PiGoalEvaluationV1,
  PiGoalRecordV1,
  PiGoalSourceV1,
  PiGoalStateV1,
} from '@nessy-agent/shared/sessions';
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key';
import { scanToolResultForSecrets, TOOL_RESULT_SECRET_TOKEN_PREFIXES } from '@nessy-agent/shared/agent/tool-result-secret-scan';

export const DEFAULT_PI_GOAL_BUDGETS: Readonly<PiGoalBudgetsV1> = Object.freeze({
  turnLimit: 32,
  tokenLimit: 250_000,
  costLimitUsd: 20,
  elapsedLimitMs: 2 * 60 * 60 * 1000,
});

/**
 * P6.322 (H49) · the goal check-in interval, in minutes. The host's own name,
 * and the one that wins when both are set.
 *
 * Native mechanism: `/goal` is host-side, so this timer is ours to write once
 * for all three runtimes, and codex's `thread/goal/set|get|clear` still carries
 * no check-in of its own.
 *
 * **The claude half of that finding was refuted by the 2.1.247 lift — see
 * {@link GOAL_CHECKIN_ENV_CLAUDE}.** This docblock said the vendored binary
 * "carries no `CLAUDE_CODE_GOAL_CHECKIN_MINUTES`", which was a true reading of
 * 2.1.233 and is false of the bundle we ship today.
 */
export const GOAL_CHECKIN_ENV = 'NESSY_GOAL_CHECKIN_MINUTES';

/**
 * C4.31 (H49) · the claude runtime's own spelling, accepted as an ALIAS.
 *
 * **The refusal recorded for this name is SUPERSEDED, and this paragraph exists
 * so it is not re-taken.** P6.1056 refused the alias under the share-vs-split
 * rule ("one name for a mechanism all three runtimes share"), and the coverage-95
 * round re-asked it as QX3; the owner read it the other way on 2026-09-11 and
 * answered the flip candidate C4.31 with *wire it*, which is what landed here.
 * The refusal's own premise — that there was nothing native to alias — is the
 * sentence the 2.1.247 lift falsified, so a later reader meeting the old refusal
 * in P6.1056 is reading a decision the owner has already reversed.
 *
 * Measured on the vendored bundle 2026-09-11 and re-measured 2026-09-12 with
 * `grep -ao <name> <file> | wc -l` (OCCURRENCES on a minified artefact, not
 * matching lines), both self-reports agreeing at `2.1.247` (`claude --version`
 * and `claudeCodeVersion` in the SDK manifest): the name scores **4**
 * occurrences in the native `claude` binary and **1** in `sdk.mjs`, against
 * positive control `ANTHROPIC_MODEL` at 22/3 and negative control
 * `nessyNotARealSdkKey` at 0/0. It scored **0** at 2.1.233, which is what the
 * record beside `GOAL_CHECKIN_ENV` was written from. The binary computes
 * `(V.CLAUDE_CODE_GOAL_CHECKIN_MINUTES ?? <default>) * 60000` behind its own
 * `tengu_saffron_wren` gate (2 occurrences, same instrument), beside the string
 * `Goal check-in: background work no longer running`.
 *
 * `env-vars.md`: "How many minutes background work can keep an active goal
 * waiting before Claude Code asks Claude to check on it. Default `30`. Set `0`
 * to turn check-ins off. Give whole minutes in plain digits, at most `10080`,
 * which is one week. Claude Code treats any other value as unset and uses the
 * default. Requires Claude Code v2.1.234 or later".
 *
 * **Why accepting it is not a posture change.** The claude child already reads
 * this variable: the spawn spreads `process.env`, so an operator who sets it has
 * configured the RUNTIME's check-in and not the host's, and the two then run at
 * different periods. Accepting it here makes them agree. It is additive — one
 * more accepted spelling, no verdict and no policy reversed — and the host's own
 * name still outranks it, so nothing an operator already wrote changes meaning.
 *
 * **Two stated residues.** (1) The host's default stays fifteen minutes
 * ({@link DEFAULT_GOAL_CHECKIN_MINUTES}) rather than the page's thirty: an alias
 * carries a VALUE, not a default, and the host's default is a decision with its
 * own reason written below. (2) The value is resolved by the host's rule, which
 * is a superset of the page's — we accept a fraction and more than a week where
 * the page says Claude Code treats those as unset. A second per-name parser
 * would make one spelling mean something different from the other on a timer all
 * three runtimes share, which is the divergence this alias exists to remove.
 */
export const GOAL_CHECKIN_ENV_CLAUDE = 'CLAUDE_CODE_GOAL_CHECKIN_MINUTES';

/**
 * C4.31 · which of the two names supplies the interval, and under which name a
 * diagnostic about it should be spoken.
 *
 * The host's name wins whenever it carries a non-empty value. An empty host
 * value is NOT a choice — {@link resolveGoalCheckInIntervalMs} already reads
 * `''` as "not given" — so it does not mask the vendor's name; that is the one
 * case where the precedence is decided by content rather than by presence, and
 * it is decided this way so that clearing one name cannot silently disable the
 * other.
 */
export function readGoalCheckInSetting(
  env: Record<string, string | undefined> = process.env,
): { raw: string | undefined; name: string } {
  const host = env[GOAL_CHECKIN_ENV];
  if (host !== undefined && host.trim() !== '') return { raw: host, name: GOAL_CHECKIN_ENV };
  const claude = env[GOAL_CHECKIN_ENV_CLAUDE];
  if (claude !== undefined && claude.trim() !== '') return { raw: claude, name: GOAL_CHECKIN_ENV_CLAUDE };
  return { raw: host ?? claude, name: GOAL_CHECKIN_ENV };
}

/**
 * No page names a default, so this is a DECISION with its reason written down
 * (the where-the-documentation-is-silent rule): fifteen minutes is long enough
 * that a goal waiting on an ordinary build or test run is not interrupted by a
 * notice about waiting, and short enough that a goal blocked on something that
 * will never arrive is surfaced inside one working session rather than at the
 * end of it.
 */
export const DEFAULT_GOAL_CHECKIN_MINUTES = 15;

/**
 * How far the interval is allowed to lengthen while nothing changes:
 * 1x, 2x, 4x, then 8x for ever. A check-in that repeated at a fixed period would
 * become the noise the user learns to ignore, which is the same failure as not
 * reporting at all; an unbounded doubling would go quiet for days.
 */
const GOAL_CHECKIN_MAX_BACKOFF_STEPS = 3;

/**
 * Resolve the check-in interval. `undefined` means DISABLED, and `0` is the
 * documented way to ask for that.
 *
 * An unreadable value falls to the default WITH a diagnostic rather than to
 * disabled: silently turning a notice off is the direction that makes a
 * misspelling indistinguishable from a working feature.
 *
 * `name` is the variable the value came from ({@link readGoalCheckInSetting}),
 * so the diagnostic names the spelling the operator actually wrote — telling
 * someone who set the vendor's name to fix the host's would be a misdirection.
 */
export function resolveGoalCheckInIntervalMs(
  raw: string | undefined,
  name: string = GOAL_CHECKIN_ENV,
): { ms: number | undefined; diagnostic?: string } {
  const value = raw?.trim();
  if (value === undefined || value === '') return { ms: DEFAULT_GOAL_CHECKIN_MINUTES * 60_000 };
  const minutes = Number(value);
  if (Number.isFinite(minutes) && minutes === 0) return { ms: undefined };
  if (Number.isFinite(minutes) && minutes > 0) return { ms: Math.round(minutes * 60_000) };
  return {
    ms: DEFAULT_GOAL_CHECKIN_MINUTES * 60_000,
    diagnostic: `${name}="${raw}" is not a non-negative number of minutes; goal check-ins are using the ${DEFAULT_GOAL_CHECKIN_MINUTES}-minute default. Set it to 0 to turn them off.`,
  };
}

/** One due check-in, as the host needs it to write the notice. */
export interface GoalCheckIn {
  goal: PiHarnessGoalSummaryV1;
  /** How long the goal has sat without a state change. */
  idleMs: number;
  /** 1 for the first notice about this idle stretch, 2 for the next, and so on. */
  sequence: number;
  /**
   * TRUE when the goal is `blocked`, which on this host means the notice is all
   * there is: the continuation loop refuses a non-`active` goal
   * (`SessionManager.schedulePiGoalContinuation`), and owner decision Q3 = A
   * mounted the goal chip READ-ONLY, so it exposes no `goal_resume` verb. The
   * notice therefore has to say that it cannot be answered from inside the app —
   * see the host's own comment at the notice site.
   */
  blocked: boolean;
}

const MAX_CONDITION = 8_192;
const MAX_REASON = 1_000;
const MAX_EVIDENCE_ITEMS = 16;
const MAX_EVIDENCE = 2_000;
const MAX_EVALUATOR_INPUT = 4_096;
const MAX_EVALUATOR_OUTPUT = 8_192;
const DEFAULT_EVALUATOR_TIMEOUT_MS = 10_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const TERMINAL = new Set(['complete', 'blocked', 'cancelled', 'budget_exhausted']);

export type GoalCommand =
  | { action: 'get' }
  | { action: 'create'; condition: string; source: PiGoalSourceV1; creator: string; budgets?: Partial<PiGoalBudgetsV1> }
  | { action: 'replace'; id: string; revision: number; condition: string; source: PiGoalSourceV1; creator: string; budgets?: Partial<PiGoalBudgetsV1> }
  | { action: 'cancel'; id: string; revision: number; reason: string }
  | { action: 'complete'; id: string; revision: number; reason: string; evidence: readonly string[] }
  | { action: 'blocked'; id: string; revision: number; blockingCondition: string; blockedBy: 'user' | 'external'; reason: string; evidence: readonly string[] }
  | { action: 'resume'; id: string; revision: number; reason: string };

export interface GoalEvaluatorInput {
  settlement: PiHarnessSessionSettlementV1;
  assistantSummary?: string;
  evaluate?: (prompt: string) => Promise<string | null>;
}

export interface GoalServiceOptions {
  persist?: (state: PiGoalStateV1) => void | Promise<void>;
  now?: () => number;
  newId?: () => string;
  evaluatorTimeoutMs?: number;
}

export class GoalService {
  private state: PiGoalStateV1;
  private tail = Promise.resolve();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly evaluatorTimeoutMs: number;

  constructor(
    readonly sessionKey: SessionKey,
    private readonly options: GoalServiceOptions = {},
    initial?: unknown,
  ) {
    this.state = parseGoalStateV1(initial) ?? { schemaVersion: 1 };
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.evaluatorTimeoutMs = options.evaluatorTimeoutMs ?? DEFAULT_EVALUATOR_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.evaluatorTimeoutMs) || this.evaluatorTimeoutMs < 1 || this.evaluatorTimeoutMs > 60_000) {
      throw new Error('goal-evaluator-timeout-invalid');
    }
  }

  snapshot(): PiGoalStateV1 {
    return structuredClone(this.snapshotAt(this.now()));
  }

  safeSnapshot(): PiHarnessGoalSummaryV1 | undefined {
    const goal = this.snapshot().goal;
    if (!goal) return undefined;
    return Object.freeze({
      id: goal.id,
      revision: goal.revision,
      status: goal.status,
      source: goal.source,
      creator: redactIdentifier(goal.creator),
      condition: redact(goal.condition, 1_024),
      budgets: Object.freeze({ ...goal.budgets }),
      accounting: Object.freeze({
        turns: goal.accounting.turns,
        tokens: goal.accounting.tokens,
        costUsd: goal.accounting.costUsd,
        elapsedMs: goal.accounting.elapsedMs,
        resumeCount: goal.accounting.resumeCount,
      }),
      ...(goal.blockingAudit ? { blocking: Object.freeze({
        condition: redact(goal.blockingAudit.condition, 512),
        blockedBy: goal.blockingAudit.blockedBy,
        consecutive: goal.blockingAudit.consecutive,
      }) } : {}),
      ...(goal.lastEvaluation ? { lastEvaluation: Object.freeze({
        source: goal.lastEvaluation.source,
        verdict: goal.lastEvaluation.verdict,
        reason: redact(goal.lastEvaluation.reason, 512),
        evidence: Object.freeze(goal.lastEvaluation.evidence.slice(0, 8).map(value => redact(value, 512))),
        evaluatedAt: goal.lastEvaluation.evaluatedAt,
      }) } : {}),
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    });
  }

  async execute(command: GoalCommand): Promise<PiGoalStateV1> {
    return this.exclusive(async () => {
      await this.enforceBudgetsLocked(this.now());
      if (command.action === 'get') return this.snapshot();

      const now = this.now();
      if (command.action === 'create') {
        if (this.state.goal?.status === 'active') throw new Error('goal-active');
        await this.commit({ schemaVersion: 1, goal: createGoal(command, now, this.newId()) });
        return this.snapshot();
      }

      const current = requireGoal(this.state, command.id, command.revision);
      if (command.action === 'replace') {
        if (current.status !== 'active') throw new Error(`goal-not-active:${current.status}`);
        await this.commit({ schemaVersion: 1, goal: createGoal(command, now, this.newId()) });
        return this.snapshot();
      }

      if (command.action === 'resume') {
        if (current.status !== 'blocked') throw new Error(`goal-not-resumable:${current.status}`);
        const reason = requiredText(command.reason, 'reason', MAX_REASON);
        const candidate: PiGoalRecordV1 = {
          ...current,
          revision: current.revision + 1,
          status: 'active',
          updatedAt: now,
          accounting: { ...current.accounting, lastResumedAt: now, resumeCount: current.accounting.resumeCount + 1 },
          blockingAudit: undefined,
          lastEvaluation: evaluation('manual', 'resumed', reason, [], now),
        };
        await this.commit({ schemaVersion: 1, goal: candidate });
        return this.snapshot();
      }

      if (current.status !== 'active') throw new Error(`goal-not-active:${current.status}`);
      const reason = requiredText(command.reason, 'reason', MAX_REASON);

      if (command.action === 'complete') {
        const evidence = evidenceList(command.evidence, true);
        await this.commit({ schemaVersion: 1, goal: terminalGoal(current, 'complete', 'completed', reason, evidence, now, 'manual') });
        return this.snapshot();
      }
      if (command.action === 'cancel') {
        await this.commit({ schemaVersion: 1, goal: terminalGoal(current, 'cancelled', 'cancelled', reason, [], now, 'manual') });
        return this.snapshot();
      }

      const blockingCondition = requiredText(command.blockingCondition, 'blocking-condition', MAX_REASON);
      const evidence = evidenceList(command.evidence, true);
      const same = current.blockingAudit
        && canonicalBlocker(current.blockingAudit.condition) === canonicalBlocker(blockingCondition)
        && current.blockingAudit.blockedBy === command.blockedBy;
      const consecutive = same ? current.blockingAudit!.consecutive + 1 : 1;
      const blocked = consecutive >= 3;
      const base = blocked ? withElapsed(current, now) : current;
      const candidate: PiGoalRecordV1 = {
        ...base,
        revision: current.revision + 1,
        status: blocked ? 'blocked' : 'active',
        updatedAt: now,
        blockingAudit: { condition: blockingCondition, blockedBy: command.blockedBy, consecutive },
        lastEvaluation: evaluation('manual', blocked ? 'blocked' : 'not_complete', reason, evidence, now),
      };
      await this.commit({ schemaVersion: 1, goal: candidate });
      return this.snapshot();
    });
  }

  async recordTurn(input: { turnId: string; tokens: number; costUsd: number; goalId?: string }): Promise<PiGoalStateV1> {
    return this.exclusive(async () => {
      const current = this.state.goal;
      if (!current) return this.snapshot();
      const expectedGoalId = input.goalId === undefined ? undefined : safeId(input.goalId, 'goal-id');
      if (expectedGoalId !== undefined && current.id !== expectedGoalId) return this.snapshot();
      // A terminal goal accepts only the turn explicitly captured by its host.
      // This accounts the completing/blocking turn without charging later work.
      if (current.status !== 'active' && expectedGoalId === undefined) return this.snapshot();
      const turnId = safeId(input.turnId, 'turn-id');
      if (current.accounting.lastTurnId === turnId) return this.snapshot();
      const now = this.now();
      const accounting: PiGoalAccountingV1 = {
        ...current.accounting,
        turns: current.accounting.turns + 1,
        tokens: current.accounting.tokens + nonnegativeInteger(input.tokens, 'tokens'),
        costUsd: current.accounting.costUsd + nonnegativeFinite(input.costUsd, 'cost'),
        elapsedMs: current.status === 'active' ? activeElapsed(current.accounting, now) : current.accounting.elapsedMs,
        lastResumedAt: now,
        lastTurnId: turnId,
      };
      const candidate: PiGoalRecordV1 = { ...current, revision: current.revision + 1, updatedAt: now, accounting };
      await this.commit({ schemaVersion: 1, goal: current.status === 'active' ? exhaustIfNeeded(candidate, now) : candidate });
      return this.snapshot();
    });
  }

  async enforceBudgets(): Promise<PiGoalStateV1> {
    return this.exclusive(async () => {
      await this.enforceBudgetsLocked(this.now());
      return this.snapshot();
    });
  }

  async evaluateAtSettlement(input: GoalEvaluatorInput): Promise<PiGoalStateV1> {
    if (!input.settlement.settled) return this.snapshot();
    const captured = await this.exclusive(async () => {
      await this.enforceBudgetsLocked(this.now());
      const goal = this.state.goal;
      return goal?.status === 'active'
        ? { id: goal.id, revision: goal.revision, prompt: evaluatorPrompt(goal, input.assistantSummary) }
        : undefined;
    });
    if (!captured || !input.evaluate) return this.snapshot();

    let parsed: { complete: boolean; reason: string; evidence: string[] };
    try {
      const raw = await withTimeout(input.evaluate(captured.prompt), this.evaluatorTimeoutMs);
      parsed = parseEvaluatorResult(raw);
    } catch (error) {
      parsed = {
        complete: false,
        reason: error instanceof Error && error.message === 'goal-evaluator-timeout'
          ? 'evaluator-timeout'
          : 'evaluator-invalid-or-unavailable',
        evidence: [],
      };
    }

    return this.exclusive(async () => {
      await this.enforceBudgetsLocked(this.now());
      const current = this.state.goal;
      if (!current || current.status !== 'active' || current.id !== captured.id || current.revision !== captured.revision) {
        return this.snapshot();
      }
      const now = this.now();
      // goal.md:129 — "**Yes**: Claude Code clears the goal and records an
      // achieved entry in the transcript" (R47/f175). A yes from the evaluator
      // is terminal, not advisory: commit completion here (evidence is already
      // enforced non-empty by parseEvaluatorResult when complete is true). The
      // `complete_suggested` verdict stays in the parse allowlist below only
      // for state written by older builds. A no keeps the advisory
      // not_complete write unchanged.
      if (parsed.complete) {
        await this.commit({
          schemaVersion: 1,
          goal: terminalGoal(current, 'complete', 'completed', parsed.reason, parsed.evidence, now, 'evaluator'),
        });
        return this.snapshot();
      }
      await this.commit({ schemaVersion: 1, goal: {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        lastEvaluation: evaluation('evaluator', 'not_complete', parsed.reason, parsed.evidence, now),
      } });
      return this.snapshot();
    });
  }

  async canContinue(reference: { id: string; revision: number }, settlement: PiHarnessSessionSettlementV1): Promise<boolean> {
    if (!settlement.settled) return false;
    return this.exclusive(async () => {
      await this.enforceBudgetsLocked(this.now());
      const goal = this.state.goal;
      return !!goal && goal.status === 'active' && goal.id === reference.id && goal.revision === reference.revision;
    });
  }

  /**
   * P6.322 (H49) · is a check-in due, and what does it say?
   *
   * `done_means` (1): "a goal blocked on a background task produces a check-in
   * after the configured interval and at lengthening intervals while idle, and
   * `0` disables it". Idle is measured from the goal's own `updatedAt` — the
   * timestamp every state change writes — so any real progress (a turn
   * accounted, an evaluation recorded, a resume) resets the clock without this
   * method needing to know about any of them.
   *
   * The check-in bookkeeping is deliberately IN MEMORY and not part of
   * `PiGoalStateV1`. The persisted record is a contract shared with the renderer
   * and the session store, and a notice cadence is not state anybody else reads;
   * the cost is that a restart starts the cadence over, which is the harmless
   * direction (one early notice, never a missed one). Stated rather than hidden.
   *
   * Pure apart from that bookkeeping, and it takes `now`, so a test can walk a
   * lengthening schedule instead of sleeping through it.
   */
  dueCheckIn(now: number, intervalMs: number | undefined): GoalCheckIn | undefined {
    if (intervalMs === undefined || !(intervalMs > 0)) return undefined;
    const goal = this.safeSnapshot();
    // Only a goal that is still in play: a complete, cancelled or
    // budget-exhausted goal has nothing to check in about, and its record is
    // already terminal.
    if (!goal || (goal.status !== 'active' && goal.status !== 'blocked')) {
      this.checkInSequence = 0;
      this.lastCheckInAt = undefined;
      return undefined;
    }
    // A state change since the last notice restarts the ladder: the goal moved.
    if (this.lastCheckInAt !== undefined && goal.updatedAt > this.lastCheckInAt) {
      this.checkInSequence = 0;
      this.lastCheckInAt = undefined;
    }
    const since = this.lastCheckInAt ?? goal.updatedAt;
    const step = Math.min(this.checkInSequence, GOAL_CHECKIN_MAX_BACKOFF_STEPS);
    if (now - since < intervalMs * 2 ** step) return undefined;
    this.checkInSequence += 1;
    this.lastCheckInAt = now;
    return {
      goal,
      idleMs: now - goal.updatedAt,
      sequence: this.checkInSequence,
      blocked: goal.status === 'blocked',
    };
  }

  /** In-memory check-in bookkeeping; see {@link dueCheckIn}. */
  private checkInSequence = 0;
  private lastCheckInAt: number | undefined;

  continuationPrompt(): string | undefined {
    const goal = this.safeSnapshot();
    if (!goal || goal.status !== 'active') return undefined;
    return [
      `Continue the active Nessy goal ${goal.id}@${goal.revision}: ${goal.condition}`,
      `Usage: ${goal.accounting.turns}/${goal.budgets.turnLimit} turns, ${goal.accounting.tokens}/${goal.budgets.tokenLimit} tokens, $${goal.accounting.costUsd.toFixed(4)}/$${goal.budgets.costLimitUsd}.`,
      'Keep working. Use Goal complete only with concrete evidence; report blocked only after the same external blocker reaches three consecutive evaluations.',
      ...(goal.lastEvaluation ? [`Last evaluation: ${goal.lastEvaluation.verdict}: ${goal.lastEvaluation.reason}`] : []),
    ].join('\n');
  }

  private async enforceBudgetsLocked(now: number): Promise<void> {
    const current = this.state.goal;
    if (!current || current.status !== 'active') return;
    const exhausted = exhaustIfNeeded({
      ...current,
      accounting: { ...current.accounting, elapsedMs: activeElapsed(current.accounting, now), lastResumedAt: now },
    }, now);
    if (exhausted.status === 'budget_exhausted') {
      await this.commit({ schemaVersion: 1, goal: { ...exhausted, revision: current.revision + 1, updatedAt: now } });
    }
  }

  private snapshotAt(now: number): PiGoalStateV1 {
    const goal = this.state.goal;
    if (!goal || goal.status !== 'active') return this.state;
    return { schemaVersion: 1, goal: { ...goal, accounting: { ...goal.accounting, elapsedMs: activeElapsed(goal.accounting, now) } } };
  }

  private async commit(candidate: PiGoalStateV1): Promise<void> {
    const cloned = structuredClone(candidate);
    await this.options.persist?.(structuredClone(cloned));
    this.state = cloned;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function createGoal(
  command: Extract<GoalCommand, { action: 'create' | 'replace' }>,
  now: number,
  generatedId: string,
): PiGoalRecordV1 {
  return {
    schemaVersion: 1,
    id: safeId(generatedId, 'goal-id'),
    revision: 1,
    source: source(command.source),
    creator: safeId(command.creator, 'creator'),
    condition: requiredText(command.condition, 'condition', MAX_CONDITION),
    status: 'active',
    budgets: budgets(command.budgets),
    accounting: { turns: 0, tokens: 0, costUsd: 0, elapsedMs: 0, startedAt: now, lastResumedAt: now, resumeCount: 0 },
    createdAt: now,
    updatedAt: now,
  };
}

function requireGoal(state: PiGoalStateV1, id: string, revision: number): PiGoalRecordV1 {
  const goal = state.goal;
  if (!goal) throw new Error('goal-not-found');
  if (goal.id !== safeId(id, 'goal-id')) throw new Error('goal-stale-id');
  if (goal.revision !== nonnegativeInteger(revision, 'revision')) throw new Error('goal-stale-revision');
  return goal;
}

function terminalGoal(
  goal: PiGoalRecordV1,
  status: 'complete' | 'cancelled',
  verdict: 'completed' | 'cancelled',
  reason: string,
  evidence: string[],
  now: number,
  evaluationSource: PiGoalEvaluationV1['source'],
): PiGoalRecordV1 {
  const elapsed = withElapsed(goal, now);
  return {
    ...elapsed,
    revision: goal.revision + 1,
    status,
    updatedAt: now,
    lastEvaluation: evaluation(evaluationSource, verdict, reason, evidence, now),
  };
}

function withElapsed(goal: PiGoalRecordV1, now: number): PiGoalRecordV1 {
  return { ...goal, accounting: { ...goal.accounting, elapsedMs: activeElapsed(goal.accounting, now), lastResumedAt: now } };
}

function activeElapsed(accounting: PiGoalAccountingV1, now: number): number {
  return accounting.elapsedMs + Math.max(0, now - accounting.lastResumedAt);
}

function exhaustIfNeeded(goal: PiGoalRecordV1, now: number): PiGoalRecordV1 {
  const reason = goal.accounting.turns >= goal.budgets.turnLimit ? 'turn_limit'
    : goal.accounting.tokens >= goal.budgets.tokenLimit ? 'token_limit'
      : goal.accounting.costUsd >= goal.budgets.costLimitUsd ? 'cost_limit'
        : goal.accounting.elapsedMs >= goal.budgets.elapsedLimitMs ? 'elapsed_limit'
          : undefined;
  if (!reason) return goal;
  return {
    ...goal,
    status: 'budget_exhausted',
    updatedAt: now,
    lastEvaluation: evaluation('budget', 'budget_exhausted', reason, [], now),
  };
}

function evaluation(
  source: PiGoalEvaluationV1['source'],
  verdict: PiGoalEvaluationV1['verdict'],
  reason: string,
  evidence: readonly string[],
  evaluatedAt: number,
): PiGoalEvaluationV1 {
  return { source, verdict, reason: requiredText(reason, 'reason', MAX_REASON), evidence: evidenceList(evidence), evaluatedAt };
}

function budgets(input?: Partial<PiGoalBudgetsV1>): PiGoalBudgetsV1 {
  const value = { ...DEFAULT_PI_GOAL_BUDGETS, ...input };
  return {
    turnLimit: positiveInteger(value.turnLimit, 'turn-limit', 1_000),
    tokenLimit: positiveInteger(value.tokenLimit, 'token-limit', 100_000_000),
    costLimitUsd: positiveFinite(value.costLimitUsd, 'cost-limit', 10_000),
    elapsedLimitMs: positiveInteger(value.elapsedLimitMs, 'elapsed-limit', 30 * 24 * 60 * 60 * 1000),
  };
}

function evidenceList(input: readonly string[], required = false): string[] {
  if (!Array.isArray(input) || input.length > MAX_EVIDENCE_ITEMS || (required && input.length === 0)) {
    throw new Error('goal-evidence-invalid');
  }
  return input.map(value => requiredText(value, 'evidence', MAX_EVIDENCE));
}

function source(value: unknown): PiGoalSourceV1 {
  if (value !== 'user' && value !== 'agent' && value !== 'automation') throw new Error('goal-source-invalid');
  return value;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`goal-${field}-invalid`);
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > max) throw new Error(`goal-${field}-invalid`);
  return normalized;
}

function safeId(value: unknown, field: string): string {
  const normalized = requiredText(value, field, 256);
  if (!SAFE_ID.test(normalized)) throw new Error(`goal-${field}-invalid`);
  return normalized;
}

function positiveInteger(value: unknown, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`goal-${field}-invalid`);
  return value as number;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`goal-${field}-invalid`);
  return value as number;
}

function positiveFinite(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) throw new Error(`goal-${field}-invalid`);
  return value;
}

function nonnegativeFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`goal-${field}-invalid`);
  return value;
}

function canonicalBlocker(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

/**
 * The token-prefix alternation, built ONCE from the shared list rather than
 * spelled out here. `-` and `_` carry no regex meaning, but the escape stays:
 * the list is a contract another module owns and a future prefix may not be so
 * well behaved.
 */
const TOKEN_PREFIXED_SECRET = new RegExp(
  `\\b(?:${TOOL_RESULT_SECRET_TOKEN_PREFIXES.map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[A-Za-z0-9_-]{8,}`,
  'gi',
);

function redact(value: string, max: number): string {
  // F1.464 — the tool-result scan's OWN table first (JWT, Ory, Bearer since F1.365,
  // and every issuer family the coarse list below never named), so this prompt masks
  // at least what a tool result would. Its markers name the rule, never the bytes.
  return scanToolResultForSecrets(value).text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=?/gi, 'Bearer [REDACTED]')
    // GitLab's two PAT-shaped prefixes beside GitHub's five (P6.197). P6.574
    // then made the LIST itself shared rather than copied: this pattern is now
    // derived from `TOOL_RESULT_SECRET_TOKEN_PREFIXES`, the same export the
    // host tool-result scanner is built from, so the two cannot drift — which
    // is what the previous comment here could only ask for. Same set, same
    // behaviour; only the source of the alternation moved.
    .replace(TOKEN_PREFIXED_SECRET, '[REDACTED]')
    .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'`]+/g, '[PATH]')
    .replace(/(^|[\s(])\/(?:[^\s"'`/]+\/?)+/g, '$1[PATH]')
    .slice(0, max);
}

function redactIdentifier(value: string): string {
  const safe = redact(value, 128);
  return SAFE_ID.test(safe) ? safe : 'redacted';
}

function evaluatorPrompt(goal: PiGoalRecordV1, assistantSummary?: string): string {
  const payload = JSON.stringify({
    condition: redact(goal.condition, 2_048),
    accounting: {
      turns: goal.accounting.turns,
      tokens: goal.accounting.tokens,
      costUsd: goal.accounting.costUsd,
      elapsedMs: goal.accounting.elapsedMs,
    },
    lastAssistantSummary: assistantSummary ? redact(assistantSummary, 2_048) : undefined,
  }).slice(0, MAX_EVALUATOR_INPUT);
  return [
    'Goal completion check. You have no tools; judge only from the evidence below.',
    'Return strict JSON: {"complete":boolean,"reason":string,"evidence":string[]}.',
    'Mark complete only when the bounded evidence proves every condition; otherwise false.',
    payload,
  ].join('\n');
}

function parseEvaluatorResult(raw: string | null): { complete: boolean; reason: string; evidence: string[] } {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > MAX_EVALUATOR_OUTPUT) throw new Error('goal-evaluator-invalid');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('goal-evaluator-invalid');
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some(key => !['complete', 'reason', 'evidence'].includes(key)) || typeof record.complete !== 'boolean') {
    throw new Error('goal-evaluator-invalid');
  }
  return {
    complete: record.complete,
    reason: requiredText(record.reason, 'evaluator-reason', MAX_REASON),
    evidence: evidenceList(record.evidence as readonly string[], record.complete),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('goal-evaluator-timeout')), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseGoalStateV1(input: unknown): PiGoalStateV1 | undefined {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const state = input as Record<string, unknown>;
    if (state.schemaVersion !== 1 || Object.keys(state).some(key => !['schemaVersion', 'goal'].includes(key))) return undefined;
    if (state.goal === undefined) return { schemaVersion: 1 };
    const raw = state.goal as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1) return undefined;
    exactKeys(raw, [
      'schemaVersion', 'id', 'revision', 'source', 'creator', 'condition', 'status',
      'budgets', 'accounting', 'createdAt', 'updatedAt', 'blockingAudit', 'lastEvaluation',
    ], 'record');
    if (TERMINAL.has(String(raw.status)) === false && raw.status !== 'active') return undefined;
    const parsed: PiGoalRecordV1 = {
      schemaVersion: 1,
      id: safeId(raw.id, 'goal-id'),
      revision: positiveInteger(raw.revision, 'revision', Number.MAX_SAFE_INTEGER),
      source: source(raw.source),
      creator: safeId(raw.creator, 'creator'),
      condition: requiredText(raw.condition, 'condition', MAX_CONDITION),
      status: raw.status as PiGoalRecordV1['status'],
      budgets: parseBudgets(raw.budgets),
      accounting: parseAccounting(raw.accounting),
      createdAt: nonnegativeInteger(raw.createdAt, 'created-at'),
      updatedAt: nonnegativeInteger(raw.updatedAt, 'updated-at'),
      ...(raw.blockingAudit === undefined ? {} : { blockingAudit: parseBlockingAudit(raw.blockingAudit) }),
      ...(raw.lastEvaluation === undefined ? {} : { lastEvaluation: parseEvaluation(raw.lastEvaluation) }),
    };
    if (parsed.updatedAt < parsed.createdAt || parsed.accounting.lastResumedAt < parsed.accounting.startedAt) return undefined;
    if (parsed.status === 'blocked' && (!parsed.blockingAudit || parsed.blockingAudit.consecutive < 3)) return undefined;
    if (!validTerminalState(parsed)) return undefined;
    return { schemaVersion: 1, goal: parsed };
  } catch {
    return undefined;
  }
}

function validTerminalState(goal: PiGoalRecordV1): boolean {
  if (goal.status === 'active') return true;
  const evaluation = goal.lastEvaluation;
  if (!evaluation) return false;
  // 'evaluator' joined 'manual' with R47/f175: the settlement evaluator now
  // terminates a goal as complete, and its record must survive reload.
  if (goal.status === 'complete') {
    return (evaluation.source === 'manual' || evaluation.source === 'evaluator')
      && evaluation.verdict === 'completed' && evaluation.evidence.length > 0;
  }
  if (goal.status === 'cancelled') return evaluation.source === 'manual' && evaluation.verdict === 'cancelled';
  if (goal.status === 'blocked') return evaluation.source === 'manual' && evaluation.verdict === 'blocked' && evaluation.evidence.length > 0;
  return evaluation.source === 'budget'
    && evaluation.verdict === 'budget_exhausted'
    && ['turn_limit', 'token_limit', 'cost_limit', 'elapsed_limit'].includes(evaluation.reason);
}

function parseBudgets(input: unknown): PiGoalBudgetsV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('goal-budgets-invalid');
  const raw = input as Record<string, unknown>;
  exactKeys(raw, ['turnLimit', 'tokenLimit', 'costLimitUsd', 'elapsedLimitMs'], 'budgets');
  return {
    turnLimit: positiveInteger(raw.turnLimit, 'turn-limit', 1_000),
    tokenLimit: positiveInteger(raw.tokenLimit, 'token-limit', 100_000_000),
    costLimitUsd: positiveFinite(raw.costLimitUsd, 'cost-limit', 10_000),
    elapsedLimitMs: positiveInteger(raw.elapsedLimitMs, 'elapsed-limit', 30 * 24 * 60 * 60 * 1000),
  };
}

function parseAccounting(input: unknown): PiGoalAccountingV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('goal-accounting-invalid');
  const raw = input as Record<string, unknown>;
  exactKeys(raw, ['turns', 'tokens', 'costUsd', 'elapsedMs', 'startedAt', 'lastResumedAt', 'resumeCount', 'lastTurnId'], 'accounting');
  return {
    turns: nonnegativeInteger(raw.turns, 'turns'),
    tokens: nonnegativeInteger(raw.tokens, 'tokens'),
    costUsd: nonnegativeFinite(raw.costUsd, 'cost'),
    elapsedMs: nonnegativeInteger(raw.elapsedMs, 'elapsed'),
    startedAt: nonnegativeInteger(raw.startedAt, 'started-at'),
    lastResumedAt: nonnegativeInteger(raw.lastResumedAt, 'last-resumed-at'),
    resumeCount: nonnegativeInteger(raw.resumeCount, 'resume-count'),
    ...(raw.lastTurnId === undefined ? {} : { lastTurnId: safeId(raw.lastTurnId, 'turn-id') }),
  };
}

function parseBlockingAudit(input: unknown): NonNullable<PiGoalRecordV1['blockingAudit']> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('goal-blocking-audit-invalid');
  const raw = input as Record<string, unknown>;
  exactKeys(raw, ['condition', 'blockedBy', 'consecutive'], 'blocking-audit');
  if (raw.blockedBy !== 'user' && raw.blockedBy !== 'external') throw new Error('goal-blocked-by-invalid');
  return {
    condition: requiredText(raw.condition, 'blocking-condition', MAX_REASON),
    blockedBy: raw.blockedBy,
    consecutive: positiveInteger(raw.consecutive, 'blocking-consecutive', Number.MAX_SAFE_INTEGER),
  };
}

function parseEvaluation(input: unknown): PiGoalEvaluationV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('goal-evaluation-invalid');
  const raw = input as Record<string, unknown>;
  exactKeys(raw, ['source', 'verdict', 'reason', 'evidence', 'evaluatedAt'], 'evaluation');
  if (!['manual', 'evaluator', 'budget'].includes(String(raw.source))) throw new Error('goal-evaluation-source-invalid');
  if (!['not_complete', 'complete_suggested', 'completed', 'blocked', 'cancelled', 'budget_exhausted', 'resumed'].includes(String(raw.verdict))) throw new Error('goal-evaluation-verdict-invalid');
  return {
    source: raw.source as PiGoalEvaluationV1['source'],
    verdict: raw.verdict as PiGoalEvaluationV1['verdict'],
    reason: requiredText(raw.reason, 'reason', MAX_REASON),
    evidence: evidenceList(raw.evidence as readonly string[]),
    evaluatedAt: nonnegativeInteger(raw.evaluatedAt, 'evaluated-at'),
  };
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const expected = new Set(allowed);
  if (Object.keys(input).some(key => !expected.has(key))) throw new Error(`goal-${field}-field-invalid`);
}
