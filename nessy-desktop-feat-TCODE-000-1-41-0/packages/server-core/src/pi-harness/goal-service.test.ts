import { describe, expect, it } from 'bun:test';

import type { PiGoalBudgetsV1, PiGoalStateV1 } from '@nessy-agent/shared/sessions';

import {
  GoalService,
  parseGoalStateV1,
  resolveGoalCheckInIntervalMs,
  DEFAULT_GOAL_CHECKIN_MINUTES,
  GOAL_CHECKIN_ENV,
  GOAL_CHECKIN_ENV_CLAUDE,
  readGoalCheckInSetting,
} from './goal-service.ts';

/*
 * State/stale-ID/budget test shapes adapted from @narumitw/pi-goal v0.20.0
 * (befd5684a7f4d861a9909b24f0723ee671029b1e), MIT. Evidence-gated completion
 * shape adapted from pi-tasks v0.1.5
 * (289f98d3d17262a3ff9be6c2942e1b7024b98991), MIT. No runtime code imported.
 */

const sessionKey = { workspaceId: 'workspace', sessionId: 'session' };
const settled = { schemaVersion: 1 as const, settled: true, pending: [] as const };
const busy = { schemaVersion: 1 as const, settled: false, pending: ['child'] as const };

function harness(options: { budgets?: Partial<PiGoalBudgetsV1>; evaluatorTimeoutMs?: number; initial?: PiGoalStateV1 } = {}) {
  let now = 1_000;
  let id = 0;
  const persisted: PiGoalStateV1[] = [];
  const service = new GoalService(sessionKey, {
    now: () => now,
    newId: () => `goal-${++id}`,
    evaluatorTimeoutMs: options.evaluatorTimeoutMs,
    persist: state => { persisted.push(structuredClone(state)); },
  }, options.initial);
  const create = () => service.execute({
    action: 'create',
    condition: 'Ship verified change',
    source: 'user',
    creator: 'desktop',
    budgets: options.budgets,
  });
  return { service, create, persisted, advance: (ms: number) => { now += ms; } };
}

