import type { ResolvedWorktreeSettings, WorktreeBaseRef } from '@nessy-agent/shared/config'

/**
 * The git a worktree setting turns into.
 *
 * `baseRef`, `sparsePaths` and `symlinkDirectories` are settings that only mean
 * anything as git commands, and the mapping is the part that can silently be
 * wrong: a `sparsePaths` that never reaches `sparse-checkout` leaves a full
 * checkout that looks correct, and a `baseRef: "fresh"` that quietly resolves
 * local HEAD produces a worktree branched off the wrong commit with no error.
 *
 * Building the argv here rather than inline in `SessionManager` is what makes
 * that mapping assertable without a repository, a supervisor and a session.
 */

export interface WorktreeGitCommand {
  operation: string
  /** Which directory the command runs in — the repo, or the new worktree. */
  cwd: 'repo' | 'worktree'
  args: string[]
  /** A non-zero exit is tolerated and reported rather than thrown. */
  allowFailure?: boolean
  /** Per-command cap in ms; absent means the caller's default process budget. */
  timeoutMs?: number
}

export interface WorktreeBaseFreshness {
  /**
   * Epoch ms of the repository's last fetch (`FETCH_HEAD` mtime in the SHARED
   * git dir). Absent means never fetched, which is stale.
   */
  lastFetchedAtMs?: number
  nowMs: number
  /** Whether `refs/remotes/origin/HEAD` is cached (`symbolic-ref --quiet` exit 0). */
  originHeadCached: boolean
}

const FRESH_STALE_AFTER_MS = 86_400_000
const FRESH_PRELUDE_TIMEOUT_MS = 5_000

/**
 * Ordered candidates for the base commit of a NEW worktree; the first that
 * succeeds wins. Prelude commands (operations `base-fetch`/`base-set-head`)
 * are ref refreshes, NOT candidates: the caller must not capture their output
 * as a sha and must not let their success end the candidate loop.
 *
 * `"fresh"` — worktrees.md:128: "For a `"fresh"` base, Claude Code keeps
 * `origin/HEAD` current: when the repository hasn't been fetched in the last
 * 24 hours, it fetches the default branch, capped at five seconds, and uses
 * the locally cached ref if the fetch fails." So a stale (or never-fetched)
 * repo gets a `fetch` first, and one whose `origin/HEAD` was never written
 * gets `remote set-head origin --auto` — the command that creates that ref;
 * `fetch` alone does not. Both are `allowFailure` with a 5s cap so a dead or
 * denied remote degrades to the cached ref. Omitting `freshness` keeps the
 * pre-refresh two-candidate output. The local-HEAD fallback stays last: a
 * repository with no remote, or one whose `origin/HEAD` can't be read or
 * fetched, still gets a worktree instead of a failure.
 *
 * `"head"` is local HEAD, which inside a worktree is that worktree's HEAD. That
 * falls out for free: the command runs with `-C <root>`, and the caller's root
 * IS the worktree in that case. It never fetches.
 */
export function worktreeBaseShaCandidates(
  repoRoot: string,
  baseRef: WorktreeBaseRef,
  freshness?: WorktreeBaseFreshness,
): WorktreeGitCommand[] {
  const head: WorktreeGitCommand = {
    operation: 'base',
    cwd: 'repo',
    args: ['-C', repoRoot, 'rev-parse', 'HEAD'],
  }
  if (baseRef === 'head') return [head]
  const commands: WorktreeGitCommand[] = []
  if (freshness) {
    const stale = freshness.lastFetchedAtMs === undefined
      || freshness.nowMs - freshness.lastFetchedAtMs >= FRESH_STALE_AFTER_MS
    if (stale) {
      commands.push({
        operation: 'base-fetch',
        cwd: 'repo',
        args: ['-C', repoRoot, 'fetch', '--no-tags', '--quiet', 'origin'],
        allowFailure: true,
        timeoutMs: FRESH_PRELUDE_TIMEOUT_MS,
      })
    }
    if (!freshness.originHeadCached) {
      commands.push({
        operation: 'base-set-head',
        cwd: 'repo',
        args: ['-C', repoRoot, 'remote', 'set-head', 'origin', '--auto'],
        allowFailure: true,
        timeoutMs: FRESH_PRELUDE_TIMEOUT_MS,
      })
    }
  }
  commands.push(
    { operation: 'base-fresh', cwd: 'repo', args: ['-C', repoRoot, 'rev-parse', 'origin/HEAD'], allowFailure: true },
    head,
  )
  return commands
}

