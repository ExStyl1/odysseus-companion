/**
 * DA1.7 (T7), the second half — the static scan that keeps the adapter's
 * `opts.jwt` seam harmless in PRODUCTION.
 *
 * `packages/codex-responses-adapter/src/server.ts` symbol `resolveGatewayJwt`
 * prefers an injected `opts.jwt` over `readNestorJwt()`, which bypasses that
 * file's shape gate (and, after DA1.12, its expiry gate too). The seam is pinned
 * from the adapter side by
 * `packages/codex-responses-adapter/src/__tests__/jwt-injection-seam.test.ts`;
 * what makes it SAFE is that no production caller injects. This file asserts
 * exactly that, over the only two production callers there are.
 *
 * **Scoped to those two files BY NAME, deliberately, and not by a tree grep.**
 * A tree grep would sweep in the 13 adapter test files — 71 injected `jwt`
 * literals between them, re-counted at HEAD on 2026-09-13 — and the only other
 * caller, `packages/codex-responses-adapter/scripts/reliability-probe.mjs`,
 * which injects on purpose and is a probe script, not production. A scan whose
 * scope is the whole tree would therefore have to carry an exception list, and
 * an exception list is what hides the next real call site.
 *
 * **The scan reads the CALL EXPRESSION, not the file.** `codex-agent.ts` spells
 * `jwt` in `queryLlm` (which calls `readNestorJwt()` on its own path, not
 * through the adapter) and in a docblock naming `auth/dp/jwt.ts`, so a
 * file-wide `not.toContain('jwt')` would fail on code that is correct — the
 * stale-NAME-guard trap in AGENTS.md §Traps. The balanced-argument extraction
 * below is what makes the assertion mean what it says.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The two production callers, by name. Nothing else is in scope. */
const PRODUCTION_CALLERS = ['../claude-agent.ts', '../codex-agent.ts'] as const;

/**
 * Every `startAdapter(<balanced argument text>)` in `source`.
 *
 * Balanced over `(` / `)` so a nested call or object literal inside the options
 * cannot end the extraction early; string and comment contents are not parsed,
 * which is sound here because both call sites are ordinary option objects.
 */
function startAdapterArguments(source: string): string[] {
  const found: string[] = [];
  const needle = 'startAdapter(';
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    let depth = 0;
    for (let i = at + needle.length - 1; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          found.push(source.slice(at + needle.length, i));
          break;
        }
      }
    }
  }
  return found;
}

/**
 * A `jwt` property at any nesting level of the extracted argument text, in BOTH
 * spellings — `jwt: value` and the ES6 shorthand `{ jwt }`. The shorthand is not
 * hypothetical: `packages/codex-responses-adapter/scripts/reliability-probe.mjs`
 * injects exactly that way, so a matcher requiring the colon would call the one
 * real injecting caller in this tree clean.
 */
const INJECTS_JWT = /(^|[\s,{(])jwt\s*(?::|,|\}|$)/;

describe('DA1.7 · neither production `startAdapter` caller injects a jwt', () => {
  for (const relative of PRODUCTION_CALLERS) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');
    const calls = startAdapterArguments(source);

    /**
     * The POSITIVE CONTROL for the extractor, and it is why the assertion below
     * is evidence rather than an empty set passing vacuously: each of the two
     * files really does call `startAdapter` once, and the text extracted from it
     * really does carry the option key both call sites pass. Answered 1 call per
     * file, both carrying `upstream`, on 2026-09-13 — written as prose because a
     * declared count here would be a ratchet on a number that is allowed to move
     * (AGENTS.md §Traps, the absence-probe rule).
     */
    it(`${relative} — the extractor sees a real call (control)`, () => {
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((text) => text.includes('upstream'))).toBe(true);
    });

    it(`${relative} — passes no \`jwt\` key, so the shape gate is the only gate`, () => {
      const injecting = calls.filter((text) => INJECTS_JWT.test(text));
      // If this ever fires: the fix is NOT to delete the key here. A production
      // caller that injects makes `readNestorJwt`'s shape and expiry rules
      // unreachable for that runtime, so either the value must be gated at the
      // call site or `resolveGatewayJwt` must grow the guard this row priced and
      // declined (69 test call-site edits, DA1.7).
      expect(injecting).toEqual([]);
    });
  }

  /**
   * The NEGATIVE control for the matcher itself: an injecting call MUST be
   * detected. Without it a typo in `INJECTS_JWT` would leave both assertions
   * above passing over a real injection. The literal is the shape the probe
   * script uses.
   */
  it('the matcher detects an injecting call, in both spellings (negative control)', () => {
    const [shorthand] = startAdapterArguments('await startAdapter({ jwt, onRetryRung: (r) => rungs.push(r) })');
    expect(INJECTS_JWT.test(`${shorthand}`)).toBe(true);
    const [explicit] = startAdapterArguments("await startAdapter({ upstream, jwt: 'x' })");
    expect(INJECTS_JWT.test(`${explicit}`)).toBe(true);
    // And it does not fire on a neighbouring key that merely starts the same
    // way, which is the failure mode a bare substring guard has.
    const [neighbour] = startAdapterArguments('await startAdapter({ upstream, jwtRefreshHook })');
    expect(INJECTS_JWT.test(`${neighbour}`)).toBe(false);
  });
});
