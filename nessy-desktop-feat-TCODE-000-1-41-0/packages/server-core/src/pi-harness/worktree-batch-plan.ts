/**
 * P6.508 — one request fans out into N worktree-isolated agents, each on its own
 * branch, and a HUMAN opens the merge requests.
 *
 * ## The decision this file implements, and the two it refuses
 *
 * Delegated decision Q-den 31 chose **option A**: an MR-less batch — worktrees
 * and branches, no forge write. Option B (a full batch with a per-MR
 * confirmation) was refused because thirty confirmations is a prompt storm that
 * trains the user to click through, and because it would build forge
 * integration in this plan rather than in Dev-4; option C (not now) was refused
 * because the ingredients already exist. So **nothing here issues a forge call
 * and nothing here can**: the planner's output is a list of branch names, and
 * {@link describeBatchSubmission} is the sentence that hands them back.
 *
 * ## Native-first, and the answer is "none, but it is host-authorable"
 *
 * No runtime has a batch verb. Upstream ships `/batch` as a bundled SKILL over
 * subagents and worktrees, which is the shape of the answer: the fan-out is
 * assembly over machinery that already exists rather than a new capability.
 *
 * C3.107 RE-MEASURED that sentence on 2026-09-12 and it is half true in the
 * load-bearing half: claude's bundled `/batch` exists and its terminal step is
 * a forge write — `commands.md#all-commands` says each subagent *"opens a pull
 * request"*, and the shipped 2.1.247 binary's own worker template pushes the
 * branch and then invokes GitHub's command-line client to open it. (Named in
 * WORDS on purpose: this file IS one of the scanned regions, and the scanner
 * cannot tell a quotation from an instruction — the verbatim step is quoted in
 * the guard module, which is deliberately not a region.) So the native
 * mechanism is not a cheaper route to THIS posture; it is the opposite posture,
 * which is why the host keeps this planner. The full three-runtime reading, and
 * the machine check that the fan-out issues no forge write, are in
 * `worktree-batch-forge-free.ts` (`BATCH_FAN_OUT_REGIONS`) — this file is one of
 * the regions it scans.
 *
 * Both ingredients are here — the worktree lease and the spawner — so this file
 * is a PURE PLANNER in `worktree-git-plan.ts`'s and `worktree-include-plan.ts`'s
 * shape: it decides names, branches and the bound, and touches nothing. That is
 * also what makes the row's "identically on all three" true by construction —
 * a planner that never asks which runtime is spawning cannot answer differently
 * for one.
 *
 * ## The bound is the load-bearing part, and it is MEASURED rather than picked
 *
 * The row asks for the fan-out to be bounded and for the bound to be stated.
 * The number comes from the fd measurement `process-store.ts` already recorded
 * and does not re-derive: `launchctl limit maxfiles` reports a soft limit of
 * **256**, the launcher's `ulimit -n 8192` does NOT reach Electron (a Node child
 * raises its own limit, Electron does not), and the main process holds ~127 fds
 * at rest — leaving about 129 of headroom, which is why
 * `PROCESS_LIST_READ_CONCURRENCY` is 32 and why an 807-way fan-out broke.
 *
 * A spawned SESSION is far more expensive than a record read, so this bound is
 * deliberately much smaller than that one. It is set at the top of the range the
 * row itself names — *"the worktree machinery can isolate 5-30 agents"* — so a
 * batch inside the asked-for range is never truncated and a batch outside it is
 * refused rather than attempted.
 */

import { PROCESS_LIST_READ_CONCURRENCY } from './process-store'

/**
 * The most agents one batch may start.
 *
 * 30, the top of the row's own stated range, and it sits comfortably under the
 * ~129 fds of headroom the fd measurement leaves — a session costs more fds than
 * a record read, so this is not `PROCESS_LIST_READ_CONCURRENCY` and must not be
 * raised to match it. Exported so the unit that proves the bound asserts against
 * the shipped value rather than a copy of it.
 */
