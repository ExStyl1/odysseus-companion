/**
 * P6.333 — moving a CHAT between the local checkout and its worktree, in either
 * direction, carrying the uncommitted work with it.
 *
 * ## The name collision, refuted here because this is where the next reader lands
 *
 * `handoff` in this tree is the RUNTIME handoff — `runtime-handoff.ts`,
 * `pi-session-rebuild.ts`, `PI_CARRY_FILENAME = 'handoff.jsonl'` — which moves a
 * conversation between Pi, Claude and Codex. It is **not** this capability, and
 * nothing here touches it. This module moves one session between two
 * DIRECTORIES of the same repository while its runtime, its transcript and its
 * id all stay exactly where they are.
 *
 * ## Native, asked of all three and answered — condition (2)
 *
 * - **Codex**: Handoff is the ChatGPT-desktop app's UI, not app-server surface.
 *   `packages/codex-protocol/generated/ClientRequest.ts:100` enumerates ~100
 *   methods with no handoff and no worktree method (`gitDiffToRemote`,
 *   `command/exec`, `fs/*` are the nearest).
 * - **Claude**: the pages document `.claude/worktrees/` and `.worktreeinclude`
 *   and no chat-move flow of any kind.
 * - **Pi**: the nearest thing moves cwd only.
 *
 * So the host builds it once, and because this planner is pure and never asks
 * which runtime is attached, "identically on all three" is true by construction
 * rather than by three ports.
 *
 * ## What HEAD already had, and why it is not this
 *
 * `ExitWorktree` (`session-tools-core/src/tool-defs.ts:941`) says it in its own
 * words — *"Call ExitWorktree to go back to the directory the session started
 * in"* — and its only option, `remove`, is *"Refused … when it still holds
 * uncommitted changes or commits that exist nowhere else"*. So HEAD can move the
 * CWD and REFUSE to lose work; it has never been able to CARRY work. It is also
 * `visibility: 'pi-only'`, which is the divergence half of the same row.
 *
 * ## The carry is a patch, and the reason is the one the refusal already gives
 *
 * A worktree and its repository share one object database and one index-less
 * working tree each, so the uncommitted delta is the only thing that has to
 * move. It moves as a PATCH — `git diff HEAD` in the source, `git apply` in the
 * destination — rather than as a stash, and that is a decision with a reason:
 * `git stash` writes to a repository-wide stack shared by every worktree, so two
 * sessions moving at once would pop each other's work, and a failed pop leaves
 * an entry a person has to find. A patch is addressed to exactly one
 * destination and a failed apply changes nothing.
 *
 * **`--binary` is not optional.** Without it `git diff` emits
 * `Binary files a/x and b/x differ`, which `git apply` refuses — so an
 * uncommitted PNG would silently make the whole move fail, or worse, half-apply.
 *
 * **The source is left alone until the destination has the work.** The plan is
 * ordered apply-then-clean and {@link checkoutMoveIsReversible} says so: a move
 * whose first step discarded the source's changes has no way back if the apply
 * fails, and "kept its uncommitted diff" is the row's own `done_means`.
 *
 * ## The lease half, which is NOT a git question
 *
 * The row: *"the same worktree over time half is a lease-identity change, not
 * only a git one."* Moving a chat OUT of its worktree must not release the
 * lease when the chat may come back — a released lease is a worktree another
 * session may take, and the return trip would land somewhere else with the same
 * name. So {@link planCheckoutMove} reports {@link CheckoutMovePlan.retainLease}
 * and the executor is expected to honour it; releasing is a separate, explicit
 * act (`ExitWorktree` with `remove`), which is exactly the distinction that tool
 * already draws.
 */

import type { WorktreeGitCommand } from '../pi-harness/worktree-git-plan'

/** Which way the chat is going. */
export type CheckoutMoveDirection = 'to-local' | 'to-worktree'

export interface CheckoutMovePlanInput {
  direction: CheckoutMoveDirection
  /** The main checkout's root. */
  repoRoot: string
  /** The worktree's path — the other end of the move, whichever direction. */
  worktreePath: string
  /**
   * Whether the SOURCE has uncommitted changes.
   *
   * Supplied by the caller rather than probed here, because this module is a
   * pure planner: the probe is `git status --porcelain`, which is I/O, and a
   * planner that ran it could not be asserted without a repository.
   */
  sourceHasUncommittedChanges: boolean
  /**
   * Whether the DESTINATION has uncommitted changes of its own.
   *
   * A move into a dirty destination is refused rather than merged: `git apply`
   * would either conflict and change nothing, or apply cleanly on top of work
   * the person did not expect to be touched. Both are worse than being told.
   */
  destinationHasUncommittedChanges: boolean
  /**
   * Whether the session may come back to this worktree later.
   *
   * `true` keeps the lease (the default and the safe direction); `false` is the
   * caller saying it has already decided to give the worktree up.
   */
  mayReturn?: boolean
}

export interface CheckoutMoveRefusal {
  kind: 'refused'
  reason: string
}

