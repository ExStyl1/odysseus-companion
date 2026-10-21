import { hostname } from 'node:os'

import { describeWorktreeIdentityRefusal, resolveHookWorktreePath, screenWorktreeIdentity } from '@nessy-agent/shared/automations'
import {
  planWorktreeOrphanSweep,
  type WorktreeOrphanSkipReason,
} from '@nessy-agent/shared/sessions/worktree-orphans'
import {
  createWorktreeSetupConsentStore,
  describeWorktreeSetupConsent,
  worktreeSetupConsentName,
  worktreeSetupConsentProjectKey,
} from '@nessy-agent/shared/sessions/worktree-setup-consent'
import type { PiWorktreeLeaseStateV1 as WorktreeLeaseStateV1, PiWorktreeLeaseV1 as WorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import type { ForgeMergeRequestRef } from './worktree-git-plan'

import {
  describeWorktreeSetupOutcome,
  worktreeSetupCommand,
  type WorktreeSetupCommand,
} from './worktree-setup-plan.ts'

/**
 * R9: `WorktreeCreate` is the path-return pattern — the hook may replace the
 * path the worktree is created at, which is only possible while the path is
 * still a proposal. The emit therefore runs BEFORE `git.create` and its return
 * value is consulted; `WorktreeRemove` stays a pure notification.
 *
 * hooks.md:699 — "The exception is `WorktreeCreate`, where any non-zero exit
 * code aborts worktree creation." `blocked` is how an emit implementation
 * expresses that abort: the automation result's `decision: 'block'` (any
 * non-zero exit under the per-event contract) maps to `blocked: true` with the
 * hook's reason, and the service refuses to create. A hook that returns no
 * path and exits 0 is NOT a refusal — that emit returns neither field.
 */
export interface WorktreeLeaseEmitResult {
  worktreePath?: string
  blocked?: boolean
  blockReason?: string
}

export type WorktreeLeaseEmit = (
  event: 'WorktreeCreate' | 'WorktreeRemove',
  lease: WorktreeLeaseV1,
) => Promise<WorktreeLeaseEmitResult | void> | WorktreeLeaseEmitResult | void

/** What the consent card is asked, in the `workflow_launch` prompt's shape. */
export interface WorktreeSetupConsentRequest {
  /** The card's text — `describeWorktreeSetupConsent`. */
  description: string
  /** The thing being run, i.e. the prompt's `command` field. */
  command: string
  /** The `<path>` half of "don't ask again for this script in `<path>`". */
  projectKey: string
  /** The record's name half: a digest of the exact script. */
  consentName: string
  worktreePath: string
}

export interface WorktreeSetupConsentAnswer {
  granted: boolean
  /** "Yes, and don't ask again for this script in this project." */
  remember?: boolean
}

/**
 * The host half of `worktree.setupScript`: the four capabilities running a
 * setup script needs and this service does not have — the settings tier, a
 * consent card, a supervised child process, and the session transcript.
 *
 * It is a port rather than inline code for the same reason `git` is: the
 * service owns WHEN the script runs, in what order, and what a refusal means;
 * the host owns the process and the UI. That split is also what lets every one
 * of these rules be tested without a repository or a session.
 *
 * Absent means the feature is off for this service — no settings read, no card,
 * no process, and a creation byte-identical to one from before the key existed.
 */
export interface WorktreeSetupPort {
  /**
   * The resolved workspace-tier `worktree.setupScript`, or `undefined`.
   *
   * Read once per creation, never captured: a settings edit must reach the NEXT
   * worktree, which is the same rule the caller's other worktree settings read
   * under.
   */
  script(): string | undefined | Promise<string | undefined>
  /**
   * Show the card. Only called when nothing is remembered for this script.
   *
   * `remember: true` is the "and don't ask again" answer, and this service
   * writes the record for it. A host that would rather write the record on its
   * own Always path (the shape `workflow_launch` uses, where
   * `respondToPermission` does the remembering) simply never returns
   * `remember: true` — but it MUST write through
   * `createWorktreeSetupConsentStore()` and `worktreeSetupConsentName()`, or
   * the approval lands in a file this service does not read, under a name it
   * does not compute, and silently never takes effect.
   */
  consent(request: WorktreeSetupConsentRequest): Promise<WorktreeSetupConsentAnswer>
  /** Run it as a supervised child. A non-zero exit is reported, never thrown. */
  run(command: WorktreeSetupCommand): Promise<{ output: string; exitCode: number | null }>
  /** Put one block into the session transcript. */
  report(text: string): void | Promise<void>
  /** Where the remember record lives; tests point it at a temp file. */
  consentStorePath?: string
}

/**
 * P3.312 — WHO HOLDS A `git worktree lock` THIS SERVICE TOOK.
 *
 * `worktrees.md#clean-up-subagent-and-background-session-worktrees`, verbatim:
 * *"While an agent is running, Claude Code holds a `git worktree lock` on its
 * worktree so that concurrent cleanup can't remove it, and releases the lock
 * when the agent finishes"*, *"The sweep also releases a lock Claude Code set
 * for a session whose process has exited, so a killed background session
 * doesn't leave its worktree permanently locked"*, and *"The sweep never
 * releases a lock you set yourself with `git worktree lock`"*.
 *
 * A lock is the one interlock this service could not build for itself: it lives
 * in the repository's git metadata, `git worktree remove` refuses a locked
 * worktree (measured: exit 128, and `--force` refuses too — `-f -f` overrides),
 * and every process sharing the checkout sees it. A lease ledger inside one
 * session file cannot be any of that.
 *
 * The three rules above need TWO facts out of a lock, and neither is in git's
 * data model, so both go into the reason string: that WE set it, and WHICH
 * process did. Hence a parseable reason rather than a free-text one.
 */
export interface WorktreeLockOwner {
  readonly pid: number
  /** `os.hostname()` at the time of locking. A pid from another machine means nothing. */
  readonly host: string
}

/**
 * The prefix that makes a lock ours. A reason without it is *"a lock you set
 * yourself"* and is never released here — which is also why the prefix is a
 * fixed string and not a setting: the rule has to hold across versions of this
 * app locking the same checkout.
 */
const WORKTREE_LOCK_REASON_PREFIX = 'nessy-agent worktree'

/** One line, `pid` before `host` so the host may be the unbounded tail. */
export function worktreeLockReason(input: { owner: WorktreeLockOwner; worktreeLeaseId: string }): string {
  return `${WORKTREE_LOCK_REASON_PREFIX} lease=${input.worktreeLeaseId} pid=${input.owner.pid} host=${input.owner.host}`
}

/**
 * The owner a lock reason names, or `undefined` for a lock that is not ours.
 *
 * Deliberately strict in the SAFE direction: anything unparseable reads as a
 * foreign lock, and a foreign lock is kept rather than released. Only the FIRST
 * line is read — git stores the reason verbatim, so a foreign reason may carry
 * newlines, and `git worktree list --porcelain` would already have split it.
 */
export function parseWorktreeLockReason(reason: string | undefined): WorktreeLockOwner | undefined {
  const line = reason?.split('\n', 1)[0]?.trim()
  if (line === undefined || !line.startsWith(`${WORKTREE_LOCK_REASON_PREFIX} `)) return undefined
  const pid = /(?:^| )pid=(\d+)(?= |$)/.exec(line)?.[1]
  const host = / host=(.+)$/.exec(line)?.[1]?.trim()
  if (pid === undefined || host === undefined || host.length === 0) return undefined
  const value = Number.parseInt(pid, 10)
  if (!Number.isSafeInteger(value) || value <= 0) return undefined
  return { pid: value, host }
}

export function currentWorktreeLockOwner(): WorktreeLockOwner {
  return { pid: process.pid, host: hostname() }
}

/**
 * Whether the process a lock names is still running — the *"a session whose
 * process has exited"* test.
 *
 * EVERY uncertainty answers `true`, because `false` is the destructive answer:
 * it releases the lock, and the very next thing the sweep does is remove the
 * worktree. So a pid on another host (unknowable from here), a pid that will
 * not parse, and `EPERM` (the process exists and belongs to someone else) all
 * read as alive. A recycled pid also reads as alive, which keeps a worktree
 * that could have been reclaimed — a leak, not a loss.
 */
export function worktreeLockOwnerIsAlive(owner: WorktreeLockOwner): boolean {
  if (owner.host !== hostname()) return true
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return true
  try {
    // Signal 0 is the existence probe and delivers nothing. The pid guard above
    // is load-bearing: 0 and negatives address process GROUPS.
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string } | null)?.code === 'EPERM'
  }
}

