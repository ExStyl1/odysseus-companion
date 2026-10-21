/**
 * The `eval` floor — the half of a two-floor doc sentence this repo did not have.
 *
 * `agent-sdk/secure-deployment.md#built-in-security-features`, the
 * "Command parsing for permissions" bullet: "A small set of constructs such as
 * `eval` always require approval regardless of allow rules. This is a permission
 * gate, not a sandbox; apart from built-in safety checks such as the
 * critical-path check on `rm` and `rmdir` and the protected paths list, it does
 * not infer whether a command is dangerous from its target path or effects."
 *
 * Both named safety checks in that sentence's tail were already implemented
 * (`findRootOrHomeRemoval`, `findProtectedPathWrite`); the `eval` clause — the
 * only one that says "regardless of allow rules" in so many words — had no
 * implementation at all before 2026-08-28.
 *
 * ## What was MEASURED before this file existed
 *
 * `findRootOrHomeRemoval` called directly with `{home:'/Users/probe',
 * platform:'darwin'}`:
 *   - `rm -rf ~`          -> breaker fires   (positive control)
 *   - `rm -rf /`          -> breaker fires   (positive control)
 *   - `eval "rm -rf ~"`   -> null
 *   - `eval "rm -rf /"`   -> null
 *   - `ls`                -> null            (negative control)
 * So wrapping the one command the breaker exists to stop in the one construct
 * the page says always needs approval produced NO floor on any runtime. That is
 * pinned below by `the breaker still does not see through eval`, which is a
 * DELIBERATE record of a gap rather than a promise: if the breaker later learns
 * to expand `eval`, that test fails and the ordering comment on
 * `firstNonNegotiableFloor` is what should be re-read.
 *
 * SAFETY: every string here is DATA handed to a pure matcher. Nothing in this
 * file spawns a process, and no `rm` in it can run.
 */
import { describe, expect, it } from 'bun:test';
import {
  findNonNegotiableFloors,
  findShellEvalConstruct,
  firstNonNegotiableFloor,
} from '../pre-tool-use.ts';
import { findRootOrHomeRemoval } from '../../pi-harness/removal-circuit-breaker.ts';
import { PERMISSION_MODE_AGENT_LABELS, PERMISSION_MODE_ORDER, type PermissionMode } from '../../mode-types.ts';

/** `eval` in command-word position. Each fires the floor. */
const RUNS_EVAL: string[] = [
  'eval "$CMD"',
  'eval',
  'ls && eval "$X"',
  'ls; eval x',
  'ls | eval x',
  'echo $(eval echo hi)',
  'echo `eval x`',
  'FOO=1 eval x',
  'FOO="a b" BAR=c eval x',
  'if eval "$x"; then echo ok; fi',
  'while eval x; do :; done',
  '{ eval x; }',
  '(eval x)',
  'eval "rm -rf ~"',
];

/**
 * `eval` as a substring, an argument, a filename or a flag. None fires.
 *
 * These are the negative controls that stop "the floor is green" from also
 * being satisfied by a matcher that fires on every command containing the four
 * letters — which is the failure mode a substring search would have.
 */
const DOES_NOT_RUN_EVAL: string[] = [
  'grep eval file.txt',
  'cat eval.txt',
  'node --eval "1+1"',
  'echo "evaluate"',
  './eval',
  'git evaluate',
  'evaluate_thing',
  'FOO=eval',
  'rg --files | xargs grep -l eval',
  'bun test packages/shared/src/agent/__tests__/eval.test.ts',
  'ls -la',
];

describe('the eval floor matches eval in command position and nothing else', () => {
  it.each(RUNS_EVAL)('fires on %j', command => {
    expect(findShellEvalConstruct(command)).toEqual({ command, construct: 'eval' });
  });

  it.each(DOES_NOT_RUN_EVAL)('does not fire on %j', command => {
    expect(findShellEvalConstruct(command)).toBeNull();
  });
});

