import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { OrchestrationResultPayload } from '@nessy-agent/core';
import { resolveAgentDefinition, type AgentDefinition } from '../../../shared/src/agents/index.ts';
import type { PiChildSessionPort } from '../../../shared/src/agent/pi-harness/child-session-port.ts';
import {
  REVIEW_FINDINGS_SCHEMA,
  REVIEW_RUBRIC_PROMPT,
  type ReviewFinding,
  type ReviewResult,
} from '../../../shared/src/prompts/review.ts';
import {
  buildReviewTask,
  capReviewDiff,
  computeReviewDiffWithGit,
  describeReviewTarget,
  normalizeReviewTarget,
  type ComputeReviewDiff,
  type NormalizedReviewRequest,
} from '../../../shared/src/prompts/review-diff.ts';
import { scanSubagentReport } from '../../../shared/src/prompts/untrusted-text.ts';
import { normalizeThinkingLevel, type ThinkingLevel } from '../../../shared/src/agent/thinking-levels.ts';
import { spawnChildSession, type ChildSessionResult, type SpawnChildSessionArgs } from './spawner.ts';
import { parseSchemaResult } from './subagent-tool.ts';
import { registerBackgroundChildTask, type BackgroundChildTaskEvent } from './background-child-task.ts';
import type { BackgroundTaskRegistry } from './background-task-registry.ts';

export interface ReviewToolDetails {
  result?: OrchestrationResultPayload;
  findings?: ReviewFinding[];
  verdict?: ReviewResult['verdict'];
  explanation?: string;
  isError?: boolean;
  error?: string;
}

export type { ComputeReviewDiff, NormalizedReviewRequest };

/**
 * The shared request, with `effort` re-narrowed to this runtime's own
 * vocabulary. The shared module types it as a plain string on purpose (see
 * {@link normalizeReviewRequest}); the spawner takes a {@link ThinkingLevel},
 * and the narrowing happens where the value is validated rather than by a cast
 * at the spawn site.
 */
export type PiReviewRequest = Omit<NormalizedReviewRequest, 'effort'> & { effort?: ThinkingLevel };

/**
 * P3.276 — the argument reader kept here, the DIFF moved out.
 *
 * `effort` is the half that cannot travel: it is a {@link ThinkingLevel} the Pi
 * spawner hands the child, and its vocabulary belongs to this runtime rather
 * than to a git module. Everything downstream of the target — the six modes, the
 * untracked walk, the injection guard, the cap and the task text — is now
 * `shared/src/prompts/review-diff.ts` and is the same computation for whichever
 * runtime offers it next.
 */
export function normalizeReviewRequest(params: unknown): PiReviewRequest {
  if (typeof params !== 'object' || params === null) {
    throw new Error('review arguments must be an object');
  }
  const record = params as Record<string, unknown>;
  const rawInstructions = record.instructions;
  const instructions = typeof rawInstructions === 'string' && rawInstructions.trim().length > 0
    ? rawInstructions.trim()
    : undefined;
  const effort = normalizeThinkingLevel(record.effort);
  if (record.effort !== undefined && effort === undefined) {
    throw new Error(`review does not know the effort level: ${String(record.effort)}`);
  }
  const { effort: _widened, ...target } = normalizeReviewTarget(
    params,
    instructions ? { instructions } : {},
  );
  return { ...target, ...(effort ? { effort } : {}) };
}

export interface CreateReviewToolOptions {
  getCwd: () => string;
  getDepth?: () => number;
  makeRunId?: () => string;
  spawn?: (args: SpawnChildSessionArgs) => Promise<ChildSessionResult>;
  /** Override diff computation (default: read-only git). */
  computeDiff?: ComputeReviewDiff;
  childSessionPort?: PiChildSessionPort;
  /**
   * P6.308 (Pi arm) — the two halves a DETACHED run owes the rest of the system,
   * the same pair `createSubagentTool` takes.
   *
   * Absent, an EXPLICIT `background: true` is refused BY NAME rather than
   * silently run in the foreground: a tool that says "started in the background"
   * and then blocks is the P2.114 lie, and a tool that silently ignores the flag
   * is the same lie one door along. Since P6.798 flipped the default, an UNSET
   * `background` with neither of these wired runs in the FOREGROUND instead of
   * being refused — the caller did not ask for the background, and the page's own
   * foreground cases are exactly this shape.
   */
  emitEvent?: (event: BackgroundChildTaskEvent<'subagent'>) => void;
  backgroundTasks?: BackgroundTaskRegistry;
}