/**
 * F1.904 — the prefix of the refusal for a repository that has no commit yet.
 * It reaches the spawning model (and the tool row) verbatim, like every other
 * worktree-creation error.
 */
export const WORKTREE_NO_COMMIT_YET_PREFIX = 'worktree-no-commit-yet'

/**
 * `rev-list -n 1 --all` exits 0 and prints nothing exactly when no ref reaches
 * a commit — the refusal's own claim, measured rather than read out of git's
 * error text (which git localises). Measured on git 2.43.0: a fresh `git init`
 * exits 0 with empty output, a repository with a commit prints its sha, and a
 * directory that is not a repository exits 128.
 */
export function worktreeNoCommitProbeCommand(repoRoot: string): WorktreeGitCommand {
  return {
    operation: 'base-no-commit-probe',
    cwd: 'repo',
    args: ['-C', repoRoot, 'rev-list', '-n', '1', '--all'],
    allowFailure: true,
  }
}

/**
 * F1.904 — turn a failed `base` step into a plain refusal when the repository
 * has no commit yet, and rethrow every other failure unchanged.
 *
 * A worktree is a branch off a commit, so a freshly initialised repository
 * cannot have one. Before this, the `base` step's `git rev-parse HEAD` failed
 * with "ambiguous argument 'HEAD': unknown revision", which reached the user and
 * the model as `worktree-git-base-failed: fatal: ambiguous argument 'HEAD'…` —
 * true, and silent about the remedy. `worktrees.md` does not describe this case
 * (searched 2026-09-26), so the choice is ours, stated here: refuse and name the
 * one step that fixes it. Committing on the user's behalf would write to their
 * repository behind their back, so it is not done.
 *
 * The probe runs ONLY after the `base` step failed, so an ordinary creation
 * pays nothing. Residue: an unborn branch in a repository that has commits on
 * other refs (`git checkout --orphan`) prints a sha and keeps git's own
 * message, and so does a probe that itself fails.
 */
export async function explainWorktreeBaseFailure(
  error: unknown,
  failedOperation: string,
  repoRoot: string,
  run: (probe: WorktreeGitCommand) => Promise<{ output: string; exitCode: number | null }>,
): Promise<never> {
  if (failedOperation !== 'base') throw error
  let probe: { output: string; exitCode: number | null }
  try {
    probe = await run(worktreeNoCommitProbeCommand(repoRoot))
  } catch {
    throw error
  }
  if (probe.exitCode === 0 && probe.output.trim() === '') {
    throw new Error(
      `${WORKTREE_NO_COMMIT_YET_PREFIX}: this repository has no commit yet, so a worktree has nothing to branch from. `
      + 'Make a first commit in the repository, then start the worktree (or the worktree subagent) again.',
      { cause: error instanceof Error ? error : undefined },
    )
  }
  throw error
}

/**
 * P6.335 — a merge request (or pull request) a worktree can be branched from.
 *
 * `forge` decides only the REF NAMESPACE, which is the whole of the difference
 * between the two: gitlab publishes a merge request's head at
 * `refs/merge-requests/<n>/head` and github publishes a pull request's at
 * `refs/pull/<n>/head`. Both are fetched from `origin` and neither needs an API
 * token, which is why this is git's own mechanism rather than forge
 * integration — the row's native answer, and the reason no forge credential
 * appears anywhere in this file.
 */
export interface ForgeMergeRequestRef {
  forge: 'gitlab' | 'github'
  /** The merge/pull request NUMBER, as the forge shows it. */
  number: number
  /** `!12` on gitlab, `#12` on github — the label a session wears. */
  label: string
}

/**
 * Recognise a merge-request or pull-request URL, or answer `null`.
 *
 * DETECTION IS BY PATH SEGMENT, NOT BY HOST, and that is the decision worth
 * stating: `github.com` is one deployment of github and `gitlab.com` is one of
 * gitlab, while both ship self-hosted under arbitrary hostnames — a host
 * allowlist would work for exactly two companies and fail for every enterprise
 * install. The path segment (`/-/merge_requests/<n>` or `/pull/<n>`) is part of
 * each forge's own URL contract and travels with the deployment.
 *
 * `merge_requests` is matched with and without gitlab's `/-/` separator,
 * because both spellings are live: the separator was introduced in gitlab 11.11
 * and old links (and every self-hosted instance older than that) carry the
 * bare form.
 *
 * Anything else answers `null` rather than guessing — a worktree branched off a
 * ref that does not exist fails at `git fetch` with a message about the ref,
 * which is a worse place to learn the URL was wrong.
 */
