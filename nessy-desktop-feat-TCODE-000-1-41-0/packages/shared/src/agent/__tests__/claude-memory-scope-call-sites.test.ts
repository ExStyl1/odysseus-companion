/**
 * P6.390 (last hop) — the per-chat memory scope reaches the claude child.
 *
 * `getDefaultOptions` and `buildClaudeSubprocessEnv` grew a second parameter in
 * `6af9f2980` and `claude-auto-memory-off-switch.test.ts` drives that parameter
 * in both directions. What no test could see was that **nothing passed it**:
 * the arm was inert-but-safe, and inert-but-safe is exactly the state that looks
 * finished. The behaviour is already guarded; what is guarded here is the WIRE.
 *
 * A source scan is the right instrument and not a shortcut. `ClaudeAgent` cannot
 * be constructed without a live SDK session, so the only alternatives were an
 * end-to-end spawn or nothing — and the defect this catches is a call site added
 * later without the argument, which is a property of the text.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_AGENT = readFileSync(join(AGENT_DIR, 'claude-agent.ts'), 'utf8');
const PI_AGENT = readFileSync(join(AGENT_DIR, 'pi-agent.ts'), 'utf8');
const OPTIONS = readFileSync(join(AGENT_DIR, 'options.ts'), 'utf8');

/** Every `getDefaultOptions(` call in `claude-agent.ts`, with the 400 chars that follow. */
function callsWithTail(source: string, callee: string, tail: number): { line: number; text: string }[] {
  const needle = `${callee}(`;
  const found: { line: number; text: string }[] = [];
  let at = source.indexOf(needle);
  while (at !== -1) {
    found.push({
      line: source.slice(0, at).split('\n').length,
      text: source.slice(at, at + tail),
    });
    at = source.indexOf(needle, at + needle.length);
  }
  return found;
}

/**
 * The call's OWN argument list, bounded by its balanced parentheses rather than
 * by a character count.
 *
 * `callsWithTail`'s fixed window is right for "did the scan find anything at
 * all" and WRONG for "does this call carry the argument": measured 2026-09-08,
 * `claude-agent.ts`'s main option build had grown to put
 * `this.config.session?.memoryScopeOverride` **1716 characters** after the
 * call - past the 1400-char window - so the guard reported a MISSING argument
 * that is present three lines below the window's edge. A rule that cries wolf
 * is a rule people stop running, and this one had started.
 *
 * Parenthesis balance cannot rot the same way: it does not care how many
 * comments the object literal grows. It is naive about parens inside string
 * literals, which is acceptable here and stated rather than hidden - these two
 * calls take object literals of identifiers, and a false JOIN would make the
 * window LONGER, never shorter, so the scan can only become more permissive and
 * never produce the false alarm it exists to avoid.
 */
function callArguments(source: string, callee: string): { line: number; text: string }[] {
  const needle = `${callee}(`;
  const found: { line: number; text: string }[] = [];
  let at = source.indexOf(needle);
  while (at !== -1) {
    let depth = 0;
    let end = at + needle.length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push({
      line: source.slice(0, at).split('\n').length,
      text: source.slice(at, end + 1),
    });
    at = source.indexOf(needle, at + needle.length);
  }
  return found;
}

describe('P6.390 — every claude option build carries this chat\'s memory scope', () => {
  it('finds the call sites at all (the scan cannot pass vacuously)', () => {
    // Three at the time of writing: the main option build and the two
    // secondary ones. A fourth is a reason to read this file.
    expect(callsWithTail(CLAUDE_AGENT, 'getDefaultOptions', 400).length).toBeGreaterThanOrEqual(3);
  });

  it('passes `this.config.session?.memoryScopeOverride` at every one of them', () => {
    const missing = callArguments(CLAUDE_AGENT, 'getDefaultOptions')
      .filter(call => !call.text.includes('this.config.session?.memoryScopeOverride'))
      .map(call => `claude-agent.ts:${call.line}`);
    expect(missing).toEqual([]);
  });

  it('and `getDefaultOptions` forwards it — the other half of the wire', () => {
    // Without this the call sites could pass a value the function drops on the
    // floor, which is the same inert state the row is closing.
    expect(OPTIONS).toContain('buildClaudeSubprocessEnv(envOverrides, sessionMemoryScopeOverride)');
  });

  it('NEGATIVE — a bare call is reported', () => {
    const bare = callsWithTail('x = getDefaultOptions(this.config.envOverrides);\n', 'getDefaultOptions', 400);
    expect(bare.map(call => call.text.includes('memoryScopeOverride'))).toEqual([false]);
  });
});

/**
 * P6.795 - the same wire one axis along, and the same reason a SOURCE scan is
 * the instrument.
 *
 * `claude-context.ts` now resolves `memoryEnabled` on READ through
 * `resolveSessionMemoryScope` (`ccb1cc93f`), which discharged the row's
 * "invalidate the cached tools" clause by making there be nothing to freeze.
 * That fix is inert until a caller supplies `getMemoryScopeOverride`, and
 * "inert-but-safe is exactly the state that looks finished" is this file's own
 * sentence, one row earlier.
 *
 * **The accessor form is the assertion, not an incidental detail.**
 * `createClaudeContext` is called ONCE per agent and the context it returns is
 * held for that agent's life, so a captured VALUE would freeze the session's
 * memory scope as of construction - re-creating the bug one layer up from where
 * it was fixed, and in a place no behavioural test of `claude-context.ts` can
 * see. So the scan requires the arrow, not merely the field name.
 */
describe('P6.795 - every session-tool context build reads this chat\'s memory scope LAZILY', () => {
  it('finds the Pi call site at all (the scan cannot pass vacuously)', () => {
    expect(callsWithTail(PI_AGENT, 'createClaudeContext', 200).length).toBe(1);
  });

  it('passes `getMemoryScopeOverride` as an ACCESSOR at the Pi call site', () => {
    const missing = callArguments(PI_AGENT, 'createClaudeContext')
      .filter(call => !call.text.includes('getMemoryScopeOverride: () => this.config.session?.memoryScopeOverride'))
      .map(call => `pi-agent.ts:${call.line}`);
    expect(missing).toEqual([]);
  });

  it('NEGATIVE - a captured value would not satisfy the scan', () => {
    // The shape this test exists to reject, spelled out so the requirement is
    // legible rather than implied by a substring.
    const captured = 'getMemoryScopeOverride: this.config.session?.memoryScopeOverride';
    expect(captured.includes('getMemoryScopeOverride: () => this.config.session?.memoryScopeOverride')).toBe(false);
  });
});

/**
 * The control the two scans above need: `callArguments` must be able to say NO.
 *
 * Both assertions are "this list is empty", which a broken reader satisfies for
 * free. This drives the same function over a call it cannot find the argument in
 * and requires the miss to be reported.
 */
describe('the call scan can fail', () => {
  it('reports a call whose arguments do not carry the token', () => {
    const missing = callArguments(CLAUDE_AGENT, 'getDefaultOptions')
      .filter(call => !call.text.includes('a token no call site contains'))
      .map(call => call.line);
    expect(missing.length).toBeGreaterThanOrEqual(3);
  });
});
