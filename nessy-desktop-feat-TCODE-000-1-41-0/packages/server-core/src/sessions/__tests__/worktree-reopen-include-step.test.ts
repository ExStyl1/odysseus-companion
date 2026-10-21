/**
 * C3.308 — `.worktreeinclude` runs again on the reopen screen's RESET arm, and
 * deliberately not on its `reopen` arm; C3.306 — the one sentence the user gets
 * there, on the same arm and by the same posture; C3.335 — and the SYMLINK step
 * beside it, which C3.308 stated as a residue and left out.
 *
 * ## The state this closes
 *
 * C3.129 added the reopen screen to `git.create`, and it returns before the
 * create commands — so a reused worktree ran neither the symlink loop nor the
 * `.worktreeinclude` copy. On a plain `reopen` that is inert by construction:
 * every copy is skip-if-exists and the worktree already carries what was copied
 * when it was created. After a `reset` it is not. `worktreeReopenResetCommands`
 * is one `checkout -B`, which moves the branch and leaves ignored files alone,
 * so a `.worktreeinclude` entry the project has gained SINCE this worktree was
 * created is still missing from a tree the reset has just declared equivalent to
 * a fresh one.
 *
 * ## Why the source is the instrument
 *
 * The copy step's own behaviour — parsing, candidate probes, the plan, the
 * skip-if-exists and mode-preserving copy — is pinned by
 * `packages/server-core/src/pi-harness/worktree-include-plan.test.ts`, and the
 * decision table by `…/worktree-reopen-reset.test.ts`. Neither can see WHICH
 * ARM of `git.create` calls the step, which is the whole of this row, and a
 * behavioural test would need a real repository, a real worktree, a second
 * session and a `.worktreeinclude` edit between them to assert one call.
 *
 * Every read is paired with a positive control proving it found real code.
 */
import { describe, expect, test } from 'bun:test'
import { bracedRegion } from '@nessy-agent/shared/testing/source-regions'

const SESSION_MANAGER = new URL('../SessionManager.ts', import.meta.url).pathname
const CALL = 'await applyWorktreeIncludeCopies(root, lease.path, context.hookReplacedPath)'
/**
 * C3.335 — the symlink step's two calls. They are NOT one string: the create arm
 * already has `settings` in scope and the reset arm, which sits above that
 * binding, calls the accessor. Two constants keep the arm each one proves
 * unambiguous, which one shared substring could not.
 */
const SYMLINK_CREATE = 'await applyWorktreeSymlinks(root, lease.path, settings)'
const SYMLINK_RESET = 'await applyWorktreeSymlinks(root, lease.path, worktreeSettings())'

async function manager(): Promise<string> {
  return await Bun.file(SESSION_MANAGER).text()
}