/**
 * Reviewer child def = the built-in read-only `reviewer` def with the rubric as
 * its system prompt, and NO skill and NO MCP server (F1.890, F1.876/F1.889's rule
 * for the judge): the diff is inlined verbatim, so a `[skill:x]` in it loaded that
 * skill's body here. A `reviewer` the model spawns itself keeps both; no new plumbing.
 */
function reviewerDefWithRubric(base: AgentDefinition): AgentDefinition {
  return {
    ...base,
    tools: [...base.tools],
    ...(base.disallowedTools ? { disallowedTools: [...base.disallowedTools] } : {}),
    systemPrompt: REVIEW_RUBRIC_PROMPT, skillKeys: [], mcpServerKeys: [],
  };
}

const PRIORITY_ORDER: ReviewFinding['priority'][] = [0, 1, 2, 3];

function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => {
    const pa = PRIORITY_ORDER.indexOf(a.priority);
    const pb = PRIORITY_ORDER.indexOf(b.priority);
    if (pa !== pb) return pa - pb;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
}

function priorityLabel(priority: ReviewFinding['priority']): string {
  return `P${priority}`;
}

function renderFindings(result: ReviewResult): string {
  const sorted = sortFindings(result.findings);
  const header = `Review verdict: ${result.verdict}\n${result.explanation}`.trim();
  if (sorted.length === 0) {
    return `${header}\n\nNo findings.`;
  }
  const body = sorted
    .map((finding, index) => {
      // `code-review.md:315` places the category "next to the file location",
      // so it rides the location line rather than the title.
      const category = finding.category ? ` [${finding.category}]` : '';
      const location = `${finding.file}:${finding.line}${category}`;
      const confidence = Number.isFinite(finding.confidence)
        ? ` (confidence ${finding.confidence.toFixed(2)})`
        : '';
      return `${index + 1}. [${priorityLabel(finding.priority)}] ${finding.title}${confidence}\n${location}\n${finding.body}`;
    })
    .join('\n\n');
  return `${header}\n\nFindings (most severe first):\n\n${body}`;
}

function textResult(text: string, details: ReviewToolDetails = {}): AgentToolResult<ReviewToolDetails> {
  return { content: [{ type: 'text', text }], details };
}

function errorResult(message: string): AgentToolResult<ReviewToolDetails> {
  return textResult(message, { isError: true, error: message });
}

function toResultPayload(runId: string, result: ChildSessionResult): OrchestrationResultPayload {
  const status = result.status;
  return {
    kind: 'subagent',
    runId,
    status,
    results: [{
      id: result.agentId ?? runId,
      label: result.agent,
      agentType: result.agent,
      status,
      text: result.text,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      ...(result.error ? { error: result.error } : {}),
    }],
  };
}

