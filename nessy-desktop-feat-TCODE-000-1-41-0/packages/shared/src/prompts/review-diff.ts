/**
 * The host-computed diff a delegated review runs on — P3.276.
 *
 * ## Why it is here and not in the Pi review tool it came from
 *
 * `code-review.md` § *Review a diff locally* is a promise about every runtime:
 * "The review runs as a background subagent with its own context window, so it
 * doesn't fill your conversation." P3.204 made the bundled skill keep the
 * CONTEXT half of that on claude and codex by delegating to a subagent. It left
 * the DIFF half open, and named it: the only diff computation in this fork lived
 * inside `pi-agent-server/src/orchestrator/review-tool.ts`, a Pi-runtime tool. On
 * claude and codex the delegated reviewer therefore reviewed whatever diff the
 * model chose to run for itself — a different scope decided by a different
 * reader on every invocation, and one that quietly disagreed with the documented
 * default the same skill spells out ("your branch's commits ahead of its
 * upstream plus any uncommitted changes").
 *
 * So the computation moves to a runtime-neutral module and the Pi tool becomes
 * its first consumer rather than its owner. Nothing about Pi's behaviour changes
 * — its own suite is the control — and the second and third consumers no longer
 * have to reimplement the six target modes, the untracked-file walk, the
 * argument-injection guard or the 256 KB cap to get the same answer.
 *
 * ## Residue, stated rather than implied
 *
 * A module is reachable by a runtime only once something OFFERS it there. On Pi
 * that is the `review` tool. On claude and codex the offer has to be a session
 * tool (the `mcp__session__*` surface both runtimes already carry), and that
 * registration lives outside this file. Until it exists, this module is the one
 * diff computation and Pi is still the only runtime wired to it.
 *
 * ## Deliberately NOT re-exported from `prompts/index.ts`
 *
 * Every other module in this directory is pure text. This one spawns `git`, so a
 * barrel re-export would pull `node:child_process` into anything that imports the
 * directory — including bundles that have no business carrying it. Consumers
 * import it by path, which is what `review-tool.ts` already does for
 * `untrusted-text.ts`.
 *
 * ## Read-only, and that is load-bearing
 *
 * The reviewer child's toolset is read-only — it has no shell and no git — which
 * is why the diff has to arrive already computed. Every git invocation below is
 * a read: `diff`, `show`, `merge-base`, `rev-parse`, `ls-files`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Hard ceiling on the diff embedded in the reviewer's task. */
export const REVIEW_DIFF_CAP_BYTES = 256 * 1024;
/**
 * Read a generous window so the diff is captured whole before capping; a diff
 * larger than this is truncated (see {@link runGit}'s maxBuffer handling).
 */
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

/**
 * What a review can be pointed at. `code-review.md:293` fixes both halves:
 *
 * > It reviews your branch's commits ahead of its upstream plus any uncommitted
 * > changes … To review something else, pass a target: a file path, a PR number,
 * > a branch name, or a ref range such as `main...my-feature`.
 *
 * - `upstream`    the documented DEFAULT: `@{u}...HEAD` plus the working tree.
 *                 Degrades to the working tree alone when no upstream is set,
 *                 which is what a branch with no upstream HAS ahead of it.
 * - `uncommitted` the previous default, still addressable explicitly.
 * - `base`        a branch name — merge-base(base, HEAD)..HEAD.
 * - `range`       a literal `a..b` / `a...b` ref range.
 * - `paths`       one or more file paths.
 * - `commit`      a single commit. Nessy-only; the page names no commit target,
 *                 but this is the tool's pre-existing surface and dropping it
 *                 would narrow a shipped contract to widen it elsewhere.
 *
 * A PR NUMBER is deliberately absent. It is the one documented target with no
 * mechanism anywhere in this fork (`grep -a` for `gh pr`, `pull request comment`
 * and `createReviewComment` over `packages` and `apps` is empty), and guessing
 * that a bare integer is a PR would silently review the wrong thing. The
 * bundled skill refuses it in words instead.
 */
export type ReviewTargetMode = 'upstream' | 'uncommitted' | 'base' | 'commit' | 'range' | 'paths';

