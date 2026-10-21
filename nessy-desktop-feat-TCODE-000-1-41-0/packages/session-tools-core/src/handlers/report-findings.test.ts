import { describe, expect, test } from 'bun:test';

import { handleReportFindings, type ReportedFinding } from './report-findings.ts';
import type { SessionToolContext } from '../context.ts';

const ctx = {} as SessionToolContext;

const finding = {
  file: 'packages/shared/src/agent/pi-agent.ts',
  summary: 'The turn aborts before the tool result is flushed.',
  failureScenario: 'A user stops a turn while a tool is in flight and the transcript loses the result.',
};

describe('ReportFindings', () => {
  test('reports findings as structured content, with and without category', async () => {
    const result = await handleReportFindings(ctx, {
      findings: [finding, { ...finding, file: 'packages/server-core/src/x.ts', category: 'test-coverage' }],
    });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      findings: [
        {
          file: finding.file,
          summary: finding.summary,
          failureScenario: finding.failureScenario,
        },
        {
          file: 'packages/server-core/src/x.ts',
          summary: finding.summary,
          failureScenario: finding.failureScenario,
          category: 'test-coverage',
        },
      ],
    });
    // `category` is "shown next to the file location", never folded into the
    // summary — the rendered text has to carry the documented placement too.
    expect(result.content[0]!.text).toContain('packages/server-core/src/x.ts [test-coverage]');
    expect(result.content[0]!.text).toContain('Reported 2 findings.');
    // A finding without a category must not grow an empty one.
    const reported = result.structuredContent!.findings as ReportedFinding[];
    expect(Object.hasOwn(reported[0]!, 'category')).toBe(false);
  });

  test('a finding missing a required field is a tool error, not a silent drop', async () => {
    const result = await handleReportFindings(ctx, {
      findings: [finding, { file: 'a.ts', summary: 'Missing the scenario.' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[ERROR]');
    expect(result.content[0]!.text).toContain('findings.1.failureScenario');
    // The good finding is not reported either: a partially-accepted review is
    // the silent drop this test exists to prevent. P3.11 — absent, not `{}`:
    // an empty payload would replace the refusal text on the codex wire.
    expect(result.structuredContent).toBeUndefined();
  });

  /**
   * F1.150 — zero findings is the COMMONEST outcome of a review, and the tool refused it
   * (`findings: z.array(...).min(1)`), so a clean `/code-review` ended in a refusal on
   * claude-gateway and codex alike (SIT-11, P-SIT11CG-2 / P-SIT11CX-2). The vendor's own
   * description of this tool says to call it "with the verified findings ranked most-severe
   * first (empty array if nothing survived verification)". The CONTROL beside it: a finding
   * missing a field still fails the whole call (the test above), so accepting an empty list
   * does not loosen what a non-empty one must carry.
   */
  test('an empty findings list is the answer "nothing found", not a refusal', async () => {
    const result = await handleReportFindings(ctx, { findings: [] });
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toBe('No findings: nothing survived the review.');
    // A real (empty) list, not an absent payload: a codex model reads `structuredContent` in
    // preference to the text, and `{ findings: [] }` says the same thing the text does.
    expect(result.structuredContent).toEqual({ findings: [] });
  });

  test('a missing findings key is still refused', async () => {
    const result = await handleReportFindings(ctx, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('findings');
  });

  /**
   * `code-review.md:317` — "When Claude fixes reported findings later in the
   * session, it reports them again, and Claude Code marks each finding in the
   * updated findings list as fixed, skipped, or no change needed."
   */
  test('a re-report carries per-finding outcome on both surfaces', async () => {
    const result = await handleReportFindings(ctx, {
      findings: [
        { ...finding, outcome: 'fixed' },
        { ...finding, file: 'b.ts', category: 'correctness', outcome: 'no_change_needed' },
        { ...finding, file: 'c.ts' },
      ],
    });

    expect(result.isError).toBe(false);
    const reported = result.structuredContent!.findings as ReportedFinding[];
    expect(reported.map(entry => entry.outcome)).toEqual(['fixed', 'no_change_needed', undefined]);
    // The state must reach the TEXT too: nothing in this fork reads
    // `structuredContent`, so the rendered list is the only surface today.
    const text = result.content[0]!.text;
    expect(text).toContain(`1. ${finding.file} — fixed`);
    expect(text).toContain('2. b.ts [correctness] — no change needed');
    expect(text).toContain('3. c.ts\n');
    // A finding without an outcome must not grow an empty key.
    expect(Object.hasOwn(reported[2]!, 'outcome')).toBe(false);
  });

  test('an unknown outcome value fails the whole call instead of being stripped', async () => {
    const result = await handleReportFindings(ctx, {
      findings: [finding, { ...finding, file: 'b.ts', outcome: 'done' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('findings.1.outcome');
    // Same whole-call-failure invariant the required fields already have: a
    // silent strip (zod's default for an unknown key) is the defect this pins.
    expect(result.structuredContent).toBeUndefined();
  });
});