export function parseForgeMergeRequestRef(value: string): ForgeMergeRequestRef | null {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  let path: string
  try {
    path = new URL(trimmed).pathname
  } catch {
    return null
  }
  const gitlab = /\/(?:-\/)?merge_requests\/(\d+)(?:\/|$)/.exec(path)
  if (gitlab) {
    const number = Number(gitlab[1])
    if (!Number.isSafeInteger(number) || number <= 0) return null
    return { forge: 'gitlab', number, label: `!${number}` }
  }
  const github = /\/pull\/(\d+)(?:\/|$)/.exec(path)
  if (github) {
    const number = Number(github[1])
    if (!Number.isSafeInteger(number) || number <= 0) return null
    return { forge: 'github', number, label: `#${number}` }
  }
  return null
}

/**
 * The two commands that turn a {@link ForgeMergeRequestRef} into a base sha.
 *
 * Neither is `allowFailure`: `worktreeBaseShaCandidates` tolerates a failed
 * refresh because it has a local-HEAD fallback, and this has none. A session
 * asked to start on a merge request and given the default branch instead is the
 * same "ran anyway, somewhere else" outcome the start-in-worktree path already
 * refuses — so a fetch that cannot find the ref must fail the creation, with
 * git's own message naming the ref.
 *
 * `FETCH_HEAD` is read in a SECOND command rather than trusted from the fetch's
 * output: `git fetch` prints a human-readable summary whose shape is not a
 * contract, while `rev-parse FETCH_HEAD` is the documented way to name what was
 * just fetched.
 */
export function mergeRequestFetchCommands(
  repoRoot: string,
  ref: ForgeMergeRequestRef,
): WorktreeGitCommand[] {
  const namespace = ref.forge === 'gitlab' ? 'merge-requests' : 'pull'
  return [
    {
      operation: 'base-merge-request-fetch',
      cwd: 'repo',
      args: ['-C', repoRoot, 'fetch', '--no-tags', '--quiet', 'origin', `${namespace}/${ref.number}/head`],
      timeoutMs: FRESH_PRELUDE_TIMEOUT_MS,
    },
    {
      operation: 'base-merge-request',
      cwd: 'repo',
      args: ['-C', repoRoot, 'rev-parse', 'FETCH_HEAD'],
    },
  ]
}

export interface WorktreeCreatePlanInput {
  repoRoot: string
  worktreePath: string
  branch: string
  baseSha: string
  /** Whether the branch already exists, which decides `add` vs `add -b`. */
  branchExists: boolean
  settings: Pick<ResolvedWorktreeSettings, 'sparsePaths'>
  /**
   * Filter-driver names defined in the repository's OWN config, from
   * {@link parseWorktreeFilterDrivers} — P6.324.
   *
   * Absent or empty leaves the argv byte-identical to before that row, so a
   * repository that defines no driver spawns exactly the command it always did.
   */
  filterDrivers?: readonly string[]
}

/**
 * The three config keys that bind a filter driver to a COMMAND, and all three
 * must be cleared — measured on git 2.43.0, because clearing two is not enough.
 *
 * A repository-defined `filter.<name>.smudge` runs as a shell command during
 * `git worktree add`. Reproduced: a repo whose `.gitattributes` says
 * `f.txt filter=evil` and whose `.git/config` sets
 * `filter.evil.smudge = sh -c '…'` executes that shell on a plain
 * `git worktree add`, and `-c filter.evil.smudge= -c filter.evil.clean=`
 * suppresses it while checking out the stored bytes unchanged.
 *
 * **`process` is the correction.** The long-running filter protocol is a THIRD
 * binding, and on the same rig `filter.evil.process` executed under a plain add
 * AND under an add that cleared only smudge and clean; only
 * `-c filter.evil.process=` stopped it. A remedy naming two keys would have
 * left the most capable of the three armed.
 */
const FILTER_DRIVER_COMMAND_KEYS = ['clean', 'smudge', 'process'] as const

