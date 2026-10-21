/**
 * C3.107 — the MR-less `/batch`, and the half that was still a PROMISE IN PROSE.
 *
 * ## What was already here, and what was not
 *
 * The fan-out itself shipped with P6.508: `worktree-batch-plan.ts` is the pure
 * planner (the bound, the branch names, the deferral list), `SessionManager`'s
 * `runWorktreeBatch` is the executor over the same lease machinery
 * New-Chat-in-Worktree uses, and `describeBatchSubmission` is the reply that
 * NAMES the branches a person then submits. Verified present at HEAD before a
 * line was written here.
 *
 * What did not exist was the row's third clause. Owner answer QH2 = B says the
 * product opens no merge request; every artefact stating that was a SENTENCE —
 * a docblock, a tool description, and one test asserting that a string contains
 * the words *"No merge request was opened"*. A forge call added to the fan-out
 * tomorrow would leave every one of them green. This module is the missing
 * property, in the shape `merge-request-watch.ts` gave H20: there the refusal is
 * the type (a request whose `method` can only be `GET`), here it is a machine
 * check over the fan-out's own bytes, because the risk on this path is not a
 * mistyped request — it is a shell command, an MCP call or a `fetch`, none of
 * which a type can refuse.
 *
 * ## Native-first, measured 2026-09-12 — and the answer INVERTS the usual one
 *
 * The three runtimes were asked first, and one of them does have this feature:
 *
 * **claude — it exists natively, and its terminal step is exactly what the
 * owner refused.** `/batch` is a bundled skill (`skills.md#bundled-skills`
 * lists it beside `/doctor` and `/code-review`), and `commands.md#all-commands`
 * says it *"Researches the codebase, decomposes the work into 5 to 30
 * independent units, and presents a plan. Once approved, spawns one background
 * subagent per unit in an isolated git worktree. Each subagent implements its
 * unit, runs tests, and opens a pull request."* The vendored binary agrees with
 * its own page — the shipped 2.1.247 `claude` carries the skill's worker
 * template, whose step 4 reads *"Commit and push — Commit all changes with a
 * clear message, push the branch, and create a PR with `gh pr create`"*, whose
 * step 5 reports `PR: <url>`, and whose coordinator refuses outside a
 * repository because *"it spawns agents in isolated git worktrees and creates
 * PRs from each"*. Read it for yourself with
 * `grep -aob 'independent units' <the vendored claude binary>` and the bytes
 * around the single hit.
 *
 * So the native mechanism is not a cheaper way to reach our posture: its
 * PROGRESS TRACKING parses the PR url, which makes the forge write load-bearing
 * rather than a last optional step. Adopting it would push branches and open
 * pull requests — two forge writes — and QH2 = B says a human opens the merge
 * requests. Native-first asks what the runtime already has; the honest answer
 * here is *"it has the mechanism and the opposite posture"*, and that is the
 * reason the host keeps its own fan-out instead of enabling that one.
 *
 * **claude, second half.** The SDK's own workflow engine (QH9 = B) is not the
 * missing piece either: `workflows.md#what-the-saved-script-looks-like` gives
 * the whole vocabulary — *"`agent()` spawns one subagent, `pipeline()` runs one
 * per item in a list, and `parallel()` runs a set of agent tasks at the same
 * time"* — all of it over SUBAGENTS, with worktrees named nowhere on the page,
 * and `workflows.md#bundled-workflows` ships exactly one:
 * *"Claude Code includes `/deep-research` as a built-in workflow"*. Where
 * worktrees and subagents do meet — `worktrees.md#isolate-subagents-with-worktrees`
 * — the isolation is deliberately temporary: *"Each subagent gets a temporary worktree that Claude
 * Code removes automatically when the subagent finishes without changes"*. A
 * batch has to leave a durable named branch behind, which is the opposite of
 * that lifetime.
 *
 * **codex — no isolation to build on.** Multi-agent v2 spawns subagents
 * (`MultiAgentV2ConfigToml`, `AgentsToml.max_concurrent_threads_per_session`),
 * but the whole shipped config schema contains the strings `worktree`,
 * `isolation`, `branch`, `pull_request` and `merge_request` ZERO times each
 * (instrument: `str.count` over `packages/codex-protocol/schema/config-schema.json`,
 * 2026-09-12). Codex can fan out; it cannot isolate a fan-out or name a branch.
 *
 * **Pi — the closest, and still not it.** Pi has dynamic workflows and child
 * sessions, and the host already gives a Pi child a worktree lease
 * (`SessionManager.acquirePiWorktreeLease`). What it has no notion of is the
 * branch-per-unit handoff: nothing in that path names a branch for a person to
 * submit.
 *
 * The residue, stated rather than hidden: the host fan-out is the seam, and it
 * is the ONLY one of the four that stops at the branch.
 *
 * ## What this module checks, and the one thing it cannot
 *
 * {@link BATCH_FAN_OUT_REGIONS} is the fan-out's whole path — planner,
 * executor, tool handler, tool schema and the model-facing description — and
 * {@link findForgeWrites} is the detector. The test beside this file reads each
 * region off disk and asserts zero hits, with a positive control per signature
 * so an absence claim is never the detector silently failing to match.
 *
 * **It cannot tell a quotation from an instruction, and that cost a real red
 * inside this row.** The planner's own back-pointer originally QUOTED the
 * native skill's step verbatim, and the guard reported the file it was
 * documenting — the same shape as AGENTS.md's rule that a correction spelling a
 * dead anchor re-creates the finding it repairs. So two conventions, both
 * load-bearing: the verbatim forge commands live HERE, in the module that is
 * deliberately not one of its own regions, and every file that IS a region
 * names a forge command in WORDS. A region is the DECLARATION, so the docblock
 * above it is outside the scan; the model-facing DESCRIPTION is inside it on
 * purpose, because text handed to the model telling it to open a merge request
 * would be the defect, not a note about one.
 *
 * It cannot speak for what a CHILD does. Each unit is a full session and the
 * user's own prompt may tell it to push; that is the user's instruction to their
 * own agent, not the batch acting for them. The property is about the fan-out:
 * the thing the product does on its own, without being asked, is create
 * worktrees and branches and then stop.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Repo root, from this file's own location. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

/** One way a forge write could get onto the fan-out path. */
export interface ForgeWriteSignature {
  /** Stable id, so a failure names WHICH refusal was broken. */
  readonly id: string;
  /** Why this one is refused, in the failure message. */
  readonly why: string;
  readonly pattern: RegExp;
}

