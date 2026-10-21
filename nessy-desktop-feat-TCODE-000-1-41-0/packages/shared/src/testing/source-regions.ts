/**
 * D1.111 — the ONE brace matcher for tests that assert on source TEXT, and the
 * rule that has to travel with it.
 *
 * ## The class this exists for
 *
 * A test that reads a module's own source and asserts on a region of it has to
 * bound that region somehow, and the cheap way is a character count:
 * `src.slice(start, start + 2_000)`. Such a window is a stale-count guard
 * wearing a number, and it rots in BOTH directions:
 *
 * - it grows PAST the region and starts matching the neighbour, so a negative
 *   assertion goes red against correct code;
 * - the region grows past IT and the positive assertion goes red against
 *   correct code.
 *
 * Either way the red lands on a case named for something else, which is what
 * makes this expensive: `3fb393853`'s window rotted three times (the spread it
 * looked for moved 1 225 → 1 526 → 2 127) and the 1.36.0 wave gate reported the
 * file red while the source under it was right. Re-measured 2026-09-17 with
 * `git grep -anI -E 'slice\([A-Za-z_][A-Za-z0-9_.]*, *[A-Za-z_][A-Za-z0-9_.]* *\+ *[0-9_]{3,}\)'
 * -- packages apps`: **47 such windows over 34 test files**, every one a
 * source-text read. (That command is the worklist; the number is a reading with
 * a date, not a fact.)
 *
 * ## What replaces it
 *
 * The braces the region already has. `bracedRegion` returns from `start` to the
 * `}` that closes the first `{` at or after it — a method body, an arrow body,
 * an `if` block, an object literal — so the assertion is bounded by the thing it
 * was always about and no number has to be maintained.
 *
 * ## THE BOUNDARY CONTROL IS NOT OPTIONAL
 *
 * A brace scan that runs away returns the rest of the file, and a POSITIVE
 * assertion over the rest of the file passes for a match anywhere in the module
 * — silently, which is worse than the window it replaced. So every caller adds
 * one line naming an anchor that must be OUTSIDE the region:
 *
 * ```ts
 * const body = bracedRegion(src, src.indexOf('private deliverAsyncHookNote('))
 * expect(body).toContain('…')                       // the claim
 * expect(body).not.toContain('<the next method>')   // the control
 * ```
 *
 * A caller whose region already carries a `not.toContain` of its own has its
 * control for free; the ones that do not gain the line.
 *
 * **And the rule now has a reader.** `scripts/check-braced-region-controls.ts`
 * (D1.243) resolves each call site's anchor to the source it is read from and
 * fails a `not.toContain` whose needle's last occurrence sits ABOVE the anchor,
 * plus a call site carrying no control at all. It is a text scanner, so a site
 * whose source it cannot resolve is REPORTED as unresolved and never passed —
 * an unresolved site is the absence of a reading, not a clean one.
 *
 * ## AND CHECK THE ANCHOR, not only the size
 *
 * The same row found a window whose ANCHOR was wrong, which no amount of sizing
 * would have fixed: `session-job-dir-lifecycle.test.ts` bounded its control with
 * `source.indexOf('disposeManagedAgentRuntime(')`, and the first occurrence of
 * that substring in `SessionManager.ts` is a CALL SITE thousands of lines above
 * the definition — so the control read 4 000 characters of an unrelated method
 * and could never have failed. Anchor on the DECLARATION (`private async
 * disposeManagedAgentRuntime(`), and assert the anchor was found.
 *
 * ## What this deliberately does NOT do
 *
 * It does not parse. Braces inside a string, a regular expression or a comment
 * are counted like any other, so it is honest only over code whose braces
 * balance textually — which is every hand-written TypeScript module in this
 * tree and is NOT a minified bundle. For `sdk.mjs` and friends, bound the region
 * with an end ANCHOR read out of the bundle instead (AGENTS.md §Traps: a count
 * over a minified file measures the minifier).
 */
export const bracedRegion = (text: string, start: number): string => {
  if (start < 0) throw new Error('bracedRegion: the anchor was not found (start < 0)')
  const open = text.indexOf('{', start)
  if (open < 0) throw new Error('bracedRegion: no `{` at or after the given start')
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  throw new Error('bracedRegion: unbalanced braces from the given start')
}