/**
 * Probe for filter drivers the REPOSITORY defines — P6.324.
 *
 * `--local` is load-bearing and is not a tidiness choice: a driver in the
 * user's GLOBAL config is their own `git-lfs`, and neutralising it would check
 * out pointer files where the user expects their content. What this defends
 * against is a driver the repository carries, which is attacker-controlled in
 * the same sense `.gitattributes` is — the agent can write to the checkout.
 *
 * `--name-only` so the command STRINGS never enter our logs or our argv;
 * `allowFailure` because `--get-regexp` exits 1 when nothing matches, which is
 * the ordinary answer for almost every repository.
 */
export function worktreeFilterDriverProbeCommand(repoRoot: string): WorktreeGitCommand {
  return {
    operation: 'filter-driver-probe',
    cwd: 'repo',
    args: ['-C', repoRoot, 'config', '--local', '--name-only', '--get-regexp', '^filter\\.'],
    allowFailure: true,
  }
}

/**
 * Driver NAMES from the probe's output, deduplicated and in first-seen order.
 *
 * Each line is `filter.<name>.<key>`, and `<name>` may itself contain dots — a
 * git subsection name is arbitrary text — so the name is everything between the
 * FIRST and the LAST dot rather than the second segment. Lines whose trailing
 * key is not one that binds a command (`required`, for instance) still
 * contribute their driver name: a repository that declares `filter.x.required`
 * and nothing else has no command to run, and suppressing an undefined key is
 * inert, so the wider reading costs two argv entries and cannot under-cover.
 */
export function parseWorktreeFilterDrivers(output: string): readonly string[] {
  const names: string[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('filter.')) continue
    const rest = trimmed.slice('filter.'.length)
    const lastDot = rest.lastIndexOf('.')
    if (lastDot <= 0) continue
    const name = rest.slice(0, lastDot)
    if (name.length === 0 || names.includes(name)) continue
    names.push(name)
  }
  return Object.freeze(names)
}

/** `-c filter.<name>.<key>=` for every driver and every command-binding key. */
function filterSuppressionArgs(drivers: readonly string[] | undefined): string[] {
  if (!drivers || drivers.length === 0) return []
  return drivers.flatMap(name =>
    FILTER_DRIVER_COMMAND_KEYS.flatMap(key => ['-c', `filter.${name}.${key}=`]))
}

/**
 * Every git command that creates one worktree, in order.
 *
 * With `sparsePaths` the checkout is deferred: `git worktree add --no-checkout`
 * first, then `sparse-checkout set`, then `checkout`. Doing it the other way
 * round would materialise the whole tree and then delete most of it, which is
 * both slower and briefly puts on disk exactly the files sparse checkout exists
 * to keep off it.
 */
export function worktreeCreateCommands(input: WorktreeCreatePlanInput): WorktreeGitCommand[] {
  const sparse = input.settings.sparsePaths
  // P6.324 — before `-C`, because `-c` is a git-level option and the checkout
  // these clear happens inside `add` (and inside the sparse `checkout` below).
  const suppress = filterSuppressionArgs(input.filterDrivers)
  const add = [
    ...suppress,
    '-C', input.repoRoot, 'worktree', 'add',
    ...(sparse.length > 0 ? ['--no-checkout'] : []),
    ...(input.branchExists
      ? [input.worktreePath, input.branch]
      : ['-b', input.branch, input.worktreePath, input.baseSha]),
  ]
  const commands: WorktreeGitCommand[] = [{ operation: 'create', cwd: 'repo', args: add }]
  if (sparse.length === 0) return commands
  commands.push({
    operation: 'sparse-set',
    cwd: 'worktree',
    args: ['-C', input.worktreePath, 'sparse-checkout', 'set', '--cone', ...sparse],
  })
  commands.push({
    operation: 'sparse-checkout',
    cwd: 'worktree',
    // The sparse path defers the checkout to HERE, so this is where the driver
    // would run for a repository that sets `sparsePaths` — suppressing it on
    // the `add` alone would protect only the non-sparse half.
    args: [...suppress, '-C', input.worktreePath, 'checkout'],
  })
  return commands
}