describe('C3.308 — the include step has two callers, and the reopen arm is not one', () => {
  test('the step is a named helper, not a block inside one branch', async () => {
    const src = await manager()
    expect(src).toContain('const applyWorktreeIncludeCopies = async (')
    // Exactly two callers: the ordinary create, and the reset arm.
    const calls = src.split(CALL).length - 1
    expect(calls).toBe(2)
    // POSITIVE CONTROL that the read found the real create path: the symlink
    // step it sits beside is there too. C3.335 extracted that step into its own
    // named helper for the same reason this one was extracted, so the control
    // reads the helper rather than the loop body it used to be.
    expect(src).toContain('const applyWorktreeSymlinks = async (')
    expect(src).toContain(SYMLINK_CREATE)
  })

  test('one call is inside the reset arm and none is on the reopen path', async () => {
    const src = await manager()
    const resetArm = src.indexOf("if (decision.action === 'reset') {")
    // The reopen branch's epilogue — reached on BOTH arms, so it is the bound
    // that separates "inside the reset block" from "on every reuse".
    const epilogue = src.indexOf('reused: ${decision.action} (${decision.reason})')
    expect(resetArm).toBeGreaterThan(0)
    expect(epilogue).toBeGreaterThan(resetArm)
    const insideReopenScreen = src.slice(resetArm, epilogue)
    expect(insideReopenScreen).toContain(CALL)
    // And it is inside the `reset` block rather than after it: the reset
    // commands loop opens the block and nothing closes it before the call.
    const commands = insideReopenScreen.indexOf('worktreeReopenResetCommands(lease.path, lease.branch, lease.baseSha)')
    expect(commands).toBeGreaterThan(-1)
    expect(insideReopenScreen.indexOf(CALL)).toBeGreaterThan(commands)
    // NEGATIVE: the reopen arm runs nothing new. Everything between the
    // epilogue and the `branchCreated: false` return is the shared tail.
    const ret = src.indexOf('return { branchCreated: false }', epilogue)
    expect(ret).toBeGreaterThan(epilogue)
    expect(src.slice(epilogue, ret)).not.toContain('applyWorktreeIncludeCopies')
  })

  /**
   * C3.306 — the same arm, the same posture, and the same instrument: the
   * notice is the RESET arm's, and a plain `reopen` stays silent-with-a-log.
   * `worktrees.md#reuse-a-worktree-name` describes no notice for any of the five
   * states, so silence is the documented parity; what makes `reset` the
   * exception is surprise, not risk.
   */
  test('the reset arm, and only the reset arm, tells the user', async () => {
    const src = await manager()
    const resetArm = src.indexOf("if (decision.action === 'reset') {")
    const epilogue = src.indexOf('reused: ${decision.action} (${decision.reason})')
    const insideResetBlock = src.slice(resetArm, epilogue)
    // Same channel as the four sibling worktree notices, and a plain sentence
    // rather than a locale key, which is what P6.127 chose for the same subject.
    expect(insideResetBlock).toContain('this.appendWorktreeSetupNotice(')
    expect(insideResetBlock).toContain('reset it to the default branch')
    // It says nothing was discarded, because the three conditions guarantee it,
    // and it names the documented remedy.
    expect(insideResetBlock).toContain('nothing was discarded')
    expect(insideResetBlock).toContain('worktree.baseRef')
    // NEGATIVE: the shared tail every reuse reaches carries no notice, so a
    // `reopen` is silent. The tail starts at the `sessionLog.info` line, which
    // is also the POSITIVE CONTROL — the record is kept on BOTH arms, and it is
    // the half the row leaves in place.
    const logCall = src.indexOf('sessionLog.info(', resetArm)
    const ret = src.indexOf('return { branchCreated: false }', epilogue)
    expect(logCall).toBeGreaterThan(resetArm)
    expect(logCall).toBeLessThan(ret)
    expect(src.slice(logCall, ret)).not.toContain('appendWorktreeSetupNotice')
  })

  test('the helper still refuses a hook-replaced path and still fails nothing', async () => {
    const src = await manager()
    const start = src.indexOf('const applyWorktreeIncludeCopies = async (')
    expect(start).toBeGreaterThan(0)
    // D1.111 — the helper's own braces, not 2 600 characters of it.
    const body = bracedRegion(src, start)
    // BOUNDARY CONTROL: the region is that helper and not the rest of the file.
    // The anchor is what follows it — `applyWorktreeSymlinks` is declared ABOVE
    // and would make this line pass on a runaway scan.
    expect(body).not.toContain('const service = new WorktreeLeaseService({')
    // worktrees.md:231 — a WorktreeCreate hook that replaced the path means the
    // file is not processed. Carried through the extraction rather than left
    // behind at the old call site.
    expect(body).toContain("if (hookReplacedPath || !existsSync(join(repoRoot, '.worktreeinclude'))) return")
    // Nothing in here may fail creation, and now nothing in here may fail a
    // reopen either: both the per-copy and the whole-step failures are warnings.
    expect(body).toContain("sessionLog.warn('worktree include skipped', error)")
    expect(body).toContain('sessionLog.warn(`worktree include copy skipped:')
    // The mode is preserved — a 0600 `.env` must not land 0644.
    expect(body).toContain('await chmod(copy.destination, sourceStat.mode)')
  })
})

