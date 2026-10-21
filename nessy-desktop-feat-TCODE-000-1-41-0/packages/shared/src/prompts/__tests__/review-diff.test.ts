/**
 * P3.276 — the host-computed diff is one computation, and it is reachable by a
 * runtime that is not Pi.
 *
 * The behavioural cases for the six target modes live where they already were,
 * in `pi-agent-server/src/orchestrator/review-tool.test.ts` (which now imports
 * `computeReviewDiffWithGit` from THIS module, so that suite is a real consumer
 * rather than a copy). What is asserted here is only what the move itself
 * claims: the module carries no runtime of its own, and the two seams that had
 * to change for it to leave the Pi tool behave.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  REVIEW_DIFF_CAP_BYTES,
  buildReviewTask,
  capReviewDiff,
  describeReviewTarget,
  normalizeReviewTarget,
} from '../review-diff.ts';

const SOURCE = readFileSync(fileURLToPath(new URL('../review-diff.ts', import.meta.url)), 'utf8');

describe('the diff is runtime-neutral', () => {
  it('imports nothing from a runtime package', () => {
    // The tripwire for the row's own claim. `review-tool.ts` pulls in
    // `@earendil-works/pi-coding-agent`, the Pi spawner and the Pi child-session
    // port; a single one of those reaching this file would make "uniform for
    // three" false again while every behavioural test stayed green.
    const imports = [...SOURCE.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map(match => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier.includes('pi-agent-server')).toBe(false);
      expect(specifier.includes('pi-harness')).toBe(false);
      expect(specifier.startsWith('@earendil-works')).toBe(false);
      expect(specifier.startsWith('@nessy-agent/')).toBe(false);
    }
  });
});

describe('normalizeReviewTarget', () => {
  it('defaults to the documented scope', () => {
    // `code-review.md:293` — "It reviews your branch's commits ahead of its
    // upstream plus any uncommitted changes".
    expect(normalizeReviewTarget({})).toEqual({ mode: 'upstream' });
    expect(describeReviewTarget({ mode: 'upstream' }))
      .toBe('this branch\'s commits ahead of its upstream plus any uncommitted changes');
  });

  it('carries the caller\'s effort and instructions without owning their vocabulary', () => {
    // The seam that let the computation leave the Pi tool: `effort` is a
    // ThinkingLevel there and a plain string here, so a second runtime with a
    // different effort vocabulary needs no change in this module.
    expect(normalizeReviewTarget({ base: 'main' }, { effort: 'xhigh', instructions: 'watch the locks' }))
      .toEqual({ mode: 'base', ref: 'main', effort: 'xhigh', instructions: 'watch the locks' });
  });

  it('refuses two targets rather than silently picking one', () => {
    expect(() => normalizeReviewTarget({ base: 'main', commit: 'abc' }))
      .toThrow('review accepts at most one target');
    expect(() => normalizeReviewTarget({ scope: 'uncommitted', base: 'main' }))
      .toThrow('review accepts scope only without a target');
  });
});

describe('what the isolated reviewer receives', () => {
  it('caps the diff and says that it did', () => {
    const under = 'a'.repeat(64);
    expect(capReviewDiff(under)).toBe(under);
    const over = capReviewDiff('b'.repeat(REVIEW_DIFF_CAP_BYTES + 1024));
    expect(over.endsWith('[Diff truncated to 256KB for review.]')).toBe(true);
    expect(Buffer.byteLength(over.slice(0, REVIEW_DIFF_CAP_BYTES), 'utf8')).toBe(REVIEW_DIFF_CAP_BYTES);
  });

  it('states the scope and hands over the diff, and nothing about the conversation', () => {
    const task = buildReviewTask({ mode: 'range', ref: 'main...feat', instructions: 'note' }, 'DIFF');
    expect(task).toContain('Review the following ref range main...feat.');
    expect(task).toContain('Additional reviewer instructions:\nnote');
    expect(task).toContain('```diff\nDIFF\n```');
  });
});
