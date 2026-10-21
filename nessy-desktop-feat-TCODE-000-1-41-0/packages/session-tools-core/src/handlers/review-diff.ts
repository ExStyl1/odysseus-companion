/**
 * `ReviewDiff` — the host-computed diff a delegated review runs on (P3.276).
 *
 * ## What this tool is for
 *
 * `code-review.md` § *Review a diff locally* promises, on every runtime, that
 * the review "runs as a background subagent with its own context window, so it
 * doesn't fill your conversation". Pi keeps that promise with its own `review`
 * tool, which computes the diff and spawns the reviewer in one call. claude and
 * codex have no such tool, so the delegated reviewer there reviewed whatever
 * diff the model chose to run for itself — a different scope decided by a
 * different reader on every invocation, and one that quietly disagreed with the
 * documented default ("your branch's commits ahead of its upstream plus any
 * uncommitted changes").
 *
 * This tool supplies the missing half: the SAME host computation, and the task
 * text and rubric to hand the reviewer, in one read-only call.
 *
 * ## Why it hands back a task instead of spawning
 *
 * Pi substitutes `REVIEW_RUBRIC_PROMPT` as the reviewer child's system prompt
 * per call (`reviewerDefWithRubric`), which keeps the bundled `reviewer`
 * definition a general-purpose reviewer rather than permanently pinning the
 * diff rubric onto it. On claude that substitution is impossible:
 * `AgentDefinition.prompt` is a construction-time field of the SDK's `agents`
 * option, with no per-call override and no live setter. So the rubric rides the
 * TASK — the one channel every runtime has — and the model delegates with it.
 *
 * ## Thin on purpose
 *
 * `@nessy-agent/shared` depends on this package, so this package cannot import
 * the shared diff module. The dispatcher pattern is the same one
 * `plugin_*` and the scheduling tools use: the host binds a port, and an
 * unbound port is reported rather than worked around. A `git` of its own here
 * would be the second diff computation the row exists to remove.
 */
import type { SessionToolContext, SessionReviewDiffRequest } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';
import type { ToolResult } from '../types.ts';

/** The bounded set of keys the host normalizer reads. */
function toRequest(args: unknown): SessionReviewDiffRequest {
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;

  return {
    ...(text(record.base) ? { base: text(record.base)! } : {}),
    ...(text(record.commit) ? { commit: text(record.commit)! } : {}),
    ...(text(record.range) ? { range: text(record.range)! } : {}),
    ...(paths && paths.length > 0 ? { paths } : {}),
    ...(text(record.scope) ? { scope: text(record.scope)! } : {}),
    ...(text(record.instructions) ? { instructions: text(record.instructions)! } : {}),
    // C4.13 narrowed this to the literal `true` — the host sink spreads this
    // record, so a truthy string must not become a decision to start a thread
    // of its own.
    //
    // C4.42 (owner decision 2026-09-13, option B) widened it to BOTH literals,
    // and that widening is the half without which the row would REMOVE a
    // documented escape. codex now detaches by DEFAULT, so its predicate is
    // `background !== false`; a model's explicit `background: false` was
    // dropped here before the bridge ever saw it, which under the new default
    // would have made `code-review.md#run-in-the-foreground`'s foreground case
    // unreachable. Still only the two literals, so the C4.13 narrowing is
    // intact: a truthy or falsy STRING is neither, and passes nothing.
    ...(typeof record.background === 'boolean' ? { background: record.background } : {}),
  };
}

export async function handleReviewDiff(ctx: SessionToolContext, args: unknown): Promise<ToolResult> {
  const port = ctx.reviewDiff;
  if (!port) {
    // Named rather than vague: a model told "not available" can fall back to
    // reading the change itself, which is the pre-P3.276 behaviour and still
    // better than a silent empty review.
    return errorResponse(
      'ReviewDiff is not available in this context: no host diff service is bound to this session.',
    );
  }

  let answer;
  try {
    answer = await port.compute(toRequest(args));
  } catch (error) {
    return errorResponse(
      `ReviewDiff could not compute the diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!answer.diff.trim()) {
    // An empty diff is a real answer, not a failure: it means the target has no
    // changes. Reporting it as an error would push the model into inventing a
    // second target.
    return successResponse(`No changes to review for ${answer.target}.`);
  }

  // C4.13 — the review has ALREADY started on a thread of its own (codex's own
  // `review/start` with `delivery: "detached"`), so the delegate-this template
  // below would tell the model to review the same diff a second time. The host
  // sets this field only after the runtime confirmed the detached thread;
  // anything short of that leaves it absent and the answer falls through
  // byte-identical to the inline one.
  if (typeof answer.backgroundReview === 'string' && answer.backgroundReview) {
    return successResponse(answer.backgroundReview);
  }

  return successResponse([
    `Reviewing ${answer.target}.`,
    '',
    `Delegate this to the ${answer.reviewerAgent} agent, passing the rubric and the task below together as its prompt.`,
    '',
    'Reviewer rubric:',
    answer.rubric,
    '',
    'Reviewer task:',
    answer.task,
  ].join('\n'));
}