/**
 * C3.129 — what happens when a worktree NAME is reused.
 *
 * `worktrees.md#reuse-a-worktree-name` (anchor verified on the rendered page,
 * 2026-09-12): *"Passing `--worktree` a name whose directory already exists
 * opens that existing worktree instead of creating a new one."* With the default
 * `"fresh"` base it then RESETS to the repository's default branch *"when all of
 * the following hold"* — three conditions — and *"In every other case, Claude
 * Code reopens the worktree at its old tip"*, which the page enumerates as four
 * named cases.
 *
 * That is FIVE documented states, and they are a table rather than a chain of
 * ifs because the page states them as one: three of them are conditions of the
 * CALL (the base ref, the name, whether the state could be read at all) and only
 * two are conditions of the TREE. This function is pure so all five can be
 * asserted without a repository, a supervisor or a session — the same reason
 * every other planner in this module is pure.
 *
 * The CONTROL is the sixth row and the one that keeps the rest honest: a name
 * with no existing worktree directory creates fresh, which is the ordinary path
 * and must not be touched by any of this.
 *
 * **Every unknown resolves to `reopen`, never to `reset`.** A reset moves a
 * branch and checks out a different commit; reopening at the old tip loses
 * nothing. So an unreadable probe, an absent input, a stale remote-tracking ref
 * — each lands on the side that cannot destroy work, and the page names that
 * side itself: *"Claude Code can't verify the worktree's state."*
 *
 * The three answers: `create` (the control — nothing at that name yet), `reset`
 * (the documented reset to the default branch) and `reopen` (at the old tip).
 */
export type WorktreeReopenAction = 'create' | 'reset' | 'reopen'

/**
 * Why {@link worktreeReopenResetDecision} answered as it did — one value per
 * documented state, so a caller can say WHICH of the page's cases it is in
 * rather than only that it is not resetting.
 */
export type WorktreeReopenReason =
  /** The control: nothing at that name yet. */
  | 'no-existing-worktree'
  /** All three conditions hold, with a `"fresh"` base. */
  | 'conditions-met'
  /** `worktree.baseRef` is `"head"`. */
  | 'base-ref-head'
  /** The name is a pull request or merge request reference. */
  | 'merge-request-name'
  /** Claude Code can't verify the worktree's state. */
  | 'unverifiable'
  /** It has uncommitted changes or untracked files. */
  | 'dirty'
  /** It is no longer on the branch we created for it. */
  | 'branch-moved'
  /** It has commits of its own, and they are not the merged case. */
  | 'holds-commits'

/**
 * The worktree's state as git reports it, or `undefined` when it could not be
 * read — which is the page's own *"can't verify"* case and not an error.
 *
 * `exists`, `dirty` and `branch` come from the `inspect` probe the host already
 * runs (`status --porcelain`, `branch --show-current`). The last three are the
 * inputs C3.129 adds; each is optional because each has a probe that may fail,
 * and an absent answer is treated as "not established" rather than as `false`.
 */
export interface WorktreeReopenState {
  /** Whether the worktree directory is there at all. */
  exists: boolean
  /** `status --porcelain` printed something: uncommitted changes or untracked files. */
  dirty: boolean
  /** `branch --show-current`. Empty for a detached HEAD, which is never the branch we created. */
  branch: string
  /**
   * `merge-base --is-ancestor HEAD <default branch>` exited 0: every commit in
   * the worktree is already on the default branch.
   */
  headIsAncestorOfDefault?: boolean
  /**
   * A remote-tracking ref for the worktree's branch still exists locally.
   *
   * `true` is the SAFE answer when unsure: a stale ref that outlived the deleted
   * remote branch reads as "still there" and sends the decision to `reopen`,
   * which loses nothing. The opposite mistake would reset a worktree whose
   * branch is still live on the forge.
   */
  remoteBranchExists?: boolean
}

export interface WorktreeReopenResetInput {
  /** `worktree.baseRef`. Only `"fresh"` can reset — the page names `"head"` as a reopen case. */
  baseRef: WorktreeBaseRef
  /** The worktree NAME the caller reused. */
  name: string
  /** The branch this host created for the worktree. */
  branch: string
  /** {@link WorktreeReopenState}, or absent when the probes could not answer. */
  state?: WorktreeReopenState
}

export interface WorktreeReopenResetDecision {
  action: WorktreeReopenAction
  reason: WorktreeReopenReason
}