describe('GoalService', () => {
  it('creates, reads, replaces, completes and cancels with strict references and evidence', async () => {
    const { service, create } = harness();
    let state = await create();
    expect(state.goal).toMatchObject({ id: 'goal-1', revision: 1, status: 'active', source: 'user', creator: 'desktop' });
    await expect(service.execute({ action: 'create', condition: 'other', source: 'agent', creator: 'pi' })).rejects.toThrow('goal-active');
    await expect(service.execute({ action: 'complete', id: 'goal-1', revision: 0, reason: 'done', evidence: ['test'] })).rejects.toThrow('goal-stale-revision');
    await expect(service.execute({ action: 'complete', id: 'goal-1', revision: 1, reason: 'done', evidence: [] })).rejects.toThrow('goal-evidence-invalid');

    state = await service.execute({ action: 'replace', id: 'goal-1', revision: 1, condition: 'Ship v2', source: 'agent', creator: 'pi' });
    expect(state.goal).toMatchObject({ id: 'goal-2', revision: 1, condition: 'Ship v2', source: 'agent' });
    state = await service.execute({ action: 'complete', id: 'goal-2', revision: 1, reason: 'verified', evidence: ['12 tests passed'] });
    expect(state.goal).toMatchObject({ status: 'complete', revision: 2, lastEvaluation: { verdict: 'completed', evidence: ['12 tests passed'] } });

    state = await service.execute({ action: 'create', condition: 'New work', source: 'user', creator: 'desktop' });
    state = await service.execute({ action: 'cancel', id: state.goal!.id, revision: 1, reason: 'user cancelled' });
    expect(state.goal).toMatchObject({ status: 'cancelled', lastEvaluation: { verdict: 'cancelled' } });
    expect((await service.execute({ action: 'get' })).goal?.status).toBe('cancelled');
  });

  it('requires three identical external blocker evaluations and resets the audit on resume', async () => {
    const { service, create } = harness();
    let state = await create();
    const blocked = (revision: number, blockingCondition = 'Waiting for user approval') => service.execute({
      action: 'blocked', id: 'goal-1', revision, blockingCondition, blockedBy: 'user', reason: 'approval required', evidence: ['request rejected'],
    });
    state = await blocked(1);
    expect(state.goal).toMatchObject({ status: 'active', revision: 2, blockingAudit: { consecutive: 1 } });
    state = await blocked(2, 'Different external outage');
    expect(state.goal?.blockingAudit?.consecutive).toBe(1);
    state = await blocked(3, 'Waiting for user approval');
    state = await blocked(4, 'Waiting for user approval');
    expect(state.goal).toMatchObject({ status: 'active', blockingAudit: { consecutive: 2 } });
    state = await blocked(5, 'Waiting for user approval');
    expect(state.goal).toMatchObject({ status: 'blocked', revision: 6, blockingAudit: { consecutive: 3 }, lastEvaluation: { verdict: 'blocked' } });

    state = await service.execute({ action: 'resume', id: 'goal-1', revision: 6, reason: 'approval arrived' });
    expect(state.goal).toMatchObject({ status: 'active', revision: 7, accounting: { resumeCount: 1 } });
    expect(state.goal?.blockingAudit).toBeUndefined();
  });

  it('enforces every hard budget and rejects continuation at terminal state', async () => {
    for (const testCase of [
      { budgets: { turnLimit: 1 }, usage: { turnId: 'turn-1', tokens: 0, costUsd: 0 }, reason: 'turn_limit' },
      { budgets: { tokenLimit: 5 }, usage: { turnId: 'turn-1', tokens: 5, costUsd: 0 }, reason: 'token_limit' },
      { budgets: { costLimitUsd: 0.5 }, usage: { turnId: 'turn-1', tokens: 0, costUsd: 0.5 }, reason: 'cost_limit' },
    ] as const) {
      const { service, create } = harness({ budgets: testCase.budgets });
      await create();
      const state = await service.recordTurn(testCase.usage);
      expect(state.goal).toMatchObject({ status: 'budget_exhausted', lastEvaluation: { reason: testCase.reason } });
      expect(await service.canContinue({ id: 'goal-1', revision: state.goal!.revision }, settled)).toBe(false);
    }

    const elapsed = harness({ budgets: { elapsedLimitMs: 1_000 } });
    await elapsed.create();
    elapsed.advance(1_000);
    const state = await elapsed.service.enforceBudgets();
    expect(state.goal).toMatchObject({ status: 'budget_exhausted', lastEvaluation: { reason: 'elapsed_limit' } });
  });

  it('deduplicates turn accounting and persists/resumes through the canonical state seam', async () => {
    const first = harness();
    await first.create();
    const once = await first.service.recordTurn({ turnId: 'assistant-message-1', tokens: 10, costUsd: 0.1 });
    const twice = await first.service.recordTurn({ turnId: 'assistant-message-1', tokens: 10, costUsd: 0.1 });
    expect(twice.goal?.accounting).toMatchObject({ turns: 1, tokens: 10, costUsd: 0.1 });

    const restored = harness({ initial: once });
    expect(restored.service.snapshot()).toEqual(once);
    expect(restored.service.continuationPrompt()).toContain(`${once.goal!.id}@${once.goal!.revision}`);
    expect(await restored.service.canContinue({ id: once.goal!.id, revision: once.goal!.revision }, settled)).toBe(true);
    expect(await restored.service.canContinue({ id: once.goal!.id, revision: once.goal!.revision - 1 }, settled)).toBe(false);

    expect(parseGoalStateV1({ ...once, extra: true })).toBeUndefined();
    expect(parseGoalStateV1({ ...once, goal: { ...once.goal, budgets: { ...once.goal!.budgets, extra: true } } })).toBeUndefined();
    expect(parseGoalStateV1({ ...once, goal: { ...once.goal, accounting: { ...once.goal!.accounting, extra: true } } })).toBeUndefined();
    expect(parseGoalStateV1({ ...once, goal: { ...once.goal, status: 'complete' } })).toBeUndefined();
  });

  it('accounts the captured terminal turn once without charging later session work', async () => {
    const { service, create } = harness({ budgets: { turnLimit: 1 } });
    await create();
    const complete = await service.execute({ action: 'complete', id: 'goal-1', revision: 1, reason: 'verified', evidence: ['green gate'] });
    const accounted = await service.recordTurn({ goalId: 'goal-1', turnId: 'turn-1', tokens: 10, costUsd: 0.1 });
    expect(accounted.goal).toMatchObject({ status: 'complete', revision: complete.goal!.revision + 1, accounting: { turns: 1, tokens: 10, costUsd: 0.1 }, lastEvaluation: { verdict: 'completed' } });
    expect(await service.recordTurn({ goalId: 'goal-1', turnId: 'turn-1', tokens: 10, costUsd: 0.1 })).toEqual(accounted);
    expect((await service.recordTurn({ turnId: 'later-session-turn', tokens: 10, costUsd: 0.1 })).goal?.accounting.turns).toBe(1);
  });

  it('runs the evaluator only when settled and a yes terminates the goal as complete', async () => {
    const { service, create } = harness();
    await create();
    let calls = 0;
    await service.evaluateAtSettlement({ settlement: busy, evaluate: async () => { calls++; return '{}'; } });
    expect(calls).toBe(0);

    const state = await service.evaluateAtSettlement({
      settlement: settled,
      assistantSummary: 'Implemented and tested',
      evaluate: async prompt => {
        calls++;
        expect(prompt).toContain('You have no tools');
        expect(prompt.length).toBeLessThanOrEqual(4_500);
        return JSON.stringify({ complete: true, reason: 'looks complete', evidence: ['focused tests passed'] });
      },
    });
    expect(calls).toBe(1);
    // goal.md:129 — "Yes: Claude Code clears the goal": the evaluator's yes is
    // terminal, evaluator-sourced, not an advisory complete_suggested.
    expect(state.goal).toMatchObject({ status: 'complete', revision: 2, lastEvaluation: { source: 'evaluator', verdict: 'completed', evidence: ['focused tests passed'] } });
  });

  it('persists the evaluator-completed record across reload and refuses continuation', async () => {
    const { service, create } = harness();
    await create();
    const state = await service.evaluateAtSettlement({
      settlement: settled,
      evaluate: async () => JSON.stringify({ complete: true, reason: 'proved', evidence: ['gate green'] }),
    });
    expect(state.goal).toMatchObject({ status: 'complete', lastEvaluation: { source: 'evaluator' } });

    // Round-trip: validTerminalState must admit the evaluator-sourced terminal
    // record, or the whole goal record is silently dropped on reload.
    expect(parseGoalStateV1(state)).toEqual(state);
    const restored = harness({ initial: state });
    expect(restored.service.snapshot()).toEqual(state);

    // The EXISTING guards stop dispatch after completion — no new stop logic:
    // continuation eligibility and the continuation prompt both refuse, on the
    // live service and on the reloaded one.
    expect(await service.canContinue({ id: 'goal-1', revision: state.goal!.revision }, settled)).toBe(false);
    expect(service.continuationPrompt()).toBeUndefined();
    expect(await restored.service.canContinue({ id: 'goal-1', revision: state.goal!.revision }, settled)).toBe(false);
    expect(restored.service.continuationPrompt()).toBeUndefined();
  });

  it('treats evaluator invalid/timeout/error as not complete and lets a concurrent manual terminal win', async () => {
    const invalid = harness({ evaluatorTimeoutMs: 5 });
    await invalid.create();
    let state = await invalid.service.evaluateAtSettlement({ settlement: settled, evaluate: async () => 'not-json' });
    expect(state.goal).toMatchObject({ status: 'active', lastEvaluation: { verdict: 'not_complete', reason: 'evaluator-invalid-or-unavailable' } });
    state = await invalid.service.evaluateAtSettlement({ settlement: settled, evaluate: async () => JSON.stringify({ complete: true, reason: 'unsupported', evidence: [] }) });
    expect(state.goal).toMatchObject({ status: 'active', lastEvaluation: { verdict: 'not_complete', reason: 'evaluator-invalid-or-unavailable' } });

    const hanging = harness({ evaluatorTimeoutMs: 5 });
    await hanging.create();
    state = await hanging.service.evaluateAtSettlement({ settlement: settled, evaluate: async () => new Promise(() => {}) });
    expect(state.goal).toMatchObject({ status: 'active', lastEvaluation: { reason: 'evaluator-timeout' } });

    const concurrent = harness();
    await concurrent.create();
    let resolve!: (value: string) => void;
    const evaluation = concurrent.service.evaluateAtSettlement({ settlement: settled, evaluate: () => new Promise(r => { resolve = r; }) });
    await Promise.resolve();
    const completed = await concurrent.service.execute({ action: 'complete', id: 'goal-1', revision: 1, reason: 'verified manually', evidence: ['green gate'] });
    resolve(JSON.stringify({ complete: false, reason: 'stale', evidence: [] }));
    state = await evaluation;
    expect(state).toEqual(completed);
    expect(state.goal?.status).toBe('complete');
  });

  it('redacts secrets from the runtime/evaluator projection', async () => {
    const { service } = harness();
    await service.execute({ action: 'create', condition: 'Use /Users/person/private token=secret-value and sk-1234567890 and ghp_1234567890', source: 'user', creator: 'ghp_1234567890' });
    expect(JSON.stringify(service.safeSnapshot())).not.toContain('secret-value');
    expect(JSON.stringify(service.safeSnapshot())).not.toContain('sk-1234567890');
    expect(JSON.stringify(service.safeSnapshot())).not.toContain('ghp_1234567890');
    expect(JSON.stringify(service.safeSnapshot())).not.toContain('/Users/person');
    expect(service.safeSnapshot()?.creator).toBe('redacted');
  });

  it("redacts GitLab's PAT-shaped prefixes beside GitHub's, and leaves an ordinary word alone", async () => {
    const { service } = harness();
    await service.execute({
      action: 'create',
      condition: 'Use glpat-ABCDEFGH12345678 and glrt-ABCDEFGH12345678 but keep globalization1234',
      source: 'user',
      creator: 'user',
    });
    const projected = JSON.stringify(service.safeSnapshot());
    expect(projected).not.toContain('glpat-ABCDEFGH12345678');
    expect(projected).not.toContain('glrt-ABCDEFGH12345678');
    // Negative control: a token-shaped word that matches no prefix rule survives, so the
    // alternation cannot have widened into "anything long".
    expect(projected).toContain('globalization1234');
  });
});