/** One `worktree` block of `git worktree list --porcelain`, lock fields only. */
export interface WorktreeListLock {
  readonly path: string
  readonly locked: boolean
  /** Absent for `locked` with no reason — i.e. a hand-set `git worktree lock`. */
  readonly lockReason?: string
}

/**
 * Read every worktree's lock state out of `git worktree list --porcelain`.
 *
 * The repository is the right place to ask, not the worktree: a worktree whose
 * DIRECTORY has vanished is still listed with its lock, and that lock is what
 * keeps `git worktree prune` from clearing the admin directory (measured — a
 * locked stale entry survives `prune -v`, and prune removes it the moment it is
 * unlocked).
 *
 * Pure, and it does NOT resolve paths: git prints resolved absolute paths
 * (`/tmp/x` comes back as `/private/tmp/x` on macOS), so the caller matches
 * with `realpath` on both sides. Putting that in here would mean an fs call
 * inside a parser, and getting it wrong silently reads every worktree as
 * unlocked — the direction that removes a live one.
 */
export function parseWorktreeListLocks(porcelain: string): WorktreeListLock[] {
  const entries: WorktreeListLock[] = []
  let path: string | undefined
  let locked = false
  let lockReason: string | undefined
  const flush = () => {
    if (path === undefined) return
    entries.push({ path, locked, ...(lockReason === undefined ? {} : { lockReason }) })
    path = undefined
    locked = false
    lockReason = undefined
  }
  for (const raw of porcelain.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length).trim()
      continue
    }
    if (line === 'locked') { locked = true; continue }
    if (line.startsWith('locked ')) {
      locked = true
      lockReason = line.slice('locked '.length)
      continue
    }
  }
  flush()
  return entries
}

export interface WorktreeResidual {
  resourceType: 'worktree'
  resourceId: string
  code:
    | 'worktree-create-interrupted'
    | 'worktree-dirty'
    /**
     * P6.22 — HEAD has moved past the lease's base, so the worktree holds
     * commits that exist nowhere else (these `nessy/…` branches are never
     * pushed). Only an explicit `refuseIfHoldsWork` release reports it: the
     * age sweep skips the same condition earlier with `reason: 'holds-commits'`
     * and never reaches `releaseUnlocked`, and an unqualified release still
     * removes, because a caller naming one worktree has said which one.
     */
    | 'worktree-holds-commits'
    | 'worktree-missing'
    | 'worktree-provenance-mismatch'
    | 'worktree-remove-failed'
}

/** Why a candidate was left alone. The age reasons come from the shared planner. */
export type WorktreeSweepSkipReason =
  | WorktreeOrphanSkipReason
  /** Changed or untracked files. */
  | 'dirty'
  /** HEAD moved past the lease's base: commits nobody has pushed. */
  | 'holds-commits'
  /**
   * P3.312 — git's own `worktree lock`, set by THIS app for a process that is
   * still running. The cross-process half of `live-lease`: another window, a
   * headless server or a CDP rig holds it, and this ledger cannot see their
   * live-lease list.
   */
  | 'locked'
  /**
   * P3.312 — locked, and not by us. *"The sweep never releases a lock you set
   * yourself with `git worktree lock`"*, so it is kept whatever its age; a lock
   * whose reason will not parse counts as somebody else's.
   */
  | 'locked-elsewhere'
  /** Inspection or removal failed; the lease stays for the next pass. */
  | 'remove-failed'
  /**
   * P6.136 — a FOREIGN lease (another session's) whose directory has already
   * vanished, so there is nothing to remove and the record is not ours to
   * reclaim. Reported rather than dropped silently: the owning session collects
   * it on its own next sweep, before `recover()` can throw on it, and until then
   * this is the only place the state is visible.
   */
  | 'foreign-record'
  /**
   * P6.336 (b) — the lease is marked PERMANENT. It is exempt by NAME rather
   * than by inference: before this, the only thing that kept a worktree was
   * being young, live, locked or dirty, so a worktree meant to outlive every
   * chat that used it survived by accident and stopped surviving the moment it
   * went quiet.
   */
  | 'permanent'
  /**
   * P6.336 (a) — the operator's off switch (`worktree.autoRemove: false`).
   * Reported per candidate rather than by returning early, so an operator who
   * turned automatic deletion off can still see exactly what WOULD have gone.
   */
  | 'auto-remove-off'
  /**
   * P6.336 (a) — inside the operator's retention COUNT
   * (`worktree.retainCount`), newest first. The age cutoff answers "how old is
   * too old"; nothing answered "how many is too many", and a project that makes
   * a worktree per scheduled run accumulates them inside the cutoff window.
   */
  | 'retained'

/**
 * P6.135 — the work a removal would delete, read without attempting one.
 *
 * The two fields the page names ("changed or untracked files, and new commits")
 * plus `exists`, because a vanished directory is neither and there is nothing to
 * ask a person about.
 */
export interface WorktreeWorkSummary {
  readonly worktreeLeaseId: string
  readonly path: string
  readonly branch: string
  readonly exists: boolean
  readonly dirty: boolean
  readonly holdsCommits: boolean
}

/**
 * P6.547 — whether the branch this worktree sits on was minted BY US for it.
 *
 * `worktrees.md#clean-up-worktrees` describes a removal that deletes "the
 * worktree directory and its branch"; ours ran `git worktree remove` and left
 * the branch, so branches accumulated one per worktree ever created. The
 * documented shape is adopted NARROWLY, and this flag is the narrowing: a branch
 * that already existed when the worktree was made is the USER's, and no cleanup
 * of ours deletes it.
 *
 * Reported by `create` rather than derived from the branch NAME later: a name
 * under our own namespace is a strong hint and not a fact, and the one moment
 * the answer is certain is the `show-ref` the creation already runs.
 */
export interface WorktreeCreateOutcome {
  readonly branchCreated?: boolean
}

