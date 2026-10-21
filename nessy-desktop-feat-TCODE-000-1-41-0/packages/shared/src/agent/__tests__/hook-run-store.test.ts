/**
 * P6.643 - the per-session hook-run store and the `/hooks` half that reads it.
 *
 * P6.294 built the bindings listing: what WILL run. P6.449 built `reportHookRun`:
 * the one reading of what a run did. Nothing kept a run, so the question a user
 * asks the moment a hook misbehaves - *did it run, and what happened* - had no
 * answer anywhere in the product. These are the store's two bounds, its
 * formatter contract, and the listing.
 */
import { describe, expect, it } from 'bun:test';
import {
  HOOK_RUN_STORE_MAX_PER_HOOK,
  HookRunStore,
  hookRunKey,
  reportHookRun,
  type HookRunObservation,
} from '../hook-run-report.ts';
import {
  HOOK_RUNS_NONE_LINE,
  formatHookRunHistoryReport,
} from '../../slash-commands/hooks-command.ts';

function observation(overrides: Partial<HookRunObservation> = {}): HookRunObservation {
  return {
    runtime: 'host',
    event: 'PreToolUse',
    name: 'guard/no-secrets',
    outcome: 'error',
    exitCode: 2,
    stderr: 'refused: token in argv',
    ...overrides,
  };
}

describe('P6.643 · HookRunStore', () => {
  it('formats through reportHookRun, so the store and the transcript cannot disagree', () => {
    const store = new HookRunStore();
    const run = observation();

    const stored = store.record(run);

    // Read the value into a local first: asserting a shape with an asymmetric
    // matcher would overwrite the field on the object under test.
    const direct = reportHookRun(run);
    expect(stored).toEqual(direct);
    const groups = store.groups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runs[0]!.report.message).toBe(direct.message!);
    expect(groups[0]!.label).toBe('guard/no-secrets');
  });

  it('keys by event AND hook, and not by runtime', () => {
    // One command bound to two events is two things a user reads separately.
    expect(hookRunKey(observation({ event: 'PreToolUse' })))
      .not.toBe(hookRunKey(observation({ event: 'Stop' })));
    // A runtime switch must not split one hook's history in two.
    expect(hookRunKey(observation({ runtime: 'claude' })))
      .toBe(hookRunKey(observation({ runtime: 'codex' })));
    // With no name of its own, a hook is known by the event it matched.
    const unnamed = observation({ name: undefined });
    expect(hookRunKey(unnamed)).toBe('PreToolUse PreToolUse');
  });

  it('keeps the last N runs of each hook and drops the least recently run hook', () => {
    const store = new HookRunStore(2, 2);

    for (const stderr of ['first', 'second', 'third']) {
      store.record(observation({ stderr }));
    }
    const window = store.groups()[0]!.runs;
    // The per-hook bound: the window slid, oldest-first inside it.
    expect(window).toHaveLength(2);
    expect(window[0]!.report.message).toContain('second');
    expect(window[1]!.report.message).toContain('third');

    // The second bound, which the per-hook one cannot supply: a session firing
    // many DISTINCT hooks must not grow without limit.
    store.record(observation({ name: 'b' }));
    store.record(observation({ name: 'c' }));
    const labels = store.groups().map(group => group.label);
    expect(labels).toEqual(['c', 'b']);
    expect(labels).not.toContain('guard/no-secrets');
  });

  it('records a SUCCESS, which is the one thing the transcript never shows', () => {
    const store = new HookRunStore();

    // hooks.md#exit-code-0: stderr from a hook that exits 0 "goes to the debug
    // log only, never the transcript". So a successful run has no message and
    // this store is where its output becomes legible at all.
    const report = store.record(observation({ outcome: 'success', exitCode: 0, stderr: 'checked 4 files' }));

    expect(report.message).toBeUndefined();
    expect(store.groups()[0]!.runs[0]!.report.detail).toBe('checked 4 files');
  });
});

describe('P6.643 · the /hooks run listing', () => {
  it('says nothing has run rather than pretending no hooks exist', () => {
    // The negative that matters: "no hook has RUN" and "no hooks are
    // CONFIGURED" are different facts, and the bindings half already owns the
    // second sentence.
    expect(formatHookRunHistoryReport([], HOOK_RUN_STORE_MAX_PER_HOOK)).toBe(HOOK_RUNS_NONE_LINE);
  });

  it('prints outcome and text newest-first, and announces the bound when a window is full', () => {
    const store = new HookRunStore(2, 5);
    store.record(observation({ stderr: 'older failure' }));
    store.record(observation({ stderr: 'newer failure' }));

    const report = formatHookRunHistoryReport(store.groups(), 2);

    expect(report).toContain('guard/no-secrets (PreToolUse)');
    expect(report).toContain('2 runs');
    expect(report).toContain('error');
    expect(report).toContain('newer failure');
    // Newest first inside a hook: the run a user is looking for is the last one.
    expect(report.indexOf('newer failure')).toBeLessThan(report.indexOf('older failure'));
    // The bound is announced, so a reader cannot conclude the hook fired twice
    // when it fired forty times.
    expect(report).toContain('Only the last 2 runs of each hook are kept.');
  });

  it('does not announce a bound that was not reached', () => {
    const store = new HookRunStore();
    store.record(observation());

    expect(formatHookRunHistoryReport(store.groups(), HOOK_RUN_STORE_MAX_PER_HOOK))
      .not.toContain('Only the last');
  });
});
