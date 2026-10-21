/**
 * C4.13 (QH1, owner answer B, 2026-09-11) — codex's OWN background review.
 *
 * ## The promise, and the runtime that could not keep it
 *
 * `code-review.md#review-a-diff-locally`, verbatim: *"The review runs as a
 * background subagent with its own context window, so it doesn't fill your
 * conversation."* Pi keeps it with its own review tool (background by default
 * since P6.798) and claude keeps it through the SDK, which backgrounds its own
 * subagents. codex kept only the *isolated* half: the reviewer ran inline on the
 * conversation's own thread, so a large review filled the window it was supposed
 * to stay out of, and `CodexAgent.backgroundInFlightTasks` had to refuse by name.
 *
 * ## Native-first: configuration, not construction
 *
 * codex publishes the mechanism and nothing in this repo called it. At the
 * pinned tag `rust-v0.150.1`, `packages/codex-protocol/generated/ClientRequest.ts`
 * declares `review/start` with `ReviewStartParams`
 * (`{ threadId, target: ReviewTarget, delivery?: ReviewDelivery }`),
 * `ReviewDelivery` is `"inline" | "detached"`, and `ReviewStartResponse` returns
 * `reviewThreadId` — documented on the field itself as *"For detached reviews,
 * this is the id of the new review thread."* So the review runs on a thread of
 * its own, which is exactly the documented shape, and the host supplies one
 * request.
 *
 * ## Why `custom`, and why the three native `ReviewTarget` members are DECLINED
 *
 * `ReviewTarget` is `uncommittedChanges | baseBranch | commit | custom`, and
 * three of those look like a closer match to the host's own review scopes. They
 * are not, and the reason is P3.276's whole subject: a native member makes codex
 * compute the diff ITSELF, with its own idea of the scope — which is the drift
 * that row removed by giving every runtime ONE host-computed diff
 * (`packages/shared/src/prompts/review-diff.ts`, and the documented default
 * *"your branch's commits ahead of its upstream plus any uncommitted changes"*).
 * Two of the six host scopes (`range`, `paths`) have no native member at all, so
 * a per-mode mapping would ALSO have to fall back here — and then a codex review
 * would read a different diff depending on which words the user typed.
 *
 * `custom` is additionally the only member that can carry the RUBRIC. Pi hands
 * `REVIEW_RUBRIC_PROMPT` to the reviewer child per call; a native target would
 * run codex's own review prompt instead, so findings on codex would come from a
 * different reviewer than findings on Pi — a difference a user meets only by
 * switching runtimes, which is the class this fork exists to close. See
 * {@link CODEX_DETACHED_REVIEW_SWITCH_NOTE} for the residue that remains.
 *
 * No second git computation, no second scope, one rubric.
 */

/**
 * The `review/start` body, spelled locally rather than imported.
 *
 * `@nessy-agent/shared` does not depend on `@nessy-agent/codex-protocol`, and the
 * generated package publishes only `.` and two JSON files in its exports map —
 * so an import here would be a new package edge plus a new exports key for three
 * fields. The shape is pinned against the generated type by
 * `codex-detached-review.test.ts`, which reads
 * `packages/codex-protocol/generated/v2/ReviewStartParams.ts` off disk, so a
 * rename upstream fails here rather than at a codex round trip.
 */
interface ReviewStartParams {
  threadId: string;
  target:
    | { type: 'uncommittedChanges' }
    | { type: 'baseBranch'; branch: string }
    | { type: 'commit'; sha: string; title: string | null }
    | { type: 'custom'; instructions: string };
  delivery?: 'inline' | 'detached' | null;
}

/**
 * `ReviewDelivery` `"detached"` — the whole point of the row, named rather than
 * spelled at the call site so a rename in the generated protocol is one edit.
 */
export const CODEX_DETACHED_REVIEW_DELIVERY = 'detached' as const;

/** What the host already computed for this review, as the review port answers it. */
export interface CodexDetachedReviewInput {
  /** Plain-English description of what was diffed (`describeReviewTarget`). */
  readonly target: string;
  /** The reviewer's task — the host diff plus what it is. */
  readonly task: string;
  /** The adversarial rubric the reviewer must follow. */
  readonly rubric: string;
}

/**
 * The `review/start` body for one detached review on an open codex thread.
 *
 * The instructions are ordered rubric-then-task, the same order
 * `handleReviewDiff` hands them to a delegated reviewer on the other two
 * runtimes, so the reviewer reads the same two blocks in the same order
 * wherever it runs.
 */
export function buildCodexDetachedReviewParams(
  threadId: string,
  input: CodexDetachedReviewInput,
): ReviewStartParams {
  return {
    threadId,
    target: {
      type: 'custom',
      instructions: [
        `Review ${input.target}.`,
        '',
        'Reviewer rubric:',
        input.rubric,
        '',
        'Reviewer task:',
        input.task,
      ].join('\n'),
    },
    delivery: CODEX_DETACHED_REVIEW_DELIVERY,
  };
}

/** The line the user sees when the detached review has been accepted. */
export function describeCodexDetachedReviewStart(target: string): string {
  return `Reviewing ${target} in the background on a review thread of its own; `
    + 'the findings will arrive here when it finishes.';
}

/** The line the user sees when that thread reports back. */
export function describeCodexDetachedReviewFindings(target: string, findings: string): string {
  const body = findings.trim();
  return body
    ? `Background review of ${target} finished:\n\n${body}`
    : `Background review of ${target} finished with nothing to report.`;
}

/**
 * The residue this flip does NOT close, stated because the host's job is to make
 * the difference uniform or HONEST and this one cannot be made uniform.
 *
 * A detached review is a codex THREAD. It carries the host's diff and the host's
 * rubric, so the review itself matches — but the thread is codex's, so its
 * findings are produced by codex's model under codex's own review machinery, and
 * it does not exist after a switch to Pi or claude. A user who switches
 * mid-review loses the background review and keeps the conversation.
 */
export const CODEX_DETACHED_REVIEW_SWITCH_NOTE =
  'Codex runs a backgrounded /code-review on a review thread of its own. It carries this host\'s '
  + 'diff and rubric, so the review matches the other runtimes — but the thread belongs to codex: '
  + 'switching this session to Pi or Claude while a background review is running abandons it, and '
  + 'its findings never arrive.';