export interface NormalizedReviewRequest {
  mode: ReviewTargetMode;
  /** Base ref (mode 'base'), single commit (mode 'commit'), or range (mode 'range'). */
  ref?: string;
  /** File paths (mode 'paths'). */
  paths?: string[];
  effort?: string;
  instructions?: string;
}

/** Host-computed diff for the target. Injectable so tests avoid touching git. */
export type ComputeReviewDiff = (
  request: NormalizedReviewRequest,
  cwd: string,
) => Promise<string>;

/** A `a..b` / `a...b` ref range, with both endpoints present. */
const REF_RANGE_PATTERN = /^[^.\s][^\s]*\.{2,3}[^.\s][^\s]*$/;

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePaths(value: unknown): string[] | undefined {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined;
  if (raw === undefined) return undefined;
  const paths = raw.map(entry => trimmedString(entry)).filter((entry): entry is string => entry !== undefined);
  return paths.length > 0 ? paths : undefined;
}

/**
 * Read one review request's TARGET out of raw tool arguments.
 *
 * `effort` is left to the caller: on Pi it is a `ThinkingLevel` the spawner
 * hands the child, and normalizing it here would drag the thinking-level
 * vocabulary into a module whose whole subject is git. The caller validates it
 * and passes the value through — {@link NormalizedReviewRequest.effort} is a
 * plain string for that reason.
 */
export function normalizeReviewTarget(
  params: unknown,
  extra: { effort?: string; instructions?: string } = {},
): NormalizedReviewRequest {
  if (!isRecord(params)) throw new Error('review arguments must be an object');

  const rest = {
    ...(extra.effort ? { effort: extra.effort } : {}),
    ...(extra.instructions ? { instructions: extra.instructions } : {}),
  };

  const base = trimmedString(params.base);
  const commit = trimmedString(params.commit);
  const range = trimmedString(params.range);
  const paths = normalizePaths(params.paths);
  const scope = trimmedString(params.scope);

  const targets = [
    ['base', base], ['commit', commit], ['range', range], ['paths', paths],
  ].filter(([, value]) => value !== undefined).map(([name]) => name);
  if (targets.length > 1) {
    throw new Error(`review accepts at most one target, got ${targets.join(' and ')}`);
  }
  // `scope` picks between the two no-target diffs, so it cannot also carry a
  // target. Rejecting is the point: silently ignoring one of two conflicting
  // targets is how a review ends up reporting on the wrong diff.
  if (scope !== undefined && targets.length > 0) {
    throw new Error(`review accepts scope only without a target, got scope and ${targets[0]}`);
  }
  if (scope !== undefined && scope !== 'upstream' && scope !== 'uncommitted') {
    throw new Error(`review scope must be "upstream" or "uncommitted", got ${scope}`);
  }

  if (base !== undefined) return { mode: 'base', ref: base, ...rest };
  if (commit !== undefined) return { mode: 'commit', ref: commit, ...rest };
  if (range !== undefined) {
    if (!REF_RANGE_PATTERN.test(range)) {
      throw new Error(`review range must look like main...my-feature, got ${range}`);
    }
    return { mode: 'range', ref: range, ...rest };
  }
  if (paths !== undefined) return { mode: 'paths', paths, ...rest };
  // `code-review.md:293` — the default is the branch's commits ahead of its
  // upstream PLUS the working tree, not the working tree alone.
  return { mode: scope === 'uncommitted' ? 'uncommitted' : 'upstream', ...rest };
}