export interface CheckoutMovePlan {
  kind: 'plan'
  direction: CheckoutMoveDirection
  /** Absolute path the session's cwd becomes. */
  destinationPath: string
  /** Absolute path the session leaves. */
  sourcePath: string
  /** Ordered git commands. Empty when there is nothing to carry. */
  commands: WorktreeGitCommand[]
  /** Whether the worktree lease is kept across the move. */
  retainLease: boolean
  /** True when there was uncommitted work and the plan carries it. */
  carriesUncommittedWork: boolean
}

/** The temp file the patch travels through, inside the app's own state directory. */
export const CHECKOUT_MOVE_PATCH_BASENAME = 'checkout-move.patch'

/**
 * Plan the move, or refuse it with a reason a person can act on.
 *
 * Pure: no git, no filesystem, no clock. Every fact it needs is an input, for
 * `worktree-git-plan.ts`'s stated reason — a planner that probes cannot be
 * asserted without a repository.
 */
export function planCheckoutMove(
  input: CheckoutMovePlanInput,
  patchPath: string,
): CheckoutMovePlan | CheckoutMoveRefusal {
  const sourcePath = input.direction === 'to-local' ? input.worktreePath : input.repoRoot
  const destinationPath = input.direction === 'to-local' ? input.repoRoot : input.worktreePath

  if (sourcePath === destinationPath) {
    return { kind: 'refused', reason: 'The session is already in that checkout.' }
  }
  if (input.destinationHasUncommittedChanges) {
    // Refused rather than merged: `git apply` on a dirty tree either conflicts
    // and changes nothing, or applies cleanly on top of work nobody expected to
    // be touched. Being told is better than either.
    return {
      kind: 'refused',
      reason: `${destinationPath} has uncommitted changes. Commit or stash them there first, then move the chat.`,
    }
  }

  const commands: WorktreeGitCommand[] = []
  if (input.sourceHasUncommittedChanges) {
    // `--binary` is load-bearing: without it an uncommitted binary file becomes
    // "Binary files a/x and b/x differ", which `git apply` refuses.
    commands.push(
      {
        operation: 'move-capture',
        cwd: input.direction === 'to-local' ? 'worktree' : 'repo',
        args: ['-C', sourcePath, 'diff', 'HEAD', '--binary', `--output=${patchPath}`],
      },
      // Apply BEFORE the source is cleaned, so a failed apply leaves the work
      // exactly where it was. `--index` keeps staged files staged, which is the
      // difference between "the chat moved" and "the chat moved and forgot what
      // I had added".
      {
        operation: 'move-apply',
        cwd: input.direction === 'to-local' ? 'repo' : 'worktree',
        args: ['-C', destinationPath, 'apply', '--index', patchPath],
      },
      // Only now: the source gives the work up. `checkout -- .` reverts tracked
      // files; untracked files are deliberately NOT removed, because `git clean`
      // in a directory a person may still have open is a destructive act this
      // move has no mandate for, and the patch carried them as additions.
      {
        operation: 'move-clean',
        cwd: input.direction === 'to-local' ? 'worktree' : 'repo',
        args: ['-C', sourcePath, 'checkout', '--', '.'],
      },
    )
  }

  return {
    kind: 'plan',
    direction: input.direction,
    sourcePath,
    destinationPath,
    commands,
    // Default TRUE and only the caller's explicit `false` gives the lease up: a
    // released lease is a worktree another session may take, and the return trip
    // would land somewhere else wearing the same name.
    retainLease: input.mayReturn !== false,
    carriesUncommittedWork: input.sourceHasUncommittedChanges,
  }
}

/**
 * Is this plan safe to abandon halfway?
 *
 * True when the destination gets the work before the source loses it, which is
 * the ordering above. Exported so a caller can assert the property rather than
 * re-reading the command list, and so a future edit that reorders the steps
 * fails a test instead of quietly making a failed move lose the work.
 */
export function checkoutMoveIsReversible(plan: CheckoutMovePlan): boolean {
  const apply = plan.commands.findIndex(command => command.operation === 'move-apply')
  const clean = plan.commands.findIndex(command => command.operation === 'move-clean')
  if (apply === -1 || clean === -1) return true
  return apply < clean
}

/**
 * What the session is told after the move, and why it names the lease.
 *
 * The person has to know two things a cwd change does not say: that their
 * uncommitted work came along, and whether the worktree they left is still
 * theirs. Model-facing text, so English (i18n rule 3) — it lands in the
 * transcript beside the move, not as UI chrome.
 */
export function describeCheckoutMove(plan: CheckoutMovePlan): string {
  const lines = [`This chat now works in ${plan.destinationPath}.`]
  lines.push(
    plan.carriesUncommittedWork
      ? 'Your uncommitted changes moved with it; the checkout you left is back to a clean HEAD.'
      : 'There were no uncommitted changes to carry.',
  )
  if (plan.direction === 'to-local') {
    lines.push(
      plan.retainLease
        ? 'The worktree is still held for this session, so the chat can move back to it later.'
        : 'The worktree is released, so moving back would create a new one.',
    )
  }
  return lines.join(' ')
}
