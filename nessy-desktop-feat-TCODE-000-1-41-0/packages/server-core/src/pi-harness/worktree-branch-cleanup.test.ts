/**
 * P6.547 — the removal takes the branch with it, NARROWLY, against real git.
 *
 * `worktrees.md#clean-up-worktrees` describes a removal that deletes "the
 * worktree directory and its branch". Ours ran `git worktree remove` and stopped
 * there, so branches accumulated one per worktree ever created. The controller's
 * decision is the documented shape with two narrowings, and both are what these
 * arms measure:
 *
 *  - only a branch the HOST minted for that worktree (`branchCreated`, recorded
 *    at creation) — a pre-existing branch is the user's;
 *  - only `git branch -d`, never `-D`. Git's own refusal on a branch holding
 *    commits its base does not IS the safety check, and the refusal is reported.
 *
 * Real git rather than a fake, for the same reason the lock interlock uses it:
 * the claim is that GIT decides, not that this code remembers to ask. Every
 * repository here is one this test made under `mkdtemp`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PiWorktreeLeaseStateV1, PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import { WorktreeLeaseService } from './worktree-lease-service.ts'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function makeRig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-worktree-branch-')))
  roots.push(root)
  const repoRoot = join(root, 'repo')
  const worktreeRoot = join(root, 'worktrees')
  const scratch = join(root, 'home')
  for (const path of [repoRoot, worktreeRoot, scratch]) mkdirSync(path, { recursive: true })

  const git = (cwd: string, ...args: string[]) => {
    const run = Bun.spawnSync(['git', '-c', 'user.email=branch@nessy.test', '-c', 'user.name=Branch', ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: scratch },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { status: run.exitCode, stdout: run.stdout?.toString() ?? '', stderr: run.stderr?.toString() ?? '' }
  }
  const must = (cwd: string, ...args: string[]) => {
    const run = git(cwd, ...args)
    if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
    return run
  }
  must(repoRoot, 'init', '--initial-branch=main', '.')
  writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n')
  must(repoRoot, 'add', 'seed.txt')
  must(repoRoot, 'commit', '-m', 'seed')
  const baseSha = must(repoRoot, 'rev-parse', 'HEAD').stdout.trim()
  const branchExists = (branch: string) =>
    git(repoRoot, '-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).status === 0

  return { root, repoRoot, worktreeRoot, baseSha, git, must, branchExists }
}

/** The production port's shape, built against the rig — including P6.547's two halves. */
function gitPort(rig: ReturnType<typeof makeRig>) {
  return {
    create: async (lease: PiWorktreeLeaseV1) => {
      const existed = rig.git(rig.repoRoot, '-C', rig.repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${lease.branch}`)
      const run = existed.status === 0
        ? rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'add', lease.path, lease.branch)
        : rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'add', '-b', lease.branch, lease.path, lease.baseSha)
      if (run.status !== 0) throw new Error(run.stderr)
      return { branchCreated: existed.status !== 0 }
    },
    inspect: async (lease: PiWorktreeLeaseV1) => {
      if (!existsSync(lease.path)) return { exists: false, dirty: false, branch: '', baseSha: '' }
      const status = rig.git(lease.path, '-C', lease.path, 'status', '--porcelain')
      const branch = rig.git(lease.path, '-C', lease.path, 'branch', '--show-current')
      const headSha = rig.git(lease.path, '-C', lease.path, 'rev-parse', 'HEAD').stdout.trim()
      const ancestor = rig.git(lease.path, '-C', lease.path, 'merge-base', '--is-ancestor', lease.baseSha, headSha)
      return {
        exists: true,
        dirty: status.stdout.trim().length > 0,
        branch: branch.stdout.trim(),
        baseSha: headSha,
        baseShaIsAncestor: ancestor.status === 0,
      }
    },
    remove: async (lease: PiWorktreeLeaseV1) => {
      const run = rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'remove', lease.path)
      if (run.status !== 0) throw new Error(run.stderr)
      if (lease.branchCreated !== true) {
        return { branchDeleted: false, branchKeptReason: 'the branch existed before this worktree' }
      }
      const deletion = rig.git(rig.repoRoot, '-C', rig.repoRoot, 'branch', '-d', lease.branch)
      if (deletion.status === 0) return { branchDeleted: true }
      return { branchDeleted: false, branchKeptReason: (deletion.stderr || deletion.stdout).trim() }
    },
  }
}

function makeService(rig: ReturnType<typeof makeRig>) {
  let state: PiWorktreeLeaseStateV1 = { schemaVersion: 1, revision: 0, leases: [] }
  const service = new WorktreeLeaseService({
    workspaceId: 'workspace-branch',
    state,
    persist: async (next: PiWorktreeLeaseStateV1) => { state = next },
    policy: {
      select: async ({ worktreeLeaseId }: { worktreeLeaseId: string }) => ({
        path: join(rig.worktreeRoot, worktreeLeaseId),
        branch: `nessy/agent/${worktreeLeaseId}`,
        baseSha: rig.baseSha,
      }),
    },
    git: gitPort(rig) as never,
  } as never)
  return { service, leases: () => state.leases }
}

describe('P6.547 the branch goes with the worktree, narrowly', () => {
  it('deletes a host-created branch that holds nothing its base does not', async () => {
    const rig = makeRig()
    const { service, leases } = makeService(rig)

    const lease = await service.acquire({ ownerAgentId: 'agent-1', worktreeLeaseId: 'lease-clean' })
    expect(rig.branchExists(lease.branch)).toBe(true)
    // Recorded at creation, which is the only moment the answer is certain.
    expect(leases()[0]!.branchCreated).toBe(true)

    const outcome = await service.release('lease-clean')

    expect(outcome?.branchDeleted).toBe(true)
    expect(rig.branchExists(lease.branch)).toBe(false)
    expect(existsSync(lease.path)).toBe(false)
  })

  it('keeps a branch holding its own commits, and says why — never -D', async () => {
    const rig = makeRig()
    const { service } = makeService(rig)

    const lease = await service.acquire({ ownerAgentId: 'agent-1', worktreeLeaseId: 'lease-commits' })
    writeFileSync(join(lease.path, 'work.txt'), 'work\n')
    rig.must(lease.path, '-C', lease.path, 'add', 'work.txt')
    rig.must(lease.path, '-C', lease.path, 'commit', '-m', 'work nobody else has')

    // `refuseIfHoldsWork` is the CLOSE-TIME question and would refuse this
    // removal outright, so the branch rule is measured on the unqualified
    // release the user reaches by answering "remove" to a worktree they know
    // holds commits.
    const outcome = await service.release('lease-commits')

    expect(outcome?.branchDeleted).toBe(false)
    // Git's own words, not ours: the refusal is the safety check.
    expect(outcome?.branchKeptReason).toContain('not fully merged')
    expect(rig.branchExists(lease.branch)).toBe(true)
    expect(existsSync(lease.path)).toBe(false)
  })

  it('never touches a branch that existed before the worktree', async () => {
    const rig = makeRig()
    const { service, leases } = makeService(rig)
    // The user's own branch, at the same name the policy will pick.
    rig.must(rig.repoRoot, '-C', rig.repoRoot, 'branch', 'nessy/agent/lease-preexisting', rig.baseSha)

    const lease = await service.acquire({ ownerAgentId: 'agent-1', worktreeLeaseId: 'lease-preexisting' })
    expect(leases()[0]!.branchCreated).toBeUndefined()

    const outcome = await service.release('lease-preexisting')

    expect(outcome?.branchDeleted).toBe(false)
    expect(outcome?.branchKeptReason).toContain('existed before')
    expect(rig.branchExists(lease.branch)).toBe(true)
  })
})

/**
 * P6.324 (a) — the identity screen at the CREATE door, against real git.
 *
 * The path screen answers whether a path is allowed to be a worktree of this
 * repository; it says nothing about what git thinks the directory already IS. A
 * target that exists and resolves back into the main checkout is not isolation
 * at all — a `git reset --hard` inside it acts on the user's real tree.
 */
describe('P6.324(a) the identity screen refuses a directory that is not its own worktree', () => {
  function serviceWithIdentity(rig: ReturnType<typeof makeRig>, targetPath: string) {
    let state: PiWorktreeLeaseStateV1 = { schemaVersion: 1, revision: 0, leases: [] }
    const port = gitPort(rig) as Record<string, unknown>
    port.identifyToplevel = async (path: string) => {
      if (!existsSync(path)) return null
      const run = rig.git(path, '-C', path, 'rev-parse', '--show-toplevel')
      return run.status === 0 && run.stdout.trim() ? run.stdout.trim() : null
    }
    const service = new WorktreeLeaseService({
      workspaceId: 'workspace-identity',
      state,
      persist: async (next: PiWorktreeLeaseStateV1) => { state = next },
      repoRoot: async () => rig.repoRoot,
      policy: {
        select: async ({ worktreeLeaseId }: { worktreeLeaseId: string }) => ({
          path: targetPath,
          branch: `nessy/agent/${worktreeLeaseId}`,
          baseSha: rig.baseSha,
        }),
      },
      git: port,
    } as never)
    return { service, leases: () => state.leases }
  }

  it('refuses a target that IS the main checkout, and leaves it on disk', async () => {
    const rig = makeRig()
    const { service, leases } = serviceWithIdentity(rig, rig.repoRoot)

    await expect(service.acquire({ ownerAgentId: 'agent-1', worktreeLeaseId: 'lease-main' }))
      .rejects.toThrow(/worktree-identity-refused: that directory is the repository itself/)

    // Left on disk and untouched — a refusal, never a cleanup.
    expect(existsSync(join(rig.repoRoot, 'seed.txt'))).toBe(true)
    // And no lease was recorded for it.
    expect(leases().some(lease => lease.worktreeLeaseId === 'lease-main')).toBe(false)
  })

  it('creates normally at a path that does not exist yet — the positive control', async () => {
    const rig = makeRig()
    const target = join(rig.worktreeRoot, 'fresh')
    const { service } = serviceWithIdentity(rig, target)

    const lease = await service.acquire({ ownerAgentId: 'agent-1', worktreeLeaseId: 'lease-fresh' })

    expect(lease.path).toBe(target)
    expect(existsSync(target)).toBe(true)
    // The probe answered `null` for a path that was not there, and the screen
    // is skipped rather than being asked a question with no answer.
  })
})
