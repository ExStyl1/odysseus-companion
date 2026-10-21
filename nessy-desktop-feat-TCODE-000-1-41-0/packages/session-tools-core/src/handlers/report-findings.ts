/**
 * `ReportFindings` (R27a) — code-review findings as a structured list.
 *
 * Contract, read from the raw markdown of `tools-reference.md:45`:
 *
 * > Reports code-review findings as a structured list, with a file, summary,
 * > and failure scenario per finding, so Claude Code can render them instead of
 * > printing them as text. Claude calls it when active code-review instructions
 * > tell it to. … As of v2.1.199, a finding can also carry an optional
 * > `category` slug, such as `correctness` or `test-coverage`, shown next to the
 * > file location in the rendered list.
 *
 * The doc names the four fields in prose (`file`, summary, failure scenario,
 * `category`) but publishes no JSON schema, so `failureScenario` is the
 * camelCase spelling of the documented phrase; the three names the doc writes
 * literally are used verbatim.
 *
 * `code-review.md:317` adds the re-report state (R71):
 *
 * > When Claude fixes reported findings later in the session, it reports them
 * > again, and Claude Code marks each finding in the updated findings list as
 * > fixed, skipped, or no change needed.
 *
 * `outcome` carries that state. It rides the RENDERED text as well as
 * `structuredContent`, because no HOST surface in this fork reads
 * `structuredContent` yet — the text fallback is the only surface the state can
 * reach today, and the file's own precedent is that `category` rides the
 * rendered location line. (A codex MODEL does read it, and in preference to the
 * text — P3.11, `response.ts` — which is why a result that has nothing
 * structured to say must carry no payload at all rather than an empty one.)
 *
 * The tool is entirely local: it needs no host port and no hosted
 * infrastructure. Its whole job is to hand the host a structured list instead
 * of prose, which lands on `structuredContent` of the tool result.
 */
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';
import { ReportFindingsSchema } from '../tool-defs.ts';

/** The three states `code-review.md:317` names for a re-reported finding. */
export type ReportedFindingOutcome = 'fixed' | 'skipped' | 'no_change_needed';

/** One finding, exactly as it lands on `structuredContent`. */
export interface ReportedFinding {
  file: string;
  summary: string;
  failureScenario: string;
  category?: string;
  outcome?: ReportedFindingOutcome;
}

/** How each `outcome` value is spelled in the rendered list, per `:317`. */
const OUTCOME_LABELS: Record<ReportedFindingOutcome, string> = {
  fixed: 'fixed',
  skipped: 'skipped',
  no_change_needed: 'no change needed',
};

/**
 * The rendered line for one finding. `category` is "shown next to the file
 * location", so it rides the location, not the summary — a renderer that only
 * reads the text still gets the documented placement. `outcome` rides the same
 * line as a trailing marker: `:317` marks each finding IN the list, so it must
 * be attached to the finding rather than summarised once for the whole report.
 */
function renderFinding(finding: ReportedFinding, index: number): string {
  const location = finding.category ? `${finding.file} [${finding.category}]` : finding.file;
  const outcome = finding.outcome ? ` — ${OUTCOME_LABELS[finding.outcome]}` : '';
  return [
    `${index + 1}. ${location}${outcome}`,
    `   ${finding.summary}`,
    `   Fails when: ${finding.failureScenario}`,
  ].join('\n');
}

export async function handleReportFindings(
  _ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = ReportFindingsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    // A finding missing a required field is a reported error, never a silent
    // drop: a review that quietly loses a finding is worse than one that fails.
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return errorResponse(`ReportFindings input is invalid — ${detail}`);
  }

  const findings: ReportedFinding[] = parsed.data.findings.map(finding => ({
    file: finding.file,
    summary: finding.summary,
    failureScenario: finding.failureScenario,
    ...(finding.category === undefined ? {} : { category: finding.category }),
    ...(finding.outcome === undefined ? {} : { outcome: finding.outcome }),
  }));

  // F1.150 — zero findings is the ANSWER "nothing survived the review", the commonest outcome
  // of a review, never a refusal. `structuredContent` stays a real list (`{ findings: [] }`),
  // which tells a codex model — it reads the payload before the text — the same thing.
  const header = findings.length === 1 ? '1 finding' : `${findings.length} findings`;
  const text = findings.length === 0
    ? 'No findings: nothing survived the review.'
    : [`Reported ${header}.`, ...findings.map(renderFinding)].join('\n');
  return {
    content: [{ type: 'text', text }],
    structuredContent: { findings },
    isError: false,
  };
}