/**
 * P6.322 (H49) · the check-in ladder.
 *
 * `done_means` (1): "a goal blocked on a background task produces a check-in
 * after the configured interval and at lengthening intervals while idle, and
 * `0` disables it". The host's half — the notice text and where it is written —
 * is in `goal-reaches-every-runtime.test.ts`; what is unit-testable here is
 * WHEN one is due.
 */
describe('the goal check-in interval', () => {
  it('reads a positive value, honours 0 as OFF, and defaults with a diagnostic on junk', () => {
    expect(resolveGoalCheckInIntervalMs('5').ms).toBe(300_000);
    // "`0` disables it" — and `undefined` is the whole disabled representation,
    // so no caller has to remember a second spelling.
    expect(resolveGoalCheckInIntervalMs('0').ms).toBeUndefined();
    expect(resolveGoalCheckInIntervalMs(undefined).ms).toBe(DEFAULT_GOAL_CHECKIN_MINUTES * 60_000);
    const junk = resolveGoalCheckInIntervalMs('soon');
    // Falls to the DEFAULT, never to off: a misspelling must not look like a
    // working feature that simply never fires.
    expect(junk.ms).toBe(DEFAULT_GOAL_CHECKIN_MINUTES * 60_000);
    expect(junk.diagnostic).toContain(GOAL_CHECKIN_ENV);
    expect(resolveGoalCheckInIntervalMs('-3').diagnostic).toContain(GOAL_CHECKIN_ENV);
  });
});