/**
 * Every shape a forge write takes in this repository's reach.
 *
 * Chosen to be exact rather than broad, because a guard that fires on prose is
 * a guard people delete: the fan-out's own docblocks say *"a HUMAN opens the
 * merge requests"* and every file here calls `Array.prototype.push` — so the
 * patterns match the COMMAND `git push`, the underscore spelling GitLab's API
 * uses, and the tool names, never the English words.
 */
export const FORGE_WRITE_SIGNATURES: readonly ForgeWriteSignature[] = Object.freeze([
  {
    id: 'git-push',
    why: 'the batch leaves branches local; pushing is a forge write and the human decides when it happens',
    // Three spellings, because the host runs git through an ARGV array as often
    // as through a command line: `git push …`, a quoted `'push'` argv element,
    // and `push origin …` inside one string. A bare `push` is deliberately NOT
    // a hit — `Array.prototype.push` is on every other line of this path.
    pattern: /\bgit\s+push\b|(['"`])push\1\s*[,\]]|\bpush\s+(?:origin|--set-upstream|-u)\b/,
  },
  {
    id: 'gh-cli',
    why: "GitHub's CLI: `gh pr create` is the native /batch skill's step 4, and the step QH2 = B refuses",
    pattern: /\bgh\s+(?:pr|api|repo|release)\b/,
  },
  {
    id: 'glab-cli',
    why: "GitLab's CLI: the same write by another name",
    pattern: /\bglab\s+(?:mr|api|repo)\b/,
  },
  {
    id: 'dp-gitlab-mcp',
    why: 'the built-in dpGitlab MCP is the developer harness, and QH2 = B names it: the batch must not call it',
    pattern: /dpGitlab|dp_gitlab_/,
  },
  {
    id: 'forge-api-route',
    why: 'a forge REST route reached from the fan-out would be a write nobody approved',
    pattern: /merge_requests|api\.github\.com|\/pulls\b|api\/v4\/projects/,
  },
  {
    id: 'forge-write-verb',
    why: 'a named create/submit helper is the same write wearing a friendlier name',
    pattern: /create[-_]?[Mm]erge[-_]?[Rr]equest|create[-_]?[Pp]ull[-_]?[Rr]equest|openMergeRequest|submitMergeRequest/,
  },
  {
    id: 'network-call',
    why: 'the fan-out path makes no network call of any kind, which is what makes the refusal checkable at all',
    pattern: /\bfetch\s*\(|\baxios\b|XMLHttpRequest|\bhttps?\.request\s*\(/,
  },
]);

/** One signature caught in one region. */
export interface ForgeWriteHit {
  readonly id: string;
  readonly why: string;
  /** The matched text, so a failure shows the offending line rather than a rule id. */
  readonly match: string;
}

/** Every signature that matches `source`, in signature order. */
export function findForgeWrites(source: string): readonly ForgeWriteHit[] {
  const hits: ForgeWriteHit[] = [];
  for (const signature of FORGE_WRITE_SIGNATURES) {
    const found = signature.pattern.exec(source);
    if (found) hits.push({ id: signature.id, why: signature.why, match: found[0] });
  }
  return hits;
}

/** One stretch of source the fan-out actually runs through. */
export interface BatchFanOutRegion {
  /** Repo-relative, so a failure names a path a reader can open. */
  readonly file: string;
  /**
   * The declaration to slice out, or `null` for the whole file.
   *
   * Sliced rather than whole wherever the file has other tenants: `tool-defs.ts`
   * describes fifty tools and `SessionManager.ts` is the host, so scanning
   * either whole would report their neighbours' perfectly legitimate text.
   */
  readonly symbol: string | null;
  /**
   * A string the slice MUST contain.
   *
   * The vacuity guard: a rename, a reformat or a wrong slice yields text that no
   * longer holds the anchor, and the test fails there instead of reporting a
   * clean scan of nothing. Every absence claim in this repository owes a
   * positive control; this is the one for the SLICING.
   */
  readonly anchor: string;
}

/**
 * The fan-out's whole path, in call order.
 *
 * **What the completeness arm beside this list does and does not do**, because
 * the overclaim is the easy mistake to make here: it fails the moment a LISTED
 * path stops existing or a listed symbol is renamed away, so the guard cannot
 * silently shrink. It cannot notice a NEW module joining the fan-out — that is
 * this guard's honest residue, the same class as H20's (a type refuses the
 * requests it types and says nothing about a module written beside it).
 *
 * What makes it cheap to re-derive rather than trusted: every module on this
 * path names the planner. Measured 2026-09-12,
 * `git grep -aln 'worktree-batch-plan' -- packages apps` returns six files —
 * this guard and its test, the planner's own test, `SessionManager.ts`,
 * `handlers/worktree.ts`, and the executor's test — i.e. the two non-test
 * consumers are both listed below. Re-run that grep when adding to the batch;
 * a seventh non-test file is a region this list is missing.
 */
export const BATCH_FAN_OUT_REGIONS: readonly BatchFanOutRegion[] = Object.freeze([
  {
    file: 'packages/server-core/src/pi-harness/worktree-batch-plan.ts',
    symbol: null,
    anchor: 'export function planWorktreeBatch',
  },
  {
    file: 'packages/server-core/src/sessions/SessionManager.ts',
    symbol: 'runWorktreeBatch',
    anchor: 'planWorktreeBatch({',
  },
  {
    file: 'packages/session-tools-core/src/handlers/worktree.ts',
    symbol: 'handleWorktreeBatch',
    anchor: 'ctx.worktree.batch(',
  },
  {
    file: 'packages/session-tools-core/src/tool-defs.ts',
    symbol: 'WorktreeBatchSchema',
    anchor: 'branchPrefix',
  },
  {
    file: 'packages/session-tools-core/src/tool-defs.ts',
    symbol: 'WorktreeBatch',
    anchor: 'Run several pieces of work in parallel',
  },
]);

/**
 * The sentence the MODEL is told, and the reason it is pinned from here.
 *
 * H20's refusal line is a constant with a test asserting it names both
 * refusals, for the stated reason that *"a refusal nobody can see is
 * indistinguishable from a defect"*. This one cannot be a constant in the same
 * way — it lives in `tool-defs.ts`, and `session-tools-core` must not import
 * `server-core` — so the guard reads it as data instead. Same effect: an edit
 * that drops the refusal from the tool description turns this file's test red.
 */
export const BATCH_REFUSAL_SENTENCE =
  'The batch opens no merge request and pushes nothing — the branches stay in this repository and a person submits them.';

/**
 * Slice one declaration out of a source file.
 *
 * Deliberately line-based rather than brace-counted: the regions include a
 * multi-line TEMPLATE LITERAL (the tool description) whose continuation lines
 * start at column 0, so any rule keyed on indentation alone cuts it in half,
 * and a brace counter has to understand `${}` to get it right. The rule here is
 * narrower and survives both: start at the line that INTRODUCES the symbol, end
 * at the next line that introduces something else at the same indent.
 *
 * Returns `null` when the symbol is not found — the caller must treat that as a
 * failure, never as an empty clean scan.
 */
export function sliceDeclaration(source: string, symbol: string): string | null {
  const lines = source.split('\n');
  const modifiers = '(?:export |default |private |public |protected |static |async |readonly |const |let |var |function |class )*';
  const opener = new RegExp(`^([ \\t]*)${modifiers}${symbol}\\b`);
  const startIndex = lines.findIndex(line => opener.test(line));
  if (startIndex < 0) return null;

  const indent = /^[ \t]*/.exec(lines[startIndex] ?? '')?.[0] ?? '';
  // A new tenant at the same indent: another declaration, another object entry,
  // or the docblock that introduces one.
  const boundary = new RegExp(
    `^${indent}(?:/\\*\\*|(?:export |default |private |public |protected |static |async |readonly |const |let |var |function |class )*[A-Za-z_$][\\w$]*\\s*[:(<=])`,
  );
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (boundary.test(lines[index] ?? '')) { endIndex = index; break; }
  }
  return lines.slice(startIndex, endIndex).join('\n');
}

/** Read one region off disk. Throws with the path when the slice cannot be taken. */
export function readBatchFanOutRegion(region: BatchFanOutRegion): string {
  const source = readFileSync(join(REPO_ROOT, region.file), 'utf8');
  if (region.symbol === null) return source;
  const sliced = sliceDeclaration(source, region.symbol);
  if (sliced === null) {
    throw new Error(`worktree-batch-forge-free: ${region.symbol} not found in ${region.file}`);
  }
  return sliced;
}