/** Reject refs that could smuggle extra git arguments or options. */
export function assertSafeRef(ref: string): void {
  if (ref.startsWith('-') || /[\s;|&$`'"\\]/.test(ref)) {
    throw new Error(`invalid git ref: ${ref}`);
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    // A huge diff can exceed maxBuffer. git still produced partial stdout; keep
    // it (it will be capped downstream) rather than failing the whole review.
    const record = error as { code?: string; stdout?: string };
    if (record?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && typeof record.stdout === 'string') {
      return record.stdout;
    }
    throw error;
  }
}

/** staged + unstaged + untracked, the working-tree half of every scope. */
async function uncommittedDiff(cwd: string): Promise<string> {
  const tracked = await runGit(['diff', '--no-color', 'HEAD'], cwd);
  const untrackedList = (await runGit(['ls-files', '--others', '--exclude-standard'], cwd))
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const untracked: string[] = [];
  for (const file of untrackedList) {
    assertSafeRef(file);
    // /dev/null base diff shows the whole new file as additions; --no-index
    // exits non-zero when differences exist, so read stdout from the error.
    try {
      untracked.push(await runGit(['diff', '--no-color', '--no-index', '/dev/null', file], cwd));
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (typeof stdout === 'string' && stdout) untracked.push(stdout);
    }
  }
  return [tracked, ...untracked].filter(Boolean).join('\n');
}

/**
 * The branch's commits ahead of its upstream. Returns `''` when the branch has
 * no upstream — that is not an error, it is a branch with nothing ahead of one,
 * and the working-tree half of the scope still stands on its own.
 */
async function aheadOfUpstreamDiff(cwd: string): Promise<string> {
  let upstream: string;
  try {
    upstream = (await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd)).trim();
  } catch {
    return '';
  }
  if (!upstream) return '';
  assertSafeRef(upstream);
  return runGit(['diff', '--no-color', `${upstream}...HEAD`], cwd);
}

export const computeReviewDiffWithGit: ComputeReviewDiff = async (request, cwd) => {
  if (request.mode === 'commit') {
    assertSafeRef(request.ref!);
    return runGit(['show', '--no-color', request.ref!], cwd);
  }
  if (request.mode === 'base') {
    assertSafeRef(request.ref!);
    const mergeBase = (await runGit(['merge-base', 'HEAD', request.ref!], cwd)).trim();
    const anchor = mergeBase || request.ref!;
    return runGit(['diff', '--no-color', `${anchor}...HEAD`], cwd);
  }
  if (request.mode === 'range') {
    assertSafeRef(request.ref!);
    return runGit(['diff', '--no-color', request.ref!], cwd);
  }
  if (request.mode === 'paths') {
    // `--` before the paths is what stops a path from being read as a revision;
    // `assertSafeRef` on each is the same seatbelt the untracked walk already
    // applies to a filename.
    for (const path of request.paths!) assertSafeRef(path);
    return runGit(['diff', '--no-color', 'HEAD', '--', ...request.paths!], cwd);
  }
  if (request.mode === 'upstream') {
    const [ahead, working] = [await aheadOfUpstreamDiff(cwd), await uncommittedDiff(cwd)];
    return [ahead, working].filter(Boolean).join('\n');
  }
  return uncommittedDiff(cwd);
};

export function capReviewDiff(diff: string): string {
  if (Buffer.byteLength(diff, 'utf8') <= REVIEW_DIFF_CAP_BYTES) return diff;
  let truncated = diff.slice(0, REVIEW_DIFF_CAP_BYTES);
  while (Buffer.byteLength(truncated, 'utf8') > REVIEW_DIFF_CAP_BYTES) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Diff truncated to 256KB for review.]`;
}

export function describeReviewTarget(request: NormalizedReviewRequest): string {
  if (request.mode === 'commit') return `commit ${request.ref}`;
  if (request.mode === 'base') return `changes since merge-base with ${request.ref}`;
  if (request.mode === 'range') return `ref range ${request.ref}`;
  if (request.mode === 'paths') return `changes in ${request.paths!.join(', ')}`;
  if (request.mode === 'upstream') {
    return 'this branch\'s commits ahead of its upstream plus any uncommitted changes';
  }
  return 'uncommitted changes (staged, unstaged, and untracked)';
}

/**
 * The task text the isolated reviewer receives — the diff and what it is, and
 * nothing about the conversation that asked for it.
 */
export function buildReviewTask(request: NormalizedReviewRequest, diff: string): string {
  const extra = request.instructions
    ? `\n\nAdditional reviewer instructions:\n${request.instructions}`
    : '';
  return [
    `Review the following ${describeReviewTarget(request)}.`,
    extra.trim(),
    '',
    'Diff under review:',
    '```diff',
    diff,
    '```',
  ].join('\n');
}