export function createReviewTool(options: CreateReviewToolOptions): ToolDefinition<any, ReviewToolDetails> {
  const computeDiff = options.computeDiff ?? computeReviewDiffWithGit;

  return {
    name: 'review',
    label: 'Review',
    description: 'Adversarially review a code change with the built-in read-only reviewer agent. Reviews this branch\'s commits ahead of its upstream plus any uncommitted changes by default; pass a branch (base), a ref range (range), file paths (paths), or a single commit (commit) to review something else. Reports correctness bugs and reuse, simplification and efficiency cleanups, ordered by severity, plus an overall verdict.',
    promptSnippet: 'Use review to run the read-only reviewer agent over a diff (the branch\'s commits ahead of upstream plus uncommitted changes by default, or a branch, ref range, file paths, or a single commit) and get findings ordered by severity plus a verdict.',
    promptGuidelines: [
      'Call review with no target for the default scope: this branch\'s commits ahead of its upstream plus any uncommitted changes.',
      'Pass base for a branch name (merge-base with HEAD), range for a literal ref range like main...my-feature, paths for specific files, or commit for a single commit. At most one.',
      'Pass scope: "uncommitted" to review only the working tree, and effort to raise or lower the reviewer\'s coverage for this run.',
      'A pull-request number is NOT a target: this build has no GitHub path, so review a branch or ref range instead of a PR number.',
      'The reviewer runs read-only and returns findings ordered most-severe-first with an overall verdict.',
    ],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        base: { type: 'string', description: 'Branch or base ref to diff against (uses the merge-base with HEAD).' },
        commit: { type: 'string', description: 'A single commit to review.' },
        range: { type: 'string', description: 'A literal ref range such as main...my-feature.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'File paths to review, diffed against HEAD.' },
        scope: { type: 'string', enum: ['upstream', 'uncommitted'], description: 'Which diff to take when no target is given. Default "upstream": commits ahead of the branch\'s upstream plus uncommitted changes.' },
        effort: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Effort level for this review. Omit to inherit the session\'s. Low and medium report only the most confident findings; high through max broaden coverage.' },
        instructions: { type: 'string', description: 'Optional extra guidance for the reviewer.' },
        background: { type: 'boolean', description: 'Whether the review runs as a background task. Default true: the tool returns immediately and the findings arrive as a task notification when it settles. Pass false to run it in the foreground, so the findings come back in this tool result.' },
      },
    } as any,
    prepareArguments: args => args as any,
    async execute(toolCallId, params, signal): Promise<AgentToolResult<ReviewToolDetails>> {
      let request: PiReviewRequest;
      try {
        request = normalizeReviewRequest(params);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }

      const cwd = options.getCwd();
      let diff: string;
      try {
        diff = capReviewDiff(await computeDiff(request, cwd));
      } catch (error) {
        return errorResult(`review could not compute the diff: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!diff.trim()) {
        return textResult(`No changes to review for ${describeReviewTarget(request)}.`, {
          findings: [],
          verdict: 'patch is correct',
          explanation: 'There is no diff to review.',
        });
      }

      const baseDef = resolveAgentDefinition('reviewer', { runtimeDefinitions: [] });
      const agentDef = reviewerDefWithRubric(baseDef);
      const runId = options.makeRunId?.() ?? `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const baseTask = buildReviewTask(request, diff);
      const spawn = options.spawn ?? spawnChildSession;

      /**
       * The review itself, extracted so it can be AWAITED (today's behaviour)
       * or DETACHED (P6.308) without a second copy of the retry loop.
       *
       * `onAdmitted` is what makes the detached return honest: `subagent-tool.ts`
       * learned twice (P2.114, P2.115) that reporting "started" for a call that
       * admitted nothing is a lie the model reads as success, and every refusal
       * in `spawner.ts` returns before `onAdmitted` fires.
       */
      const runReview = async (
        runSignal: AbortSignal | undefined,
        backgroundTaskId: string | undefined,
        onAdmitted: ((agentId: string) => void) | undefined,
      ): Promise<AgentToolResult<ReviewToolDetails>> => {
      let task = baseTask;
      let last: ChildSessionResult | null = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const result = await spawn({
          agentDef,
          task,
          cwd,
          ...(runSignal ? { signal: runSignal } : {}),
          ...(onAdmitted ? { onAdmitted } : {}),
          ...(backgroundTaskId ? { backgroundTaskId } : {}),
          depth: options.getDepth?.() ?? 0,
          // The review judge is a host-run child, not something the model spawned
          // with the Agent tool, so it must not consume the model's subagent
          // budget (`sub-agents.md:905`). It keeps the workflow semaphore.
          limitScope: 'internal',
          /**
           * `code-review.md#tune-effort-and-arguments` — *"Pass an effort level
           * to trade coverage for confidence."* Absent, the spawner inherits the
           * SESSION's level, which is the same section's never-typed fallback:
           * *"If you've never typed a level, the review uses the session's
           * current effort."*
           *
           * C3.296 — the sentence that used to stand here said the STICKY half
           * of that section (*"the review reuses the last level from `low`
           * through `max` you typed, even in an earlier session"*) had "no store
           * in this fork". P6.307 built one, so the sentence had quietly become
           * false — the cross-module-assertion trap in `AGENTS.md` §Traps, which
           * is why the successor is a link and not a claim:
           * {@link import('@nessy-agent/shared/config/storage').getLastReviewEffortLevel}
           * and its writer
           * {@link import('@nessy-agent/shared/config/storage').setLastReviewEffortLevel}.
           * A link can only fail to resolve; it can never become false.
           *
           * Nothing about THIS call changes. The store is read and applied on
           * the host's own PreToolUse seam, before the arguments reach here, so
           * an absent `effort` is still the honest way to say "the caller named
           * no level" — filling it here would fill it twice.
           */
          ...(request.effort ? { effort: request.effort } : {}),
          // DEVIATION, recorded not accidental. `code-review.md:336` — "The
          // review runs in the background by default" with three named
          // foreground fallbacks (:338-:340). We are always in the fallback:
          // `review` is a tool call whose findings must return in ITS OWN
          // result, and backgrounding it would change what a caller receives,
          // not just when.
          //
          // "Backgrounding is the unit after this one" — that unit is P6.308,
          // and it MEASURED this line rather than flipping it. Two corrections
          // the next reader needs:
          //
          //  - THIS PIN IS NOT WHAT BLOCKS THE SESSION. `spawner.ts` awaits
          //    `monitorWithAbort` for a background child ("The spawner still
          //    awaits `monitor` for background children, so callers always
          //    receive completed results", and the slot comment says the promise
          //    "settles when the child does"). So on Pi `background: true`
          //    changes DURABILITY, not blocking: flipping this literal alone
          //    would leave `/code-review` exactly as blocking as it is now, and
          //    would look like a fix. The composer is freed in `spawner.ts`, by
          //    returning the admitted agent id instead of awaiting the monitor,
          //    and delivering the findings through the background-task
          //    notification path — not here.
          //  - THE CLAUDE ARM IS NATIVE. `Query.backgroundTasks(toolUseId?)`
          //    backgrounds an IN-FLIGHT task and its host caller is
          //    `ClaudeAgent.backgroundInFlightTasks` (P6.793) — the manual
          //    lever. It is not a per-call direction: on claude the SDK's own
          //    subagent tool already defaults to background (P6.1016), so the
          //    direction is the skill's to state and there is nothing here to
          //    flip. (P6.1029, 2026-09-11: this bullet said the caller did not
          //    exist and named a line of `sdk.d.ts` that no longer resolves.)
          //
          // P6.308 (Pi arm) LANDED, and it corrects the first bullet's REMEDY
          // while confirming its diagnosis. The composer is NOT freed in
          // `spawner.ts`: `subagent-tool.ts` frees it at the TOOL, by detaching
          // the whole run through `registerBackgroundChildTask` and racing the
          // ADMISSION against it, with the spawner untouched — so its await of
          // `monitorWithAbort` is exactly what makes the detached run deliver a
          // completed result to the notification path. Teaching the spawner to
          // return early would have been a second, weaker copy of that.
          //
          // The literal below is now the request's own answer rather than a
          // pin: `false` (the default, and today's behaviour byte-for-byte)
          // keeps the findings in this tool result, `true` makes the run
          // durable AND detached together, which is the pair the host requires
          // (`createPiDelegatingChildSessionPort` refuses a background child
          // that carries no `backgroundTaskId`).
          background: backgroundTaskId !== undefined,
          ...(attempt === 1 ? {} : { requestedAgentId: crypto.randomUUID() }),
        });
        last = result;
        if (result.status !== 'done') {
          return textResult(scanSubagentReport(result.error || `review ${result.status}`), {
            result: toResultPayload(runId, result),
            isError: true,
            ...(result.error ? { error: result.error } : {}),
          });
        }

        const schemaError = parseSchemaResult(result.text, REVIEW_FINDINGS_SCHEMA);
        if (!schemaError) {
          const parsed = JSON.parse(result.text) as ReviewResult;
          // Defang AFTER the parse: the reviewer's JSON can carry `\u001B` as a
          // six-character escape, which only becomes a control character once
          // decoded, so neutralising `result.text` would miss it.
          return textResult(scanSubagentReport(renderFindings(parsed)), {
            result: toResultPayload(runId, result),
            findings: sortFindings(parsed.findings),
            verdict: parsed.verdict,
            explanation: parsed.explanation,
          });
        }
        if (attempt === 2) {
          return errorResult(`review result did not match the findings schema: ${schemaError}`);
        }
        task = `${baseTask}\n\nThe previous result did not match the required schema: ${schemaError}. Return only valid JSON matching the schema.`;
      }

      return errorResult(last?.error ?? 'review did not run');
      };

      // P6.798 — the page's direction is now the default.
      //
      // `code-review.md#run-in-the-foreground`, verbatim: *"The review runs in
      // the background by default; before v2.1.218, it ran inside your
      // conversation."* P6.308 read `background !== true` here and kept the
      // foreground as OUR default, on the ground that which way round a review
      // runs is a product posture rather than a lane's call. The owner's ruling
      // of 2026-09-10 made that call by the balance rule: follow the page.
      //
      // THE FOREGROUND IS STILL REACHABLE, and it is the page's own escape
      // rather than a hold-out — the same section names three cases where the
      // review "runs in the foreground instead". An explicit `background: false`
      // is that escape, so the parameter keeps both directions and only its
      // default moved.
      //
      // UNSET FALLS BACK when this session has no background-task channel, which
      // is the page's third foreground case in this host's own terms
      // (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, *"which also turns off every
      // other background task feature"*). The caller did not ask for the
      // background, so refusing would take the review away rather than move it.
      const asked = (params as { background?: unknown } | null)?.background;
      const channelWired = Boolean(options.emitEvent || options.backgroundTasks);
      if (asked === false || (asked !== true && !channelWired)) {
        return runReview(signal, undefined, undefined);
      }

      // An EXPLICIT `background: true` with no channel is still refused BY NAME
      // rather than silently run in the foreground: a tool that ignores a flag
      // it advertises is the same defect as one that claims an outcome it did
      // not observe.
      if (!channelWired) {
        return errorResult(
          'review cannot run in the background in this session: no background-task channel is wired. '
          + 'Re-run with `background: false` and the findings come back in the tool result.',
        );
      }

      const backgroundTaskId = `task-${runId}`;
      let admittedAgentId: string | undefined;
      let signalAdmitted: (() => void) | undefined;
      const admitted = new Promise<void>(resolve => { signalAdmitted = resolve; });
      const { settled } = registerBackgroundChildTask({
        taskId: backgroundTaskId,
        toolUseId: toolCallId,
        kind: 'subagent' as const,
        ...(options.emitEvent ? { emitEvent: options.emitEvent } : {}),
        ...(options.backgroundTasks ? { backgroundTasks: options.backgroundTasks } : {}),
        ...(options.childSessionPort ? { childSessionPort: options.childSessionPort } : {}),
        run: runSignal => runReview(runSignal, backgroundTaskId, agentId => {
          admittedAgentId = agentId;
          signalAdmitted?.();
        }),
        // The findings themselves ride the completion notice, which is the whole
        // point of the row: the composer comes back now and the review arrives
        // when it settles.
        outcome: result => ({
          status: result.details?.isError ? 'failed' as const : 'completed' as const,
          summary: result.content.map(part => (part as { text?: string }).text ?? '').join('\n'),
        }),
      });

      // Whichever comes first. A refusal returns before `onAdmitted` fires, so
      // the run can win this race with nothing running — and then its own reason
      // is the only honest thing to hand back, in the turn the model asked.
      let settledResult: AgentToolResult<ReviewToolDetails> | undefined;
      await Promise.race([admitted, settled.then(value => { settledResult = value; })]);
      if (admittedAgentId === undefined && settledResult) {
        return settledResult;
      }

      // No `result` payload: `OrchestrationResultPayload.status` is
      // `done | error | aborted`, and a run still in flight is none of the
      // three. Inventing a fourth member to describe a state the panel already
      // shows through `task_backgrounded` would be a second source of truth for
      // it; the findings arrive on the completion notice with the full payload.
      return textResult(
        `Started background review\ntask_id: ${backgroundTaskId}`
        + (admittedAgentId ? `\nagent_id: ${admittedAgentId}` : ''),
      );
    },
  };
}