/**
 * P6.547 — what happened to the branch when the worktree went away.
 *
 * `branchDeleted: false` with a `branchKeptReason` is the ordinary, safe
 * outcome: `git branch -d` refuses a branch holding commits its base does not,
 * and that refusal IS the safety check — never `-D`. A caller that shows the
 * user a removal notice reads this so the notice says what actually happened
 * instead of what the page says.
 */
export interface WorktreeReleaseOutcome {
  readonly branchDeleted: boolean
  readonly branchKeptReason?: string
}

export interface WorktreeSweepResult {
  readonly dryRun: boolean
  /**
   * Reclaimed — or, in a dry run, exactly what a real run would reclaim.
   *
   * "Reclaimed" rather than "removed" because one entry needs no removal: a
   * candidate whose directory has already vanished is reported here, having
   * given up only its lease record. See {@link WorktreeLeaseService.sweepOrphans}.
   */
  readonly removed: { worktreeLeaseId: string; path: string; lastUsedAt: string }[]
  /**
   * `branch` is here because P6.22 reads it: a worktree the sweep KEEPS because
   * it still holds work is announced to the session, and the branch is the only
   * handle the user has on that work — the directory is inside a namespace they
   * did not choose, while `git checkout <branch>` reaches it from the main
   * checkout. It is added in the same change that reads it, deliberately: an
   * unread field is the defect this wave keeps finding.
   */
  readonly skipped: { worktreeLeaseId: string; path: string; branch: string; reason: WorktreeSweepSkipReason }[]
}

export interface WorktreeSweepInput {
  /** Epoch ms; a lease last used strictly before this is a candidate. */
  readonly cutoffMs: number
  /**
   * Leases a session currently holds. Required, not defaulted: an omitted list
   * would read as "nothing is live" and delete a worktree out from under a
   * running session.
   */
  readonly liveLeaseIds: readonly string[]
  /**
   * P6.136 — leases held by OTHER sessions, offered as extra candidates.
   *
   * The sweep planned over `this.state.leases` alone, which is one session's
   * ledger — and a scheduled task makes a new session per run, so run #1's
   * worktree was unreachable from run #2 and leaked. Every arm below is
   * unchanged and applies to these identically: the age cutoff, the live-lease
   * set, git's own lock, and the dirty / holds-commits refusals.
   *
   * CONTAINMENT IS THE CALLER'S, and it is not optional: this service has no way
   * to tell whether a path it was handed belongs to its own project. The caller
   * filters to its namespace root before offering anything here.
   *
   * A removal of a foreign lease touches the directory and the branch and NOT
   * this service's ledger — the owning session's record stays until that session
   * next sweeps, where the vanished-directory reclaim (P6.21) collects it before
   * `recover()` can throw on it.
   */
  readonly foreignLeases?: readonly WorktreeLeaseV1[]
  readonly dryRun?: boolean
  /**
   * P6.336 (a) — the operator's policy, resolved by the caller from
   * `worktree.retainCount` and `worktree.autoRemove`.
   *
   * Both OPTIONAL and both absent by default, so a caller that passes neither
   * sweeps exactly as it always did. `autoRemove: false` removes nothing;
   * `retainCount` keeps that many candidates, most recently used first, on top
   * of every refusal below.
   */
  readonly retainCount?: number
  readonly autoRemove?: boolean
}

export class WorktreeLeaseError extends Error {
  constructor(message: string, readonly residuals: WorktreeResidual[]) {
    super(message)
  }
}

export class WorktreeLeaseService {
  private state: WorktreeLeaseStateV1
  private mutationTail: Promise<void> = Promise.resolve()
  private emit?: WorktreeLeaseEmit
  private setupConsent?: ReturnType<typeof createWorktreeSetupConsentStore>

  constructor(private readonly options: {
    workspaceId: string
    initialState?: WorktreeLeaseStateV1
    persist(state: WorktreeLeaseStateV1): Promise<void>
    policy: { select(input: { worktreeLeaseId: string; ownerAgentId: string; branch?: string; mergeRequestRef?: ForgeMergeRequestRef }): Promise<{ path: string; branch: string; baseSha: string }> }
    git: {
      /**
       * `context.hookReplacedPath` rides the CALL, never the lease:
       * worktrees.md:231 — when a `WorktreeCreate` hook replaced the path,
       * `.worktreeinclude` is not processed. `WorktreeLeaseV1` is persisted
       * state (schemaVersion 1), so the flag must not become a field on it.
       */
      create(lease: WorktreeLeaseV1, context: { hookReplacedPath: boolean }): Promise<void | WorktreeCreateOutcome>
      inspect(lease: WorktreeLeaseV1): Promise<{ exists: boolean; dirty: boolean; branch: string; baseSha: string; baseShaIsAncestor?: boolean }>
      remove(lease: WorktreeLeaseV1): Promise<void | WorktreeReleaseOutcome>
      /**
       * P6.324 (a) — `git -C <path> rev-parse --show-toplevel` for a path that
       * ALREADY EXISTS, so the identity screen can refuse a directory that is
       * really the main checkout (or a redirect into it) before anything is
       * created in it. `null` when git answered nothing.
       *
       * OPTIONAL, like the three lock methods: a host that cannot answer gets
       * exactly today's behaviour rather than a refusal it cannot act on.
       */
      identifyToplevel?(path: string): Promise<string | null>
      /**
       * P3.312 — git's own lock, the cross-process interlock. THREE optional
       * methods, and the service uses them only when ALL THREE are supplied:
       * a host that can read a lock but not release one would leave a killed
       * session's worktree locked forever, which is the failure
       * `worktrees.md` names ("Before v2.1.210, a lock left by a killed
       * session stayed in place until you ran `git worktree unlock`").
       *
       * Absent = the interlock is unavailable and every path below is
       * byte-identical to before this row: the in-process `liveLeaseIds` list
       * stays the only protection, which is the state P3.288 recorded.
       *
       * Read from the REPOSITORY, not the worktree: a worktree whose directory
       * has vanished is still listed with its lock. See
       * {@link parseWorktreeListLocks}, and note that git prints RESOLVED
       * paths — match with `realpath` on both sides.
       */
      lockState?(lease: WorktreeLeaseV1): Promise<{ locked: boolean; reason?: string }>
      /** `git worktree lock --reason <reason>`. Already-locked is a failure git reports. */
      lock?(lease: WorktreeLeaseV1, reason: string): Promise<void>
      /** `git worktree unlock`. Only ever called for a lock this app set. */
      unlock?(lease: WorktreeLeaseV1): Promise<void>
    }
    makeId?: () => string
    now?: () => string
    emit?: WorktreeLeaseEmit
    /** Repository root the returned worktree path must stay inside. */
    repoRoot?: () => Promise<string> | string
    /** `worktree.setupScript`'s host half. Absent = the key does nothing here. */
    setup?: WorktreeSetupPort
    /**
     * P3.312 — the identity written into a lock reason, and the liveness test
     * read back out of one. Injected so the whole interlock is assertable
     * without spawning a second process; production takes the defaults.
     */
    lockOwner?: () => WorktreeLockOwner
    lockOwnerAlive?: (owner: WorktreeLockOwner) => boolean
  }) {
    this.state = structuredClone(options.initialState ?? { schemaVersion: 1, revision: 0, leases: [] })
    this.emit = options.emit
  }