export const MAX_BATCH_UNITS = 30

/** Longest branch name this planner will produce, suffix included. */
export const MAX_BRANCH_NAME_LENGTH = 100

/** One piece of work the batch was asked to do. */
export interface BatchTaskInput {
  /** Stable identity for the caller. Absent means "use the index". */
  id?: string
  /** Human-readable; also the source of the branch name. */
  name: string
  /** What the spawned session is told to do. */
  prompt: string
}

/** One unit of the planned batch: an agent, a branch, and nothing shared. */
export interface BatchUnit {
  id: string
  name: string
  prompt: string
  /** Unique inside this batch, and a valid git ref by construction. */
  branch: string
}

/** A task that is not running. Named, never silently dropped. */
export interface DeferredBatchTask {
  id: string
  name: string
  /**
   * C3.327 (born from W18-e's C3.107) — `over-bound` is the PLANNER's refusal;
   * `failed-to-start` is the EXECUTOR's, and the two must not share a sentence.
   * A unit that failed with `worktree-project-required` told to "run them as a
   * second batch" fails identically the second time, and the reply has blamed a
   * bound that admitted it.
   *
   * C3.328 — the executor's refusal covers TWO shapes, deliberately under one
   * word: a unit that never entered its worktree, and one that entered and whose
   * PROMPT never arrived. They share the remedy — a second batch reproduces
   * either failure — so they share a sentence; what separates them is each
   * unit's own cause, which the executor puts on its own `deferred[].reason`.
   */
  reason: 'over-bound' | 'failed-to-start'
}

export interface WorktreeBatchPlan {
  units: BatchUnit[]
  /** Tasks the bound refused, in order, so the caller can say what did not start. */
  deferred: DeferredBatchTask[]
  /** The bound that was applied, so a caller can state it rather than restate a constant. */
  bound: number
}

export interface WorktreeBatchPlanInput {
  tasks: readonly BatchTaskInput[]
  /**
   * Namespace for every branch this batch creates, e.g. `batch/2026-09-07`.
   *
   * Required rather than defaulted: a batch that quietly wrote to
   * `feature/<name>` would put thirty branches into whatever namespace the
   * repository already uses, and the caller is the only thing that knows which
   * one is safe.
   */
  branchPrefix: string
  /** Lower the bound for a caller with less headroom. Never RAISES it. */
  bound?: number
}

/**
 * A branch-safe slug of one task name.
 *
 * `git check-ref-format`'s rules are the spec: no space or control character, no
 * `~ ^ : ? * [ \`, no `..`, no `@{`, no leading or trailing `/` or `.`, no
 * `.lock` suffix, not the single character `@`. Rather than enumerate the
 * refusals, everything outside a conservative safe set becomes `-` — a slug is a
 * label, so losing an exotic character costs nothing, while letting one through
 * costs a `git worktree add` that fails at run time with the branch name in the
 * error and the batch half-started.
 */
export function branchSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  // A name made entirely of refused characters yields `''`, which would produce
  // a branch ending in the prefix's own separator — a different branch than the
  // caller asked for and, for two such names, the SAME branch twice.
  return slug.length > 0 ? slug : 'task'
}