describe('the eval floor is wired into the shared floor function', () => {
  it('is set for a Bash call that runs eval', () => {
    const floors = findNonNegotiableFloors('Bash', { command: 'eval "$X"' }, 'default');
    expect(floors.shellEvalConstruct).toEqual({ command: 'eval "$X"', construct: 'eval' });
  });

  it('is the verdict firstNonNegotiableFloor returns, as a prompt', () => {
    const verdict = firstNonNegotiableFloor(
      findNonNegotiableFloors('Bash', { command: 'eval "$X"' }, 'default'),
    );
    expect(verdict?.floor).toBe('shellEval');
    expect(verdict?.outcome).toBe('prompt');
    // The description must name the construct: a prompt indistinguishable from
    // every other prompt collects the same reflexive approval.
    expect(verdict?.description).toContain('eval');
  });

  it('is not set for a non-Bash tool whose input merely contains the text', () => {
    // The floor is about a SHELL construct. A file path that happens to read
    // like one is not one, and a floor that fired here would block reads of
    // this very test file.
    const floors = findNonNegotiableFloors('Read', { file_path: '/repo/x; eval y' }, 'default');
    expect(floors.shellEvalConstruct).toBeNull();
  });

  it('leaves the common case allocating nothing', () => {
    const floors = findNonNegotiableFloors('Bash', { command: 'ls -la' }, 'default');
    expect(floors.shellEvalConstruct).toBeNull();
    expect(firstNonNegotiableFloor(floors)).toBeNull();
  });
});

describe('the eval floor fires in every mode except bypassPermissions', () => {
  // Table over the REAL mode list rather than a hand-copied one, so a mode
  // added later is covered here on the day it is added.
  const modes: PermissionMode[] = PERMISSION_MODE_ORDER;

  it('covers every mode the product ships', () => {
    // Guards the table above against a truncated PERMISSION_MODE_ORDER by comparing
    // it, as a set, with a Record<PermissionMode, …> the compiler holds
    // exhaustive over the union — never a hand count, which went stale when
    // F1.1050 retired `explore` (seven modes -> six).
    expect(Object.keys(PERMISSION_MODE_AGENT_LABELS).sort()).toEqual([...modes].sort());
    expect(modes).toContain('bypassPermissions');
  });

  it.each(modes.filter(mode => mode !== 'bypassPermissions'))('fires in %s', mode => {
    expect(
      findNonNegotiableFloors('Bash', { command: 'eval "$X"' }, mode).shellEvalConstruct,
    ).not.toBeNull();
  });

  it('does not fire in bypassPermissions', () => {
    // `permission-modes.md`'s "actions no mode auto-approves" list — the one
    // that really does bind bypassPermissions — names the rm/rmdir critical-path
    // removal and does NOT name eval. The doc sentence scopes eval to allow
    // RULES, so this floor must have the protected-path floor's shape and not
    // the breaker's. A test that asserted the opposite would make
    // `--dangerously-skip-permissions` stop being what it says.
    expect(
      findNonNegotiableFloors('Bash', { command: 'eval "$X"' }, 'bypassPermissions')
        .shellEvalConstruct,
    ).toBeNull();
  });

  it('does not weaken the removal circuit breaker, which bypassPermissions never skips', () => {
    // Negative control for the row above: the mode read is per-floor, not
    // global, so turning eval off in bypassPermissions must not have turned the
    // breaker off with it.
    expect(
      findNonNegotiableFloors('Bash', { command: 'rm -rf ~' }, 'bypassPermissions')
        .removalCircuitBreaker,
    ).not.toBeNull();
  });
});

describe('the gap this floor stands in', () => {
  it('the breaker still does not see through eval', () => {
    const options = { home: '/Users/probe', platform: 'darwin' as NodeJS.Platform };
    // Positive controls first — an absence finding without one is not a finding.
    expect(findRootOrHomeRemoval('rm -rf ~', options)).not.toBeNull();
    expect(findRootOrHomeRemoval('rm -rf /', options)).not.toBeNull();
    expect(findRootOrHomeRemoval('ls', options)).toBeNull();
    // The gap. If this line starts failing, the breaker learned to expand
    // `eval`; re-read the ordering comment on `firstNonNegotiableFloor` rather
    // than deleting this test.
    expect(findRootOrHomeRemoval('eval "rm -rf ~"', options)).toBeNull();
  });

  it('so the eval floor is what answers eval "rm -rf ~" today', () => {
    const verdict = firstNonNegotiableFloor(
      findNonNegotiableFloors('Bash', { command: 'eval "rm -rf ~"' }, 'default'),
    );
    expect(verdict?.floor).toBe('shellEval');
  });
});