  setEmit(emit: NonNullable<typeof this.emit>): void { this.emit = emit }

  list(): WorktreeLeaseV1[] {
    return structuredClone(this.state.leases)
  }

  /**
   * P6.135 — what a removal of this lease's worktree would delete, as a READ.
   *
   * `worktrees.md#clean-up-worktrees`: *"When you exit an interactive worktree
   * session, Claude checks the worktree for work that removal would delete:
   * changed or untracked files, and new commits."* The check itself already
   * shipped — `releaseUnlocked` refuses on `dirty`, and on a moved base under
   * `refuseIfHoldsWork` — but it was only ever reachable by ATTEMPTING a
   * removal, which is no way to word a question. This asks the same two
   * questions of the same `git.inspect` call without touching anything.
   *
   * `undefined` for a lease this service does not hold: a caller asking about
   * somebody else's lease gets a null answer rather than a guess. Serialised
   * like every other entry point, so it cannot read a ledger mid-mutation.
   */
  async describeWork(worktreeLeaseId: string): Promise<WorktreeWorkSummary | undefined> {
    return this.serialize(async () => {
      const lease = this.state.leases.find(value => value.worktreeLeaseId === worktreeLeaseId)
      if (!lease) return undefined
      const actual = await this.options.git.inspect(structuredClone(lease))
      return {
        worktreeLeaseId: lease.worktreeLeaseId,
        path: lease.path,
        branch: lease.branch,
        exists: actual.exists,
        dirty: actual.exists && actual.dirty,
        // The same comparison `sweepOrphansUnlocked` and `releaseUnlocked`'s
        // `refuseIfHoldsWork` arm make, so the wording and the refusal cannot
        // disagree about what "holds commits" means.
        holdsCommits: actual.exists && actual.baseSha !== lease.baseSha,
      }
    })
  }