/**
 * C4.31 (H49) · the claude runtime's own spelling, accepted as an alias.
 *
 * The positive is that the vendor's name alone configures the host timer — the
 * divergence the row exists to close, because the claude child reads that name
 * through the spawn's `process.env` spread and would otherwise check in on a
 * different period from the host. The negative is the precedence: the host's own
 * name outranks it whenever it carries a value, so nothing an operator already
 * wrote changes meaning.
 */
describe('C4.31 — the goal check-in interval answers to the claude spelling too', () => {
  it('honours the vendor name when only it is set, and names it in the diagnostic', () => {
    const claudeOnly = readGoalCheckInSetting({ [GOAL_CHECKIN_ENV_CLAUDE]: '5' });
    expect(claudeOnly).toEqual({ raw: '5', name: GOAL_CHECKIN_ENV_CLAUDE });
    expect(resolveGoalCheckInIntervalMs(claudeOnly.raw, claudeOnly.name).ms).toBe(300_000);

    // `0` means the same on both spellings, which is also what the page says of
    // the vendor's: "Set `0` to turn check-ins off."
    const off = readGoalCheckInSetting({ [GOAL_CHECKIN_ENV_CLAUDE]: '0' });
    expect(resolveGoalCheckInIntervalMs(off.raw, off.name).ms).toBeUndefined();

    // An operator told to fix the name they wrote, not the other one.
    const junk = readGoalCheckInSetting({ [GOAL_CHECKIN_ENV_CLAUDE]: 'soon' });
    const said = resolveGoalCheckInIntervalMs(junk.raw, junk.name).diagnostic;
    expect(said).toContain(GOAL_CHECKIN_ENV_CLAUDE);
    expect(said).not.toContain(`${GOAL_CHECKIN_ENV}=`);
  });

  it('gives the host name precedence, and an EMPTY host value does not mask the alias', () => {
    expect(readGoalCheckInSetting({
      [GOAL_CHECKIN_ENV]: '7',
      [GOAL_CHECKIN_ENV_CLAUDE]: '5',
    })).toEqual({ raw: '7', name: GOAL_CHECKIN_ENV });

    // `''` is already "not given" to the resolver, so it is not a choice here
    // either — clearing one name must not silently disable the other.
    expect(readGoalCheckInSetting({
      [GOAL_CHECKIN_ENV]: '  ',
      [GOAL_CHECKIN_ENV_CLAUDE]: '5',
    })).toEqual({ raw: '5', name: GOAL_CHECKIN_ENV_CLAUDE });

    // Neither set: the host's name is what a diagnostic would name, and the
    // resolver falls to the host's own default rather than the page's thirty.
    const none = readGoalCheckInSetting({});
    expect(none).toEqual({ raw: undefined, name: GOAL_CHECKIN_ENV });
    expect(resolveGoalCheckInIntervalMs(none.raw, none.name).ms)
      .toBe(DEFAULT_GOAL_CHECKIN_MINUTES * 60_000);
  });
});

