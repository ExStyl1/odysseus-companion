/**
 * GRANT-GLOB-NEWLINE — one decision, written once, pinned across every compiler
 * it applies to. **If you arrived here from an `s`-flag sweep, read this file
 * before adding a flag: the omission is deliberate at four of these five sites,
 * and the fifth is SPLIT BY DIRECTION rather than flagged.**
 *
 * ## The decision
 *
 * A glob `*` in a compiler that GRANTS does **not** cross a line terminator, and
 * we are not adding the `s` flag to make it. Deny-side compilers were fixed the
 * other way, and that asymmetry is intentional.
 *
 * ## Why, on the documentation rather than on taste
 *
 * `settings-reference.md#sandbox-excludedcommands`: "Each entry uses the same
 * syntax as the content of a `Bash(...)` permission rule: an exact command, a
 * prefix such as `docker *`, or a wildcard pattern."
 *
 * `permissions.md#bash`: "The recognized command separators are `&&`, `||`, `;`,
 * `|`, `|&`, `&`, and newlines. A rule must match each subcommand
 * independently."
 *
 * So in the one grant compiler that judges a COMMAND, a newline is a documented
 * separator. A `*` crossing it would let one entry approve text on both sides of
 * a separator it never inspected — which is what that sentence forbids, and what
 * the measurement below shows costs a sandbox.
 *
 * The pages are silent on whether `*` crosses a terminator inside a quoted
 * argument or a path; the only mention of newlines across `sandboxing.md`,
 * `permissions.md`, `plugin-relevance.md` and `memory.md` is the separator
 * sentence quoted above. Where the documentation is silent the choice is ours,
 * and it is made in the restrictive direction: widening a grant buys nothing
 * measured and costs the case below.
 *
 * ## Two corrections to the premise these rows were opened on
 *
 * 1. **`agent/mode-manager.ts` is NOT a grant compiler.** `globToRegex` has six
 *    callers, and `matchesDeniedPath` — the `deniedPaths` floor that carries
 *    `**​/.ssh/**` as a managed lock — is one of them. One `s` there would tighten
 *    a deny and widen `matchesAllowedWritePath` in the same edit. **RESOLVED by
 *    P2.344: the compiler now takes an explicit per-call-site direction**, the
 *    two deny-path calls cross a terminator and the grant does not, and
 *    `agent/__tests__/denied-path-line-terminator.test.ts` holds both halves.
 *    §2 below is unchanged and is the measurement that the grant did not move:
 *    `matchesToolPattern` is bidirectional AT ITS CALL SITES (`allowedTools` and
 *    `disallowedTools` are the same function), so it keeps the grant policy.
 * 2. **The five are not uniformly newline-blind.** In three of them `*` compiles
 *    to `[^/]*`, a negated class that already crosses a terminator, while `**`
 *    compiles to `.*` and does not. So "leave them alone" preserves an
 *    inconsistency rather than a policy. It is recorded here, not endorsed.
 *
 * Every terminator below is a literal character: `'\n'` in an ordinary string is
 * the two-character escape, which matched all along and proves nothing.
 */
import { describe, expect, it } from 'bun:test';
import { matchExcludedCommand } from '../sandbox-settings.ts';
import { matchesToolPattern } from '../../agent/mode-manager.ts';
import { matchingRulePatterns } from '../../agent/memory/rule-matching.ts';
import { matchesHttpHookUrlPattern } from '../../plugins/http-hook-env.ts';
import { matchCwdSignal } from '../../marketplace/relevance.ts';

const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const TERMINATORS = [LF, CR, LINE_SEPARATOR, PARAGRAPH_SEPARATOR];

it('uses literal terminators, so these assertions can fail at all', () => {
  for (const terminator of TERMINATORS) expect(terminator).toHaveLength(1);
  expect(LF).not.toBe(String.raw`\n`);
});

describe('1. sandbox-settings globMatches — the decision that matters', () => {
  // `matchExcludedCommand` feeds `ProcessSupervisor.resolveIsolationDowngrade`
  // (a match runs the command OUTSIDE the sandbox) and `pre-tool-use.ts` (a
  // match forces the risky band). One function, two directions.

  it('refuses every terminator, so `docker *` cannot unsandbox a second command', () => {
    expect(matchExcludedCommand('docker ps', ['docker *'])).toBe('docker *');
    for (const terminator of TERMINATORS) {
      // THIS is the case the decision is made on. `docker ps<LF>rm -rf $HOME` is
      // two commands the shell runs in sequence; with `s` the single entry
      // `docker *` would run BOTH of them outside isolation.
      expect(matchExcludedCommand(`docker ps${terminator}rm -rf $HOME`, ['docker *'])).toBeUndefined();
      expect(matchExcludedCommand(`docker run${terminator}x`, ['*docker*'])).toBeUndefined();
    }
  });

  it('is unchanged for every command without one, which is the whole corpus in practice', () => {
    expect(matchExcludedCommand('docker compose up', ['docker *'])).toBe('docker *');
    expect(matchExcludedCommand('sudo docker ps', ['docker *'])).toBeUndefined();
    expect(matchExcludedCommand('rm -rf /', ['docker *', 'go *'])).toBeUndefined();
  });
});