  /**
   * Stamp `lastUsedAt` on one lease.
   *
   * The seam R12's age-based orphan sweep reads. It is here rather than inside
   * `acquire` alone because "last used" has to mean the last time a SESSION was
   * in the worktree, not the moment it was created — a worktree entered daily
   * for a week is not a two-week-old orphan. `EnterWorktree`/`ExitWorktree` call
   * it; nothing in this plan consumes it.
   */
  async touch(worktreeLeaseId: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.state.leases.some(lease => lease.worktreeLeaseId === worktreeLeaseId)) return
      await this.commit(this.state.leases.map(lease => lease.worktreeLeaseId === worktreeLeaseId
        ? { ...lease, lastUsedAt: this.timestamp() }
        : lease))
    })
  }

  /**
   * Remove orphaned worktrees on the retention cutoff — R12's half of the R2/R12
   * boundary, and the ONLY worktree GC.
   *
   * Layered so each refusal is a named reason rather than a swallowed exception:
   * the shared planner applies the age rules (live lease, unknown `lastUsedAt`,
   * too recent), this method applies the git rules ("skips a worktree that still
   * holds work: changed or untracked files, or unpushed commits"), and the
   * removal itself goes through `releaseUnlocked` so the dirty refusal, the
   * provenance assertion and the `WorktreeRemove` emit are the same ones a
   * manual release uses.
   *
   * "Unpushed commits" needs no extra git call: `inspect` returns the worktree's
   * CURRENT head as `baseSha`, and these branches (`nessy/<agent>/<leaseId>`)
   * are never pushed, so any drift from the lease's recorded base is work that
   * exists nowhere else.
   *
   * One candidate is reclaimed WITHOUT a removal: a worktree whose directory has
   * already vanished leaves only its lease record, and that record is what fails
   * the next start. See the comment on the `!actual.exists` arm.
   */
  async sweepOrphans(input: WorktreeSweepInput): Promise<WorktreeSweepResult> {
    return this.serialize(() => this.sweepOrphansUnlocked(input))
  }

  private async sweepOrphansUnlocked(input: WorktreeSweepInput): Promise<WorktreeSweepResult> {
    const dryRun = input.dryRun === true
    // P6.136 — OURS FIRST, so a lease this service holds is never shadowed by a
    // caller's stale copy of it. Everything downstream reads this union, and
    // `this.state.leases` alone still decides what gets committed.
    const considered: WorktreeLeaseV1[] = [...this.state.leases]
    const seen = new Set(considered.map(lease => lease.worktreeLeaseId))
    for (const lease of input.foreignLeases ?? []) {
      if (seen.has(lease.worktreeLeaseId)) continue
      seen.add(lease.worktreeLeaseId)
      considered.push(lease)
    }
    const ours = new Set(this.state.leases.map(lease => lease.worktreeLeaseId))
    const plan = planWorktreeOrphanSweep({
      leases: considered,
      liveLeaseIds: input.liveLeaseIds,
      cutoffMs: input.cutoffMs,
    })
    // The shared planner works on identity and age and knows nothing about
    // branches, so the branch is joined back on here rather than added to it —
    // this method already holds the leases the plan is about.
    const branchOf = (worktreeLeaseId: string) =>
      considered.find(value => value.worktreeLeaseId === worktreeLeaseId)?.branch ?? ''
    const result: WorktreeSweepResult = {
      dryRun,
      removed: [],
      skipped: plan.skipped.map(skip => ({ ...skip, branch: branchOf(skip.worktreeLeaseId) })),
    }

    // P6.336 — the operator's policy, applied to the planner's candidates BEFORE
    // any git is touched, and in the order a person would state it: never
    // delete, then never delete THIS one, then keep the newest N.
    //
    // Every exemption is REPORTED as a skip with its own reason rather than
    // filtered away, because the whole point of the row is that a sweep with no
    // operator-visible policy is a control the operator can neither see nor
    // stop. `skipped` is what the caller renders.
    const exempt = new Map<string, WorktreeSweepSkipReason>()
    if (input.autoRemove === false) {
      for (const candidate of plan.candidates) exempt.set(candidate.worktreeLeaseId, 'auto-remove-off')
    } else {
      for (const candidate of plan.candidates) {
        const lease = considered.find(value => value.worktreeLeaseId === candidate.worktreeLeaseId)
        if (lease?.permanent === true) exempt.set(candidate.worktreeLeaseId, 'permanent')
      }
      if (input.retainCount !== undefined) {
        // Newest first, and the count is applied to what is left AFTER the
        // permanent exemptions: a permanent worktree is not one of the N a
        // retention count is deciding about.
        const eligible = plan.candidates
          .filter(candidate => !exempt.has(candidate.worktreeLeaseId))
          .map(candidate => ({
            id: candidate.worktreeLeaseId,
            lastUsedAt: considered.find(value => value.worktreeLeaseId === candidate.worktreeLeaseId)?.lastUsedAt ?? '',
          }))
          .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
        for (const entry of eligible.slice(0, Math.max(0, input.retainCount))) {
          exempt.set(entry.id, 'retained')
        }
      }
    }
    for (const [worktreeLeaseId, reason] of exempt) {
      const lease = considered.find(value => value.worktreeLeaseId === worktreeLeaseId)
      if (!lease) continue
      result.skipped.push({ worktreeLeaseId, path: lease.path, branch: lease.branch, reason })
    }

    for (const candidate of plan.candidates) {
      if (exempt.has(candidate.worktreeLeaseId)) continue
      const lease = considered.find(value => value.worktreeLeaseId === candidate.worktreeLeaseId)
      if (!lease) continue
      const identity = { worktreeLeaseId: lease.worktreeLeaseId, path: lease.path, branch: lease.branch }

      let actual
      try {
        actual = await this.options.git.inspect(structuredClone(lease))
      } catch {
        result.skipped.push({ ...identity, reason: 'remove-failed' })
        continue
      }
      // P3.312 — GIT'S OWN LOCK, ASKED BEFORE ANY OTHER QUESTION.
      //
      // `worktrees.md#clean-up-subagent-and-background-session-worktrees`:
      // "While an agent is running, Claude Code holds a `git worktree lock` on
      // its worktree so that concurrent cleanup can't remove it", "The sweep
      // also releases a lock Claude Code set for a session whose process has
      // exited", and "The sweep never releases a lock you set yourself with
      // `git worktree lock`".
      //
      // This is the cross-process half of `live-lease`, and it is the reason
      // the destructive direction of a wider sweep can be made safe at all:
      // `liveLeaseIds` is one process's answer, while a lock is git's, and
      // `git worktree remove` enforces it whatever this code decides.
      //
      // OUR OWN pid is the case to read twice. A lock naming THIS process is
      // stale by construction — inside this process `liveLeaseIds` is the
      // authority, and the candidate already got past it — so it is released
      // rather than honoured. Treating it as live would undo P6.21: the
      // vanished-directory reclaim below would stop reclaiming the record whose
      // absence makes `recover()` throw.
      const lock = await this.readGitLock(lease)
      if (lock === undefined && this.gitLockAvailable) {
        // Unreadable, never "unlocked": the direction that guesses removes a
        // live worktree.
        result.skipped.push({ ...identity, reason: 'locked' })
        continue
      }
      if (lock?.locked === true) {
        if (lock.owner === undefined) {
          result.skipped.push({ ...identity, reason: 'locked-elsewhere' })
          continue
        }
        const self = (this.options.lockOwner ?? currentWorktreeLockOwner)()
        const mine = lock.owner.pid === self.pid && lock.owner.host === self.host
        if (!mine && (this.options.lockOwnerAlive ?? worktreeLockOwnerIsAlive)(lock.owner)) {
          result.skipped.push({ ...identity, reason: 'locked' })
          continue
        }
        // Released BEFORE the dirty and holds-commits checks, deliberately: a
        // killed session's lock on a worktree this sweep then KEEPS is exactly
        // the "permanently locked" state the page says the sweep clears, and a
        // dry run must report the candidate as removable or the real pass —
        // gated on a non-empty dry-run set at the call site — never runs.
        if (!dryRun && !(await this.dropGitLock(lease))) {
          result.skipped.push({ ...identity, reason: 'locked' })
          continue
        }
      }

      // P6.21 — THE DIRECTORY IS GONE, SO THE LEASE RECORD IS THE WHOLE ORPHAN.
      //
      // This used to be a permanent `skipped: 'missing'`: nothing removed it and
      // nothing else ever would, because this sweep is the only worktree GC. The
      // cost is not a stale row in a file. `recoverUnlocked` runs immediately
      // after this pass and THROWS `worktree-missing` for an `active` lease whose
      // worktree has vanished, and every child-session operation goes through the
      // port that awaits it — so the session that owns the record loses `subagent`,
      // `EnterWorktree` and every spawn until someone edits the state by hand.
      // Measured on a real repository 2026-08-30: acquire, delete the directory,
      // sweep past the cutoff => `skipped: ['missing']`, lease still listed,
      // `recover()` => `worktree-missing`.
      //
      // That is the exact failure the docstring above says a retention pass
      // prevents ("the ones that do not never reach `recover()`"), and it is the
      // state a user manufactures by cleaning up the leaked worktrees P6.21 leaves
      // behind on the non-Pi runtimes.
      //
      // So the record is reclaimed rather than kept. It is NOT routed through
      // `releaseUnlocked`: that path reports `worktree-missing` as a residual for
      // an `active` lease, which is the honest answer for an explicit release —
      // the caller asked to remove a specific worktree and it was not there — and
      // widening it would weaken the drain path's failure signal. `git.remove` is
      // not called (there is nothing to remove) and `WorktreeRemove` does not
      // fire (nothing was removed), matching `releaseUnlocked`'s own
      // vanished-`creating` arm, which drops the record silently for the same
      // reason.
      const reclaimed = { worktreeLeaseId: identity.worktreeLeaseId, path: identity.path }
      if (!actual.exists) {
        // P6.136 · a foreign lease's record belongs to another session's file,
        // and there is no directory left to remove. Reporting it as reclaimed
        // would claim a write this pass cannot make.
        if (!ours.has(lease.worktreeLeaseId)) {
          result.skipped.push({ ...identity, reason: 'foreign-record' })
          continue
        }
        if (!dryRun) {
          await this.commit(this.state.leases.filter(value => value.worktreeLeaseId !== lease.worktreeLeaseId))
        }
        result.removed.push({ ...reclaimed, lastUsedAt: candidate.lastUsedAt })
        continue
      }
      if (actual.dirty) {
        result.skipped.push({ ...identity, reason: 'dirty' })
        continue
      }
      if (actual.baseSha !== lease.baseSha) {
        result.skipped.push({ ...identity, reason: 'holds-commits' })
        continue
      }

      if (dryRun) {
        result.removed.push({ ...reclaimed, lastUsedAt: candidate.lastUsedAt })
        continue
      }
      try {
        // P6.136 · a FOREIGN lease cannot go through `releaseUnlocked` — that
        // path looks the id up in `this.state.leases` and RETURNS on a miss, so
        // routing one through it would report a removal that never happened.
        // The four questions it asks have already been asked above for this
        // candidate (exists, dirty, holds-commits, and git's lock), so what is
        // left is provenance and the removal itself; the ledger write is
        // deliberately absent, because the record is another session's.
        if (ours.has(lease.worktreeLeaseId)) {
          await this.releaseUnlocked(lease.worktreeLeaseId)
        } else {
          this.assertProvenance(lease, actual)
          await this.options.git.remove(structuredClone(lease))
          try { await this.emit?.('WorktreeRemove', structuredClone(lease)) } catch {}
        }
        result.removed.push({ ...reclaimed, lastUsedAt: candidate.lastUsedAt })
      } catch {
        result.skipped.push({ ...identity, reason: 'remove-failed' })
      }
    }

    return result
  }

  /**
   * P3.312 — the interlock is available only with all three git lock methods.
   *
   * One boolean rather than three optional-call sites, because a partial port is
   * worse than none: locking without being able to unlock leaves a killed
   * session's worktree permanently unremovable, and reading without locking
   * protects nothing while looking as if it does.
   */
  private get gitLockAvailable(): boolean {
    const git = this.options.git
    return typeof git.lockState === 'function'
      && typeof git.lock === 'function'
      && typeof git.unlock === 'function'
  }

  /**
   * Take git's lock for the running process — *"While an agent is running,
   * Claude Code holds a `git worktree lock` on its worktree"*.
   *
   * NEVER fails the operation it is part of. A worktree that exists and works
   * must not be refused because a protection step did not take, by the same
   * rule the symlink loop, `.worktreeinclude` and `worktree.setupScript` follow.
   * The cost of a failure is stated rather than hidden: the interlock is not
   * held for that worktree, so it falls back to the in-process `liveLeaseIds`
   * protection — exactly the state before this row.
   */
  /**
   * P6.324 (a) — refuse a target directory git does not agree is its own
   * worktree. Silent for a path that does not exist yet, and for a host with no
   * probe.
   */
  private async assertWorktreeIdentity(path: string): Promise<void> {
    const identify = this.options.git.identifyToplevel
    if (!identify) return
    const repoRoot = await this.options.repoRoot?.()
    if (!repoRoot) return
    let toplevel: string | null
    try {
      toplevel = await identify.call(this.options.git, path)
    } catch {
      // Unreadable is not a refusal here: the create path is where a probe
      // failure would block ordinary work, and the screen's whole value is the
      // POSITIVE identification of a directory that already exists.
      return
    }
    // `null` for a path that does not exist yet — the ordinary create.
    if (toplevel === null) return
    const screened = screenWorktreeIdentity({ candidatePath: path, repoRoot, toplevel })
    if (screened.ok) return
    throw new Error(
      `worktree-identity-refused: ${describeWorktreeIdentityRefusal(screened.refusedReason)} (${path})`,
    )
  }

  private async takeGitLock(lease: WorktreeLeaseV1): Promise<void> {
    if (!this.gitLockAvailable) return
    const owner = (this.options.lockOwner ?? currentWorktreeLockOwner)()
    try {
      await this.options.git.lock?.(lease, worktreeLockReason({ owner, worktreeLeaseId: lease.worktreeLeaseId }))
    } catch { /* not held; see the docblock */ }
  }

  /** git's lock state, or `undefined` when the interlock is unavailable or unreadable. */
  private async readGitLock(lease: WorktreeLeaseV1): Promise<{ locked: boolean; owner?: WorktreeLockOwner } | undefined> {
    if (!this.gitLockAvailable) return undefined
    let state
    try {
      state = await this.options.git.lockState?.(lease)
    } catch {
      // Unreadable is not "unlocked": reading it as unlocked is the answer that
      // removes a live worktree. The callers treat `undefined` as "assume held".
      return undefined
    }
    if (!state) return undefined
    if (!state.locked) return { locked: false }
    const owner = parseWorktreeLockReason(state.reason)
    return { locked: true, ...(owner === undefined ? {} : { owner }) }
  }

  /**
   * Release a lock THIS APP set, and only that — *"The sweep never releases a
   * lock you set yourself with `git worktree lock`"*.
   *
   * Returns whether the worktree is now unlocked from git's point of view, which
   * is the question every caller actually has: `git worktree remove` refuses a
   * locked worktree, so a `false` here means the removal must not be attempted.
   */
  private async dropGitLock(lease: WorktreeLeaseV1): Promise<boolean> {
    if (!this.gitLockAvailable) return true
    const state = await this.readGitLock(lease)
    if (state === undefined) return false
    if (!state.locked) return true
    if (state.owner === undefined) return false
    try {
      await this.options.git.unlock?.(lease)
      return true
    } catch {
      return false
    }
  }

  private timestamp(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  /**
   * P6.508 — `branch` is the one input a CALLER may name, and only a caller
   * that already owns a branch namespace does.
   *
   * Every other acquisition lets the policy derive `nessy/<agent>/<leaseId>`,
   * which is what makes those branches identifiable as ours and safe to delete.
   * A batch is the exception the row asks for by name: its result NAMES the
   * branches a human then submits, so the names have to be the caller's own
   * (`batch/2026-09-08/<slug>`) rather than a derived spelling the caller
   * cannot predict — a reply naming branches that do not exist is worse than no
   * reply. The collision check below is unchanged and still refuses a branch a
   * live lease already holds.
   */
  async acquire(input: { ownerAgentId: string; worktreeLeaseId?: string; branch?: string; permanent?: boolean; mergeRequestRef?: ForgeMergeRequestRef }): Promise<WorktreeLeaseV1> {
    return this.serialize(() => this.acquireUnlocked(input))
  }

  private async acquireUnlocked(input: { ownerAgentId: string; worktreeLeaseId?: string; branch?: string; permanent?: boolean; mergeRequestRef?: ForgeMergeRequestRef }): Promise<WorktreeLeaseV1> {
    const worktreeLeaseId = input.worktreeLeaseId ?? this.options.makeId?.() ?? crypto.randomUUID()
    if (this.state.leases.some(lease => lease.worktreeLeaseId === worktreeLeaseId)) throw new Error('worktree-id-reused')
    const selected = await this.options.policy.select({
      worktreeLeaseId,
      ownerAgentId: input.ownerAgentId,
      ...(input.branch ? { branch: input.branch } : {}),
      // P6.335 — the base commit comes from a merge request instead of the
      // configured base ref. Resolved inside the policy, where the git runner
      // lives, so this service stays free of git.
      ...(input.mergeRequestRef ? { mergeRequestRef: input.mergeRequestRef } : {}),
    })
    if (!selected.path || !selected.branch || !selected.baseSha) throw new Error('worktree-policy-selection-invalid')
    if (this.state.leases.some(lease => lease.path === selected.path || lease.branch === selected.branch)) {
      throw new Error('worktree-collision')
    }
    const resolved = await this.applyWorktreeCreateHookPath(selected, worktreeLeaseId, input.ownerAgentId)
    // P6.324 (a) — the IDENTITY screen, before anything is created at that path.
    //
    // The path screen (`resolveHookWorktreePath`) answers whether a path is
    // ALLOWED to be a worktree of this repository; it says nothing about what
    // git thinks the directory already IS. A target that exists and resolves
    // back into the main checkout is not isolation at all — a `git reset --hard`
    // inside it acts on the user's real tree — and the same is true of a `.git`
    // file or a `core.worktree` redirect pointing elsewhere.
    //
    // Only for a path that already exists: the ordinary create targets a
    // directory that does not, and `identifyToplevel` answers `null` for it,
    // which the screen reads as a refusal. So the probe is skipped rather than
    // being asked a question with no answer, and a host that supplies no probe
    // at all keeps exactly today's behaviour.
    await this.assertWorktreeIdentity(resolved.path)
    const lease: WorktreeLeaseV1 = {
      schemaVersion: 1,
      worktreeLeaseId,
      workspaceId: this.options.workspaceId,
      ownerAgentId: input.ownerAgentId,
      path: resolved.path,
      branch: resolved.branch,
      baseSha: resolved.baseSha,
      // P6.336 (b) — recorded at acquisition, dropped at rest, so a lease that
      // is not permanent is byte-identical to one written before the field.
      ...(input.permanent ? { permanent: true } : {}),
      status: 'creating',
      lastUsedAt: this.timestamp(),
    }
    if (this.state.leases.some(value => value.path === lease.path)) throw new Error('worktree-collision')
    await this.commit([...this.state.leases, lease])
    let created: WorktreeCreateOutcome | void
    try {
      created = await this.options.git.create(structuredClone(lease), { hookReplacedPath: resolved.hookReplacedPath })
    } catch {
      throw new WorktreeLeaseError('worktree-create-interrupted', [residual(worktreeLeaseId, 'worktree-create-interrupted')])
    }
    // P6.547 — recorded now, while the answer is certain, and only when TRUE:
    // a lease persisted before this field existed must keep meaning "we do not
    // know", which is the same thing as "do not touch the branch".
    if (created && created.branchCreated === true) lease.branchCreated = true
    // P3.312 — the lock goes on the moment the worktree exists, BEFORE the
    // setup script: the script is arbitrary shell the user declared, it can run
    // for minutes, and a sweep in another process must not remove the worktree
    // out from under it. The lease is still `creating` here, which is the point
    // — `worktrees.md` holds the lock "while an agent is running", and this
    // service's equivalent of that window opens at creation and closes at
    // release.
    await this.takeGitLock(structuredClone(lease))
    // `worktree.setupScript` runs HERE: after git made the worktree — there is
    // nothing to set up before that — and before the lease turns `active`, so
    // "active" keeps meaning "created, and setup attempted". It cannot fail the
    // creation, by the same rule the symlink and `.worktreeinclude` steps in
    // `git.create` follow.
    await this.runSetupScript(structuredClone(lease))
    const active = { ...lease, status: 'active' as const }
    await this.commit(this.state.leases.map(value => value.worktreeLeaseId === worktreeLeaseId ? active : value))
    return structuredClone(active)
  }

  /**
   * Fire `WorktreeCreate` on the PROPOSED path and adopt a hook-returned path
   * when it passes the documented screen (`.`/`..` segments and any symlink
   * below the repo root are refused).
   *
   * The exits distinguish "hook offered nothing" from "hook failed"
   * (hooks.md:699 — any non-zero exit aborts worktree creation):
   * - an emit that resolves with neither path nor block PROCEEDS with the
   *   policy's own selection — exiting 0 with no path is not a refusal;
   * - a thrown emit, a `blocked` result, an offered path the escape screen
   *   refuses, or an offered path the service cannot validate ABORTS creation
   *   with a stated reason. A hook written as a gate must never be a silent
   *   no-op on failure, and a hook whose replacement was rejected must not
   *   silently create at a path it did not ask for.
   *
   * `hookReplacedPath` in the return reports whether the hook's path was
   * ADOPTED — the `.worktreeinclude` carve-out signal `git.create` receives
   * (worktrees.md:231). A silent hook, an empty offer, or no emit at all is
   * `false`.
   */
  private async applyWorktreeCreateHookPath(
    selected: { path: string; branch: string; baseSha: string },
    worktreeLeaseId: string,
    ownerAgentId: string,
  ): Promise<{ path: string; branch: string; baseSha: string; hookReplacedPath: boolean }> {
    if (!this.emit) return { ...selected, hookReplacedPath: false }
    let returned: WorktreeLeaseEmitResult | void
    try {
      returned = await this.emit('WorktreeCreate', structuredClone({
        schemaVersion: 1,
        worktreeLeaseId,
        workspaceId: this.options.workspaceId,
        ownerAgentId,
        ...selected,
        status: 'creating',
      } satisfies WorktreeLeaseV1))
    } catch (error) {
      throw new Error(`worktree-create-hook-failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (returned?.blocked === true) {
      throw new Error(`worktree-create-hook-blocked: ${returned.blockReason ?? 'a WorktreeCreate hook exited non-zero'}`)
    }
    const candidate = returned?.worktreePath
    if (!candidate) return { ...selected, hookReplacedPath: false }
    const repoRoot = await this.options.repoRoot?.()
    if (!repoRoot) {
      throw new Error('worktree-create-hook-path-unverifiable: the service has no repository root to validate the returned path against')
    }
    const resolved = resolveHookWorktreePath(candidate, { repoRoot })
    if ('refusedReason' in resolved) {
      throw new Error(`worktree-create-hook-path-refused: ${resolved.refusedReason}`)
    }
    return { ...selected, path: resolved.path, hookReplacedPath: true }
  }

  /**
   * `worktree.setupScript` — run the workspace-tier setup script in a worktree
   * that has just been created, once the user has said yes.
   *
   * ## What it must never do
   *
   * FAIL THE CREATION. Not a refused consent, not a missing repository root,
   * not a script that exits 99, not a port that throws. The worktree exists by
   * the time this runs and the lease is about to go `active`; turning any of
   * these into a throw would hand the caller a `worktree-create-interrupted`
   * residual for a worktree that is on disk and fine. The two steps closest to
   * this one — the symlink loop and `.worktreeinclude` — already hold that
   * rule, and a setup script is a weaker claim on creation than either.
   *
   * RUN WITHOUT A CARD. The only path past `port.consent` is a record the user
   * created by answering it, for THIS script (a digest of the exact string) in
   * THIS project. An unreadable or malformed record file reads as "nothing
   * remembered", so the failure direction is an extra prompt.
   *
   * RUN TWICE. It is deliberately not invoked from `recover()`. The steps
   * inside `git.create` are re-invocable because they are skip-if-exists file
   * copies; a shell command is not idempotent, and a crash between the script
   * and the `active` commit must not re-install, re-migrate or re-seed on the
   * next start. The cost is stated rather than hidden: a worktree whose session
   * died mid-setup comes back `active` with the setup unfinished.
   */
  private async runSetupScript(lease: WorktreeLeaseV1): Promise<void> {
    const port = this.options.setup
    if (!port) return
    let declared: string | undefined
    try {
      declared = (await port.script())?.trim() || undefined
    } catch {
      // A settings layer that throws is a rejected layer, not a reason to
      // report anything: the config reader already reports it, and no script is
      // the same outcome as no key.
      return
    }
    if (!declared) return
    const script = declared

    const report = async (outcome: Parameters<typeof describeWorktreeSetupOutcome>[0]['outcome']) => {
      try {
        await port.report(describeWorktreeSetupOutcome({
          worktreePath: lease.path,
          script,
          outcome,
        }))
      } catch {
        // The transcript is where this is SUPPOSED to land; a sink that throws
        // is still not allowed to take the worktree down with it.
      }
    }

    try {
      const repoRoot = await this.options.repoRoot?.()
      if (!repoRoot) {
        // The consent record is keyed per project, and without a repository
        // root there is no project to key it on. Refusing to run beats keying
        // one user's approval to a scope that means nothing.
        await report({ kind: 'failed', reason: 'this service has no repository root to scope the approval to' })
        return
      }
      const projectKey = worktreeSetupConsentProjectKey(repoRoot)
      const consentName = worktreeSetupConsentName(script)
      this.setupConsent ??= createWorktreeSetupConsentStore(
        port.consentStorePath === undefined ? {} : { path: port.consentStorePath },
      )
      if (!this.setupConsent.has(projectKey, consentName)) {
        const answer = await port.consent({
          description: describeWorktreeSetupConsent({ script, worktreePath: lease.path }),
          command: script,
          projectKey,
          consentName,
          worktreePath: lease.path,
        })
        if (!answer?.granted) {
          await report({ kind: 'refused' })
          return
        }
        // Recorded only on an explicit "and don't ask again": a plain yes is
        // consent for this run, and promoting it would make the card harder to
        // take back than it was to give.
        if (answer.remember === true) this.setupConsent.remember(projectKey, consentName)
      }
      const result = await port.run(worktreeSetupCommand({ worktreePath: lease.path, script }))
      await report({ kind: 'ran', output: result.output, exitCode: result.exitCode })
    } catch (error) {
      await report({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) })
    }
  }

  async recover(): Promise<WorktreeLeaseV1[]> {
    return this.serialize(() => this.recoverUnlocked())
  }

  private async recoverUnlocked(): Promise<WorktreeLeaseV1[]> {
    for (const lease of this.list()) {
      const actual = await this.options.git.inspect(lease)
      if (lease.status === 'creating') {
        if (!actual.exists) {
          try {
            // Re-invoked create after a crash. The adoption flag is
            // call-scoped, never persisted, so recovery cannot know whether a
            // hook chose this path and passes `false`; the include step is
            // idempotent (skip-if-exists) for exactly this re-invocation.
            // `runSetupScript` is deliberately NOT re-invoked here — a shell
            // command is not idempotent (see its docblock).
            await this.options.git.create(lease, { hookReplacedPath: false })
          } catch {
            throw new WorktreeLeaseError('worktree-create-interrupted', [residual(lease.worktreeLeaseId, 'worktree-create-interrupted')])
          }
        } else {
          this.assertProvenance(lease, actual)
        }
        const active = { ...lease, status: 'active' as const }
        await this.commit(this.state.leases.map(value => value.worktreeLeaseId === lease.worktreeLeaseId ? active : value))
        // P3.312 — same re-lock as the `active` arm below, and needed in both
        // of this arm's cases: a re-created worktree carries no lock at all,
        // and a surviving one carries the crashed run's. The invariant every
        // caller then gets is one sentence — every lease `recover()` returns is
        // locked by THIS process.
        if (await this.dropGitLock(active)) await this.takeGitLock(active)
        continue
      }
      if (!actual.exists) throw new WorktreeLeaseError('worktree-missing', [residual(lease.worktreeLeaseId, 'worktree-missing')])
      this.assertProvenance(lease, actual)
      // P3.312 — RE-LOCK, because the lock on disk names the DEAD process.
      //
      // A lock survives the crash that produced this recovery, still carrying
      // the previous run's pid. Left alone, another process's sweep reads that
      // pid as exited, releases the lock and removes a worktree this session is
      // about to use — so recovery has to re-stamp it. `git worktree lock`
      // refuses an already-locked worktree (measured: exit 128), which is why
      // the old lock is dropped first, and only when it is ours.
      if (await this.dropGitLock(lease)) await this.takeGitLock(lease)
    }
    return this.list()
  }

  /**
   * Remove one worktree and drop its lease.
   *
   * `refuseIfHoldsWork` (P6.22) adds the sweep's second refusal to this path:
   * unpushed commits. The dirty check below has always been here, but HEAD
   * moving past the lease's base has not — `assertProvenance` explicitly
   * ALLOWS it (`baseShaIsAncestor`), because a caller naming one worktree has
   * said which one. `ExitWorktree({ remove: true })` is the one caller that
   * needs the stricter rule: the user is leaving, not deleting, and losing
   * commits on the way out is not something to infer from a cwd change.
   *
   * Off by default, so the drain and the age sweep are byte-identical to
   * before — the sweep applies the same condition earlier, as
   * `reason: 'holds-commits'`, and never reaches here with one.
   */
  async release(
    worktreeLeaseId: string,
    options: { refuseIfHoldsWork?: boolean } = {},
  ): Promise<WorktreeReleaseOutcome | undefined> {
    return this.serialize(() => this.releaseUnlocked(worktreeLeaseId, options))
  }

  private async releaseUnlocked(
    worktreeLeaseId: string,
    options: { refuseIfHoldsWork?: boolean } = {},
  ): Promise<WorktreeReleaseOutcome | undefined> {
    const lease = this.state.leases.find(value => value.worktreeLeaseId === worktreeLeaseId)
    if (!lease) return
    const actual = await this.options.git.inspect(structuredClone(lease))
    if (!actual.exists) {
      if (lease.status === 'creating') {
        // P3.312 — drop our lock even though there is nothing to remove: a
        // locked entry whose directory is gone is NOT prunable (measured:
        // `git worktree prune -v` leaves it, and clears it the moment it is
        // unlocked), so keeping the lock would trade a leaked worktree for a
        // leaked admin directory nothing in this app ever prunes.
        await this.dropGitLock(lease)
        await this.commit(this.state.leases.filter(value => value.worktreeLeaseId !== worktreeLeaseId))
        return
      }
      throw new WorktreeLeaseError('worktree-missing', [residual(worktreeLeaseId, 'worktree-missing')])
    }
    if (actual.dirty) throw new WorktreeLeaseError('worktree-dirty', [residual(worktreeLeaseId, 'worktree-dirty')])
    if (options.refuseIfHoldsWork && actual.baseSha !== lease.baseSha) {
      throw new WorktreeLeaseError('worktree-holds-commits', [residual(worktreeLeaseId, 'worktree-holds-commits')])
    }
    this.assertProvenance(lease, actual)
    // P3.312 — our own lock has to come off first, or the removal cannot
    // happen at all: `git worktree remove` refuses a locked worktree and so
    // does `--force` (measured: exit 128 for both; only `-f -f` overrides).
    // A FOREIGN lock is deliberately left in place — the documented rule is
    // absolute — and the removal then fails as `worktree-remove-failed`, which
    // is the residual this path already reports for a removal git refused.
    await this.dropGitLock(lease)
    let removed: WorktreeReleaseOutcome | void
    try {
      removed = await this.options.git.remove(structuredClone(lease))
    } catch {
      throw new WorktreeLeaseError('worktree-remove-failed', [residual(worktreeLeaseId, 'worktree-remove-failed')])
    }
    await this.commit(this.state.leases.filter(value => value.worktreeLeaseId !== worktreeLeaseId))
    try { await this.emit?.('WorktreeRemove', structuredClone(lease)) } catch {}
    // P6.547 — a port that reports nothing is a port that deleted no branch,
    // which is what every host did before this row.
    return removed ?? { branchDeleted: false }
  }

  private assertProvenance(lease: WorktreeLeaseV1, actual: { branch: string; baseSha: string; baseShaIsAncestor?: boolean }): void {
    if (actual.branch !== lease.branch || (actual.baseSha !== lease.baseSha && actual.baseShaIsAncestor !== true)) {
      throw new WorktreeLeaseError('worktree-provenance-mismatch', [residual(lease.worktreeLeaseId, 'worktree-provenance-mismatch')])
    }
  }

  private async commit(leases: WorktreeLeaseV1[]): Promise<void> {
    const candidate: WorktreeLeaseStateV1 = { schemaVersion: 1, revision: this.state.revision + 1, leases: structuredClone(leases) }
    await this.options.persist(structuredClone(candidate))
    this.state = candidate
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutationTail.then(operation)
    this.mutationTail = current.then(() => {}, () => {})
    return current
  }
}

function residual(resourceId: string, code: WorktreeResidual['code']): WorktreeResidual {
  return { resourceType: 'worktree', resourceId, code }
}