/**
 * The two probes C3.129 adds, for the ONE documented state the host could not
 * already read — *"its pull request or merge request was merged and its remote
 * branch deleted"*, which the page says is detected *"from git state alone: the
 * remote branch the worktree pushed to no longer exists, and every commit in the
 * worktree is already on the default branch."*
 *
 * Both are `allowFailure`, and both are LOCAL. `branch --remotes --list` reads
 * the remote-tracking refs this repository already has rather than asking the
 * forge: a network call here would put an unbounded wait, a proxy and a
 * credential on the path that opens a session. The cost is a stale ref reading
 * as "the branch still exists", which sends the decision to `reopen` — the side
 * that loses nothing.
 *
 * The ancestor test is against `origin/HEAD`, the DEFAULT branch, and that is
 * what makes it a different question from the `merge-base --is-ancestor
 * <lease base> HEAD` the `inspect` probe already runs: that one asks whether the
 * worktree moved forward from where we put it, this one asks whether anything it
 * holds is missing from the default branch.
 */
export function worktreeReopenProbeCommands(
  worktreePath: string,
  branch: string,
): WorktreeGitCommand[] {
  return [
    {
      operation: 'reopen-remote-branch',
      cwd: 'worktree',
      args: ['-C', worktreePath, 'branch', '--remotes', '--list', `origin/${branch}`],
      allowFailure: true,
    },
    {
      operation: 'reopen-head-merged',
      cwd: 'worktree',
      args: ['-C', worktreePath, 'merge-base', '--is-ancestor', 'HEAD', 'origin/HEAD'],
      allowFailure: true,
    },
  ]
}

/**
 * `true` when `git branch --remotes --list origin/<branch>` named something.
 *
 * Kept beside the command so the command's output shape and its reading cannot
 * drift apart. An empty listing is git's ordinary answer for "no such
 * remote-tracking ref", which is why the command is `allowFailure` and the
 * emptiness — not the exit code — is the signal.
 */
export function parseWorktreeRemoteBranchPresent(output: string): boolean {
  return output.split('\n').some(line => line.trim().length > 0)
}

/**
 * The decision table. Rows in the page's own order: the two conditions of the
 * CALL first (they need no probe at all), then the unverifiable case, then the
 * three conditions of the TREE.
 */
export function worktreeReopenResetDecision(
  input: WorktreeReopenResetInput,
): WorktreeReopenResetDecision {
  const state = input.state
  // The CONTROL. Nothing at that name: the ordinary create, untouched by any of
  // this. Read before the base ref, because a `"head"` base still creates.
  if (!state?.exists) return { action: 'create', reason: 'no-existing-worktree' }

  // *"`worktree.baseRef` is `"head"`."* A `"head"` worktree is branched from
  // local HEAD by definition, so "reset to the default branch" is not a thing it
  // could mean.
  if (input.baseRef !== 'fresh') return { action: 'reopen', reason: 'base-ref-head' }

  // *"The name is a pull request or merge request reference."* Its whole point
  // is the commit it was branched from; resetting it to the default branch would
  // discard the merge request the session was opened to work on.
  if (parseForgeMergeRequestRef(input.name)) {
    return { action: 'reopen', reason: 'merge-request-name' }
  }

  // *"It has no uncommitted changes or untracked files."*
  if (state.dirty) return { action: 'reopen', reason: 'dirty' }

  // *"It is still on the branch Claude Code created for it."* A detached HEAD
  // reports an empty branch and is therefore never a match, which is the right
  // answer: we cannot know what it is sitting on.
  if (state.branch !== input.branch) return { action: 'reopen', reason: 'branch-moved' }

  // *"It has no commits of its own, or its pull request or merge request was
  // merged and its remote branch deleted."*
  //
  // Read as the page's OWN git-only test, because that is the only evidence a
  // reopen has: *"the remote branch the worktree pushed to no longer exists, and
  // every commit in the worktree is already on the default branch."* Both
  // halves, never one — see the tests, which assert each half alone does not
  // reset.
  //
  // **The residue, stated rather than implied.** The page gives condition 3 two
  // alternatives and this is the stricter of them: a worktree whose branch still
  // has a remote-tracking ref reads as `holds-commits` even when it has no
  // commits of its own. Distinguishing those two needs the commit the branch was
  // created at, and a reopen from a later session does not have it — the lease
  // that recorded it is gone, and `lease.baseSha` at that moment is the FRESH
  // default tip, not the old base. So the narrower reading is taken
  // deliberately: its cost is a reopen at the old tip, which loses nothing,
  // where the wider one would move a branch that may still be open on the forge.
  if (state.remoteBranchExists === false && state.headIsAncestorOfDefault === true) {
    return { action: 'reset', reason: 'conditions-met' }
  }

  // *"Claude Code can't verify the worktree's state."* Separated from
  // `holds-commits` deliberately: "we asked and the answer was no" and "we could
  // not ask" are the same ACTION and different facts, and only the second is
  // worth an operator's attention.
  if (state.remoteBranchExists === undefined || state.headIsAncestorOfDefault === undefined) {
    return { action: 'reopen', reason: 'unverifiable' }
  }
  return { action: 'reopen', reason: 'holds-commits' }
}