describe('2. mode-manager globToRegex — bidirectional, so a flag was the wrong instrument', () => {
  // `matchesToolPattern` is the exported seam onto the same compiler that
  // `matchesAllowedWritePath` (grant) and `matchesDeniedPath` (deny) use. Since
  // P2.344 that compiler takes a direction per call site; this seam asks for the
  // GRANT policy and these assertions are what proves it still gets it.

  it('has a `**` arm that stops at a terminator', () => {
    expect(matchesToolPattern('a/b', ['**'], 'test')).toBe('**');
    for (const terminator of TERMINATORS) {
      expect(matchesToolPattern(`a${terminator}b`, ['**'], 'test')).toBeNull();
    }
  });

  it('has a `?` arm that stops at a terminator', () => {
    expect(matchesToolPattern('axb', ['a?b'], 'test')).toBe('a?b');
    expect(matchesToolPattern(`a${LF}b`, ['a?b'], 'test')).toBeNull();
  });

  it('CORRECTION: its `*` arm already crosses one, so the compiler is inconsistent', () => {
    // `*` -> `[^/]*`, a negated class, which includes a terminator. The NARROWER
    // wildcard crosses and the broader one does not. Recorded, not endorsed:
    // reconciling it is a behaviour change on a live deny floor.
    expect(matchesToolPattern(`a${LF}b`, ['*'], 'test')).toBe('*');
  });
});

describe('3. http-hook-env pathMatches — inert, and proven inert rather than assumed', () => {
  it('never sees a terminator, because URL parsing removes it first', () => {
    expect(matchesHttpHookUrlPattern('https://h.example/hooks/a', 'https://h.example/hooks/*')).toBe(true);
    // Positive control for the absence claim: the raw LF is STRIPPED by `new URL`,
    // so `pathname` is `/hooks/ab` and the pattern matches for a reason that has
    // nothing to do with the missing flag.
    expect(new URL(`https://h.example/hooks/a${LF}b`).pathname).toBe('/hooks/ab');
    expect(matchesHttpHookUrlPattern(`https://h.example/hooks/a${LF}b`, 'https://h.example/hooks/*')).toBe(true);
    // And an encoded one stays encoded, so it is ordinary text either way.
    expect(matchesHttpHookUrlPattern('https://h.example/hooks/a%0Ab', 'https://h.example/hooks/*')).toBe(true);
  });
});

describe('4. marketplace relevance — a ranking signal, not a permission decision', () => {
  it('has the same `**` behaviour and the same verdict: leave it', () => {
    const relevance = { signals: { cwd: ['/infra/**'] } } as Parameters<typeof matchCwdSignal>[0];
    expect(matchCwdSignal(relevance, { workingDirectory: '/infra/a/b' })).toBe('cwd');
    expect(matchCwdSignal(relevance, { workingDirectory: `/infra/a${LF}b` })).toBeUndefined();
  });
});

describe('5. memory rule-matching — a rule selector, not a permission decision', () => {
  it('has a trailing `**` that stops at a terminator while `*` and `?` cross', () => {
    expect(matchingRulePatterns(['src/**'], 'src/a/b.ts')).toHaveLength(1);
    expect(matchingRulePatterns(['src/**'], `src/a${LF}b.ts`)).toHaveLength(0);
    // Same inconsistency as mode-manager: `[^/]`-based arms already cross.
    expect(matchingRulePatterns(['*.ts'], `a${LF}b.ts`)).toHaveLength(1);
    expect(matchingRulePatterns(['a?.ts'], `a${LF}.ts`)).toHaveLength(1);
  });
});

// A sixth compiler, `agent/local-tools/runtime.ts` `compileFindPattern`, carries the
// same omission. It is private, it filters file-search results, and it decides
// no permission — the verdict is the same and it is recorded rather than pinned,
// because a test would only assert that a search filter is a search filter.