describe('GoalService.dueCheckIn', () => {
  it('fires after the interval and then at lengthening intervals while nothing moves', async () => {
    const { service, create } = harness();
    await create();
    const created = service.snapshot().goal!.updatedAt;
    const interval = 60_000;

    // Nothing is due before the interval has passed — the negative that makes
    // every "it fired" below mean something.
    expect(service.dueCheckIn(created + interval - 1, interval)).toBeUndefined();

    const first = service.dueCheckIn(created + interval, interval);
    expect(first?.sequence).toBe(1);
    expect(first?.blocked).toBe(false);
    expect(first?.idleMs).toBe(interval);

    // 1x, then 2x, then 4x, then 8x for ever: each one measured from the
    // previous NOTICE, not from the goal.
    expect(service.dueCheckIn(created + interval + interval, interval)).toBeUndefined();
    expect(service.dueCheckIn(created + interval + 2 * interval, interval)?.sequence).toBe(2);
    let at = created + interval + 2 * interval;
    expect(service.dueCheckIn(at + 3 * interval, interval)).toBeUndefined();
    at += 4 * interval;
    expect(service.dueCheckIn(at, interval)?.sequence).toBe(3);
    expect(service.dueCheckIn(at + 7 * interval, interval)).toBeUndefined();
    at += 8 * interval;
    expect(service.dueCheckIn(at, interval)?.sequence).toBe(4);
    // Capped: the fifth waits 8x too, not 16x.
    at += 8 * interval;
    expect(service.dueCheckIn(at, interval)?.sequence).toBe(5);
  });

  it('is disabled by an absent interval, and by 0 through the resolver', async () => {
    const { service, create } = harness();
    await create();
    const created = service.snapshot().goal!.updatedAt;
    expect(service.dueCheckIn(created + 10 * 60_000, undefined)).toBeUndefined();
    expect(service.dueCheckIn(created + 10 * 60_000, resolveGoalCheckInIntervalMs('0').ms)).toBeUndefined();
  });

  it('restarts the ladder when the goal actually moves', async () => {
    const { service, create, advance } = harness();
    const state = await create();
    const interval = 60_000;
    const created = state.goal!.updatedAt;
    expect(service.dueCheckIn(created + interval, interval)?.sequence).toBe(1);
    // A recorded turn is a state change, so the goal is no longer idle and the
    // cadence starts over rather than continuing to lengthen.
    advance(interval + 1);
    await service.recordTurn({ turnId: 'turn-1', tokens: 10, costUsd: 0.01 });
    const moved = service.snapshot().goal!.updatedAt;
    expect(service.dueCheckIn(moved + interval, interval)?.sequence).toBe(1);
  });

  it('reports a BLOCKED goal as blocked, and reports nothing at all once the goal is terminal', async () => {
    const { service, create } = harness();
    await create();
    // `blocked` is reached only after the SAME external blocker is reported
    // three consecutive times — the service's own rule, not this row's — so the
    // fixture reports it three times rather than asserting on a status the first
    // call never produces.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const goal = service.snapshot().goal!;
      await service.execute({
        action: 'blocked',
        id: goal.id,
        revision: goal.revision,
        blockingCondition: 'waiting on the migration to finish',
        blockedBy: 'external',
        reason: 'the migration is still running',
        evidence: ['migration job 41 is queued'],
      });
    }
    expect(service.snapshot().goal!.status).toBe('blocked');
    const blockedAt = service.snapshot().goal!.updatedAt;
    const checkIn = service.dueCheckIn(blockedAt + 60_000, 60_000);
    expect(checkIn?.blocked).toBe(true);
    expect(checkIn?.goal.status).toBe('blocked');

    // The negative: a goal nobody is waiting on produces no check-ins.
    const cancelled = harness();
    const created = await cancelled.create();
    await cancelled.service.execute({
      action: 'cancel', id: created.goal!.id, revision: created.goal!.revision, reason: 'no longer needed',
    });
    const at = cancelled.service.snapshot().goal!.updatedAt;
    expect(cancelled.service.dueCheckIn(at + 10 * 60_000, 60_000)).toBeUndefined();
  });
});