/**
 * The git that performs a `reset` decision, and nothing else runs it.
 *
 * `checkout -B <branch> <defaultSha>` in ONE command rather than a reset
 * followed by a checkout: it moves the branch we created to the fresh default
 * tip and checks it out atomically, so there is no window in which the worktree
 * is on a detached HEAD or on a branch pointing somewhere neither the old nor
 * the new state expects.
 *
 * `-B` and not `-b`: the branch exists — condition 2 above is that we are still
 * ON it — so `-b` would fail. Not `--force`: the working tree is clean, because
 * condition 1 is that it has no uncommitted changes or untracked files, and if
 * that ever stopped being true git's own refusal is the check we want rather
 * than a flag that overrides it.
 *
 * `defaultSha` is the caller's already-resolved base for a `"fresh"` worktree —
 * `worktreeBaseShaCandidates`' answer, `origin/HEAD` with the documented
 * freshness prelude in front of it — so the reset lands on exactly the commit a
 * brand-new worktree of the same name would have been created at.
 */
export function worktreeReopenResetCommands(
  worktreePath: string,
  branch: string,
  defaultSha: string,
): WorktreeGitCommand[] {
  return [{
    operation: 'reopen-reset',
    cwd: 'worktree',
    args: ['-C', worktreePath, 'checkout', '-B', branch, defaultSha],
  }]
}

/**
 * Ownership probe for `extensions.worktreeConfig` — large-codebases.md:245:
 * sparse checkout makes git enable the entry in the repository's shared
 * `.git/config`, it must be removed after the last worktree is removed, "but
 * only if Claude Code added it. It never removes a value you set yourself."
 * Run BEFORE the first sparse-set, while the pre-existing value is still
 * observable. `--local` so a value in the user's global config is never read
 * as ours; `allowFailure` because `config --get` of an absent key exits 1,
 * which IS the "we may claim ownership" answer.
 */
export function worktreeConfigProbeCommand(repoRoot: string): WorktreeGitCommand {
  return {
    operation: 'worktree-config-probe',
    cwd: 'repo',
    args: ['-C', repoRoot, 'config', '--local', '--get', 'extensions.worktreeConfig'],
    allowFailure: true,
  }
}

/**
 * Post-removal cleanup pair (large-codebases.md:245): count the remaining
 * worktrees (`--porcelain` prints one `worktree ` line per checkout — exactly
 * 1 means the main checkout only), then unset the entry we added. `--local`
 * so a user's global value is never unset; `allowFailure` on the unset is
 * load-bearing — `config --unset` of an absent key exits 5, and the caller's
 * runner throws on any non-zero without it.
 */
export function worktreeConfigCleanupCommands(repoRoot: string): WorktreeGitCommand[] {
  return [
    {
      operation: 'worktree-list',
      cwd: 'repo',
      args: ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
    },
    {
      operation: 'worktree-config-unset',
      cwd: 'repo',
      args: ['-C', repoRoot, 'config', '--local', '--unset', 'extensions.worktreeConfig'],
      allowFailure: true,
    },
  ]
}

export interface WorktreeSymlink {
  /** Absolute path in the main checkout that the link points at. */
  target: string
  /** Absolute path inside the worktree where the link is created. */
  link: string
}

/**
 * The symlinks `worktree.symlinkDirectories` asks for.
 *
 * Every entry is repository-relative and already refused `..` and absolute
 * forms at parse time; joining is done with the resolved roots so a link can
 * only ever land inside the worktree and only ever point inside the repository.
 */
export function worktreeSymlinkPlan(input: {
  repoRoot: string
  worktreePath: string
  settings: Pick<ResolvedWorktreeSettings, 'symlinkDirectories'>
}): WorktreeSymlink[] {
  return input.settings.symlinkDirectories.map(entry => {
    const relative = entry.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
    return {
      target: `${input.repoRoot}/${relative}`,
      link: `${input.worktreePath}/${relative}`,
    }
  })
}
