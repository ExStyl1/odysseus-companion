/**
 * Review rubric prompt and structured-findings contract for the `/review`
 * feature (plan: prompt-and-review-parity R1).
 *
 * The rubric text is adapted VERBATIM from the openai/codex review rubric
 * (`codex-rs/prompts/templates/review/rubric.md`, Apache-2.0). See
 * `docs/architecture/pi-extension-adoption-scorecard.md` for the source +
 * license record. Nessy-specific wiring (the JSON output schema shape consumed
 * by the orchestrator's existing structured-output mechanism, and the diff
 * framing) is written in our own words.
 *
 * The reviewer child runs read-only: it never gathers the diff itself. The host
 * computes the diff and embeds it in the child task, so nothing here depends on
 * the child having shell/git access.
 */

/**
 * Priority levels for review findings, mirroring the Codex P0–P3 scale.
 *   0 = P0 — drop everything; blocking, universal, assumption-free.
 *   1 = P1 — urgent; fix next cycle.
 *   2 = P2 — normal; fix eventually.
 *   3 = P3 — low; nice to have.
 */
export type ReviewFindingPriority = 0 | 1 | 2 | 3;

/**
 * What KIND of finding this is. `code-review.md:281` — the local review "reports
 * correctness bugs and reuse, simplification, and efficiency cleanups" — so the
 * rubric's correctness-only scope was half the documented job, and a reader of
 * the rendered list had no way to tell a bug from a cleanup.
 *
 * The slugs double as the `category` the finding carries into `ReportFindings`
 * (`code-review.md:315`: "a category tag such as `correctness`"), so they are
 * spelled the way that page spells them. `test-coverage` comes from the second
 * example in `tools-reference.md:45`.
 */
export type ReviewFindingCategory =
  | 'correctness'
  | 'reuse'
  | 'simplification'
  | 'efficiency'
  | 'test-coverage';

export const REVIEW_FINDING_CATEGORIES: readonly ReviewFindingCategory[] = [
  'correctness',
  'reuse',
  'simplification',
  'efficiency',
  'test-coverage',
] as const;

export interface ReviewFindingLocation {
  file: string;
  line: number;
}

export interface ReviewFinding {
  /** ≤ 80 chars, imperative. */
  title: string;
  /** Markdown explaining why this is a defect; cites the affected code. */
  body: string;
  priority: ReviewFindingPriority;
  /** Model self-reported confidence, 0.0–1.0. */
  confidence: number;
  file: string;
  line: number;
  /** Which documented axis this finding sits on. Required: see the type's note. */
  category: ReviewFindingCategory;
}

export type ReviewVerdict = 'patch is correct' | 'patch is incorrect';

export interface ReviewResult {
  findings: ReviewFinding[];
  verdict: ReviewVerdict;
  explanation: string;
}

export const REVIEW_FINDING_TITLE_MAX_LENGTH = 80;

/**
 * JSON schema for the structured review result. Fed to the orchestrator's
 * existing `outputSchema` mechanism (the same schema path `subagent`/`workflow`
 * use via `parseSchemaResult`), so validation and malformed-result rejection
 * are handled by that mechanism — there is NO ad-hoc JSON parsing here.
 */
export const REVIEW_FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'verdict', 'explanation'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body', 'priority', 'confidence', 'file', 'line', 'category'],
        properties: {
          title: {
            type: 'string',
            maxLength: REVIEW_FINDING_TITLE_MAX_LENGTH,
            description: 'Imperative, at most 80 characters.',
          },
          body: {
            type: 'string',
            description: 'One paragraph of Markdown explaining why this is a defect; cite the affected code.',
          },
          priority: {
            type: 'integer',
            minimum: 0,
            maximum: 3,
            description: '0 = P0 (blocking), 1 = P1 (urgent), 2 = P2 (normal), 3 = P3 (low).',
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Confidence that this is a real, introduced defect, 0.0–1.0.',
          },
          file: {
            type: 'string',
            description: 'Path of the affected file, as it appears in the diff.',
          },
          line: {
            type: 'integer',
            minimum: 0,
            description: 'Line in the affected file overlapping the change.',
          },
          category: {
            type: 'string',
            enum: [...REVIEW_FINDING_CATEGORIES],
            description: 'correctness for a bug; reuse, simplification or efficiency for a cleanup; test-coverage for a missing test.',
          },
        },
      },
    },
    verdict: {
      type: 'string',
      enum: ['patch is correct', 'patch is incorrect'],
      description: 'Overall correctness verdict for the change under review.',
    },
    explanation: {
      type: 'string',
      description: '1–3 sentences justifying the verdict.',
    },
  },
} as const;