/**
 * F1.464 (origin P-WJ-oo-2) — the judge-prompt redactor built its token alternation
 * from the COARSE prefix list alone, which has no `eyJ` or `ory_` entry, so a JWT or
 * an Ory token in a goal summary reached the evaluator prompt unless `Bearer` or
 * `token=` happened to precede it. The fix applies the tool-result scan's own table
 * first, so every family F1.365 added — and every other one — is masked here too.
 * Fixtures are random bytes, never a real token (F1.365's rule).
 */
describe('F1.464 — the judge-prompt redactor masks what the tool-result scan masks', () => {
  const b64url = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');

  async function promptFor(summary: string): Promise<string> {
    const { service, create } = harness();
    await create();
    let seen = '';
    await service.evaluateAtSettlement({
      settlement: settled,
      assistantSummary: summary,
      evaluate: async prompt => {
        seen = prompt;
        return JSON.stringify({ complete: false, reason: 'not yet', evidence: [] });
      },
    });
    return seen;
  }

  it('masks a JWT and an Ory token that no Bearer or token= precedes', async () => {
    const jwt = `eyJ${b64url(12)}.${b64url(12)}.${b64url(12)}`;
    const ory = `ory_at_${b64url(24)}`;
    const prompt = await promptFor(`jwt: ${jwt} and dp: ${ory}`);
    expect(prompt).toContain('You have no tools');
    expect(prompt).not.toContain(jwt);
    // The payload and signature segments must go too, not only the `eyJ` head.
    expect(prompt).not.toContain(jwt.split('.')[2]!);
    expect(prompt).not.toContain(ory);
    expect(prompt).toContain('[REDACTED');
  });

  it('masks a family the coarse prefix list never named (an AWS access key id)', async () => {
    const aws = `AKIA${'ABCDEFGHIJKLMNOP'.split('').sort(() => Math.random() - 0.5).join('')}`;
    const prompt = await promptFor(`key ${aws} rotated`);
    expect(prompt).not.toContain(aws);
  });

  it('leaves ordinary source alone (control)', async () => {
    const prompt = await promptFor('const sk = 1 and globalization1234');
    expect(prompt).toContain('const sk = 1 and globalization1234');
  });
});