/**
 * C3.335 — the SIBLING step, on the same two arms. C3.308 stated the symlink
 * loop's absence from the reset arm as a deliberate residue; this closes it,
 * which means the residue sentence in that docblock had to go with it (a comment
 * asserting what a neighbouring step does not do has no guard of its own —
 * AGENTS.md §Traps).
 *
 * The instrument is the source for the same reason it is above: `worktreeSymlinkPlan`'s
 * own behaviour is pinned by `packages/server-core/src/pi-harness/worktree-git-plan.test.ts`
 * (`worktreeSymlinkPlan`), and nothing there can see WHICH ARM calls it.
 */
describe('C3.335 — the symlink step runs on the reset arm too, and still not on reopen', () => {
  test('it is a named helper with exactly two callers, one per arm', async () => {
    const src = await manager()
    expect(src).toContain('const applyWorktreeSymlinks = async (')
    expect(src.split(SYMLINK_CREATE).length - 1).toBe(1)
    expect(src.split(SYMLINK_RESET).length - 1).toBe(1)
    // The loop body now lives in exactly ONE place. A second copy is the drift
    // the extraction exists to prevent, and it is what a reader adding the reset
    // arm by hand would have produced.
    expect(src.split('for (const link of worktreeSymlinkPlan(').length - 1).toBe(1)
  })

  test('the reset call is inside the reset block and BEFORE the include copy', async () => {
    const src = await manager()
    const resetArm = src.indexOf("if (decision.action === 'reset') {")
    const epilogue = src.indexOf('reused: ${decision.action} (${decision.reason})')
    expect(resetArm).toBeGreaterThan(0)
    expect(epilogue).toBeGreaterThan(resetArm)
    const insideReopenScreen = src.slice(resetArm, epilogue)
    expect(insideReopenScreen).toContain(SYMLINK_RESET)
    // Same order as at creation: a link can carry a directory an include pattern
    // then copies INTO, never the reverse.
    expect(insideReopenScreen.indexOf(SYMLINK_RESET)).toBeLessThan(insideReopenScreen.indexOf(CALL))
    // …and after the reset commands, not before them.
    const commands = insideReopenScreen.indexOf('worktreeReopenResetCommands(lease.path, lease.branch, lease.baseSha)')
    expect(commands).toBeGreaterThan(-1)
    expect(insideReopenScreen.indexOf(SYMLINK_RESET)).toBeGreaterThan(commands)
  })

  test('NEGATIVE — the shared reuse tail runs neither step, so a plain reopen is untouched', async () => {
    const src = await manager()
    const epilogue = src.indexOf('reused: ${decision.action} (${decision.reason})')
    const ret = src.indexOf('return { branchCreated: false }', epilogue)
    expect(ret).toBeGreaterThan(epilogue)
    const tail = src.slice(epilogue, ret)
    expect(tail).not.toContain('applyWorktreeSymlinks')
    expect(tail).not.toContain('applyWorktreeIncludeCopies')
  })

  test('the helper fails nothing and skips what is already there', async () => {
    const src = await manager()
    const start = src.indexOf('const applyWorktreeSymlinks = async (')
    expect(start).toBeGreaterThan(0)
    const body = bracedRegion(src, start)
    // BOUNDARY CONTROL: the sibling helper below it is outside the region.
    expect(body).not.toContain('const applyWorktreeIncludeCopies = async (')
    // A missing target is skipped rather than failing creation, and an existing
    // link is skipped — which is what makes the SECOND call cheap.
    expect(body).toContain('if (!existsSync(link.target) || existsSync(link.link)) continue')
    expect(body).toContain('sessionLog.warn(`worktree symlink skipped:')
  })

  test('the C3.308 residue sentence is gone, not left reading as still true', async () => {
    const src = await manager()
    // The sentence asserted the symlink loop "is NOT re-run here". Guarding the
    // CLAIM rather than the row id: a stale-id guard fires on the very commit
    // that fixes it, because the fix names the id (AGENTS.md §Traps).
    expect(src).not.toContain('the SYMLINK loop is the')
    expect(src).not.toContain('same shape and is NOT re-run here')
    // POSITIVE CONTROL that the read reached the docblock at all: its
    // surviving C3.308 sentence, which this row does not touch.
    expect(src).toContain('a named step rather than a block inside `git.create`')
  })
})