/**
 * Adversarial, findings-first review rubric used as the reviewer child's system
 * prompt. Adapted verbatim from the openai/codex review rubric (Apache-2.0).
 *
 * Two sections are Nessy-specific and are NOT Codex text: "Cleanups", which
 * admits the reuse/simplification/efficiency axis `code-review.md:281` binds
 * alongside correctness bugs, and "Output format", which binds the model to the
 * JSON shape our structured-output mechanism validates. The Codex sections are
 * left as they were — the cleanup axis is added beside them, not folded into
 * their "what counts as a finding" test, so the adapted-verbatim provenance
 * recorded in the adoption scorecard still holds for the text it covers.
 */
export const REVIEW_RUBRIC_PROMPT = `# Review guidelines

You are acting as a reviewer for a proposed code change made by another engineer.

These are guidelines for determining whether the original author would appreciate the issue being flagged. More specific guidelines encountered elsewhere (in the change under review or its instructions) override these general ones.

## What counts as a finding

1. It meaningfully impacts the accuracy, performance, security, or maintainability of the code.
2. The bug is discrete and actionable (not a general issue with the codebase or a combination of multiple issues).
3. Fixing the bug does not demand a level of rigor that is not present in the rest of the codebase.
4. The bug was introduced in the change under review — pre-existing bugs must not be flagged.
5. The author of the change would likely fix the issue if they were made aware of it.
6. The bug does not rely on unstated assumptions about the codebase or author's intent.
7. Speculation is not enough. To be a finding, name the other parts of the code that are provably affected — do not merely suggest a change "may" break something elsewhere.
8. The bug is clearly not just an intentional change by the author.

Output all findings the author would fix if they knew about them. If there is no finding a person would definitely want fixed, prefer returning no findings. Do not stop at the first qualifying finding; continue until every qualifying finding is listed. Ignore trivial style unless it obscures meaning or violates a documented standard.

Every finding above is a correctness bug. Tag it \`category: "correctness"\`, or \`"test-coverage"\` when the gap is a missing test for behaviour the change introduced.

## Cleanups

Report cleanups as well as bugs. A cleanup is code the change introduced that works but should not stay as written. Three kinds, each its own \`category\`:

- \`reuse\` — the change reimplements something the codebase already provides. Name the existing helper, module or pattern it duplicates, with a \`file:line\`.
- \`simplification\` — the change is more complicated than the problem requires: dead branches, a layer of indirection with one caller, hand-rolled logic a language or library feature already covers, state that could be derived.
- \`efficiency\` — the change does provably more work than needed: repeated work inside a loop, a scan where a lookup exists, an avoidable copy of a large payload, a query per item.

The same bar applies as for bugs: the change under review introduced it, it is discrete and actionable, and the author would accept the edit. Do not report a cleanup that is speculation, a matter of taste, or a rewrite of code the change only touched incidentally. A cleanup is never P0 and rarely P1 — it does not break anything.

## Severity

Tag each finding with a priority:

- P0 (priority 0) — drop everything to fix. Blocking release, operations, or major usage. Only for universal issues that do not depend on any assumptions about the inputs.
- P1 (priority 1) — urgent. Should be addressed in the next cycle.
- P2 (priority 2) — normal. To be fixed eventually.
- P3 (priority 3) — low. Nice to have.

## Writing the finding

- The title is imperative and at most 80 characters. Prefix nothing to it — the priority is a separate field.
- The body is one paragraph of Markdown. Be clear about why the issue is a bug, and communicate severity accurately without overstating it.
- Cite the provably affected code with \`file:line\` references. Do not include code chunks longer than 3 lines; wrap any code in inline code or a short block.
- State the scenarios, environments, or inputs necessary for the bug to arise.
- Keep the tone matter-of-fact — not accusatory, not flattering.

## The change under review

The diff is provided in the task. Review only that diff. Read surrounding files with your read-only tools when needed to confirm a finding, but flag only defects introduced by the diff.

## Output format

Return ONLY a single JSON object — no prose, no Markdown fences — matching this shape exactly:

{
  "findings": [
    {
      "title": "<imperative, <= 80 chars>",
      "body": "<one paragraph of Markdown citing file:line>",
      "priority": <0-3>,
      "confidence": <0.0-1.0>,
      "file": "<path as it appears in the diff>",
      "line": <line number overlapping the change>,
      "category": "correctness" | "reuse" | "simplification" | "efficiency" | "test-coverage"
    }
  ],
  "verdict": "patch is correct" | "patch is incorrect",
  "explanation": "<1-3 sentences justifying the verdict>"
}

Order findings most severe first (lowest priority number first). "patch is incorrect" means the change introduces a bug or other blocking issue; ignore non-blocking nits (style, formatting, typos, docs) and every cleanup — reuse, simplification, efficiency — when deciding the verdict. A review whose only findings are cleanups still returns "patch is correct". If there are no findings, return an empty "findings" array and a "patch is correct" verdict.`;