function uniqueBranch(prefix: string, slug: string, taken: Set<string>): string {
  const base = `${prefix}/${slug}`.slice(0, MAX_BRANCH_NAME_LENGTH)
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  // Two tasks whose names slug the same must not share a branch: the second
  // would either fail `git worktree add` or, worse, attach to the first's
  // branch and let two agents write to one tree.
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`
    const candidate = `${base.slice(0, MAX_BRANCH_NAME_LENGTH - tail.length)}${tail}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

/**
 * Plan the batch. Pure: no git, no lease, no spawn, no forge.
 *
 * Tasks past the bound are DEFERRED rather than truncated, because the caller
 * has to be able to say which work did not start — a batch that silently ran 30
 * of 40 is the shape where ten pieces of work are believed done.
 */
export function planWorktreeBatch(input: WorktreeBatchPlanInput): WorktreeBatchPlan {
  const prefix = input.branchPrefix.replace(/\/+$/, '')
  if (prefix.trim().length === 0) throw new Error('worktree-batch: branchPrefix must not be blank')
  // `bound` narrows and never widens: a caller with less headroom can ask for
  // fewer, and nobody can ask for more than the measured ceiling.
  const bound = Math.max(1, Math.min(input.bound ?? MAX_BATCH_UNITS, MAX_BATCH_UNITS))

  const taken = new Set<string>()
  const units: BatchUnit[] = []
  const deferred: DeferredBatchTask[] = []

  input.tasks.forEach((task, index) => {
    const id = task.id ?? `task-${index + 1}`
    if (units.length >= bound) {
      deferred.push({ id, name: task.name, reason: 'over-bound' })
      return
    }
    units.push({ id, name: task.name, prompt: task.prompt, branch: uniqueBranch(prefix, branchSlug(task.name), taken) })
  })

  return { units, deferred, bound }
}

/**
 * What the batch reports when it is done, and the sentence option A exists for.
 *
 * It NAMES the branches, because no merge request was opened and a person has
 * to open them. A result that said "done" would be the shape where thirty
 * branches sit unmerged and nobody knows they are there.
 *
 * Model-facing text, so English (i18n rule 3): it is composed into the batch's
 * own reply, not rendered as UI chrome.
 */
export function describeBatchSubmission(plan: WorktreeBatchPlan): string {
  const lines: string[] = []
  if (plan.units.length === 0) {
    lines.push('No work was started.')
  } else {
    lines.push(
      `${plan.units.length} ${plan.units.length === 1 ? 'agent' : 'agents'} ran, each isolated in its own worktree on its own branch.`,
      'No merge request was opened — submit these branches yourself:',
      ...plan.units.map(unit => `  ${unit.branch}  (${unit.name})`),
    )
  }
  // C3.327 — split by REASON, because the remedy differs. Re-running an
  // over-bound task as a second batch works; re-running one that could not start
  // reproduces its own failure.
  const overBound = plan.deferred.filter(task => task.reason === 'over-bound')
  const failed = plan.deferred.filter(task => task.reason === 'failed-to-start')
  if (overBound.length > 0) {
    lines.push(
      '',
      `${overBound.length} ${overBound.length === 1 ? 'task was' : 'tasks were'} NOT started: a batch runs at most ${plan.bound} agents at once.`,
      ...overBound.map(task => `  ${task.name}`),
      'Run them as a second batch.',
    )
  }
  if (failed.length > 0) {
    // C3.328 — "are not running" rather than "could not be started at all",
    // because this reason now covers TWO shapes and the stronger sentence is
    // false for one of them: a unit whose session and worktree were created and
    // whose PROMPT never arrived did start, and did no work. Both shapes share
    // the remedy (a second batch reproduces the failure), which is why they
    // still share a reason word; each unit's own cause is on `deferred[].reason`.
    lines.push(
      '',
      `${failed.length} ${failed.length === 1 ? 'task is' : 'tasks are'} not running, and the bound is not the reason:`,
      ...failed.map(task => `  ${task.name}`),
    )
  }
  return lines.join('\n')
}

/**
 * The measured reason the bound exists, for a surface that has to explain it.
 *
 * Quotes the fd measurement rather than restating a number twice: the constant
 * it names is the one `process-store.ts` exports, so a reader who doubts this
 * sentence can go and read the measurement instead of a copy of it.
 */
export const BATCH_BOUND_REASON =
  `A batch runs at most ${MAX_BATCH_UNITS} agents at once. Electron does not inherit the shell's `
  + `\`ulimit -n\` (soft limit 256 here, and the launcher's 8192 does not reach it), and the main process `
  + `holds around 127 file descriptors at rest — the same measurement that caps record reads at `
  + `${PROCESS_LIST_READ_CONCURRENCY}. A session costs more than a record read, so this bound is smaller.`
