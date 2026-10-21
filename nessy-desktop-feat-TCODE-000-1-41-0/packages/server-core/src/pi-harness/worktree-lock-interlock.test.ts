import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PiWorktreeLeaseStateV1, PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'

import {
  currentWorktreeLockOwner,
  parseWorktreeListLocks,
  parseWorktreeLockReason,
  worktreeLockOwnerIsAlive,
  worktreeLockReason,
  WorktreeLeaseService,
  type WorktreeListLock,
  type WorktreeLockOwner,
} from './worktree-lease-service.ts'

/**
 * P3.312 — `git worktree lock` as the cross-process interlock, against REAL git.
 *
 * `worktrees.md#clean-up-subagent-and-background-session-worktrees` (anchor
 * verified on the rendered page): *"While an agent is running, Claude Code
 * holds a `git worktree lock` on its worktree so that concurrent cleanup can't
 * remove it, and releases the lock when the agent finishes"*, *"The sweep also
 * releases a lock Claude Code set for a session whose process has exited"*, and
 * *"The sweep never releases a lock you set yourself with `git worktree lock`"*.
 *
 * Real git rather than a fake, for one reason: the property being claimed is
 * that GIT enforces the interlock, not that this code remembers to. A stub
 * `remove` that resolves would pass every assertion here while the real one
 * exits 128 — and the failure direction of this whole row is DESTRUCTIVE, so
 * the sweep is only ever driven against a repository this test created under
 * `mkdtemp`.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.now()
const CUTOFF = NOW - (30 * DAY_MS)
const OLD = new Date(NOW - (90 * DAY_MS)).toISOString()

const roots: string[] = []

afterEach(() => {
  // Every root is one this test made with mkdtemp; nothing else is ever removed.
  while (roots.length > 0) {
    const root = roots.pop()!
    rmSync(root, { recursive: true, force: true })
  }
})

interface Rig {
  root: string
  repoRoot: string
  worktreeRoot: string
  baseSha: string
  git(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string }
  porcelain(): string
  lockOf(path: string): WorktreeListLock | undefined
}

function makeRig(): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-worktree-lock-')))
  roots.push(root)
  const repoRoot = join(root, 'repo')
  const worktreeRoot = join(root, 'worktrees')
  const scratch = join(root, 'home')
  for (const path of [repoRoot, worktreeRoot, scratch]) mkdirSync(path, { recursive: true })

  const git = (cwd: string, ...args: string[]) => {
    // The developer's own git config must not be read, and certainly not written.
    const run = Bun.spawnSync(['git', '-c', 'user.email=lock@nessy.test', '-c', 'user.name=Lock', ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: scratch },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      status: run.exitCode,
      stdout: run.stdout?.toString() ?? '',
      stderr: run.stderr?.toString() ?? '',
    }
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

  const porcelain = () => must(repoRoot, '-C', repoRoot, 'worktree', 'list', '--porcelain').stdout
  const resolve = (path: string) => { try { return realpathSync(path) } catch { return path } }
  const lockOf = (path: string) => {
    const wanted = resolve(path)
    return parseWorktreeListLocks(porcelain()).find(entry => resolve(entry.path) === wanted)
  }
  return { root, repoRoot, worktreeRoot, baseSha, git, porcelain, lockOf }
}

/** The git port SessionManager supplies in production, built against the rig. */
function gitPort(rig: Rig, options: { withLockPorts?: boolean; lockStateThrows?: boolean } = {}) {
  const calls: string[] = []
  const resolve = (path: string) => { try { return realpathSync(path) } catch { return path } }
  const base = {
    create: async (lease: PiWorktreeLeaseV1) => {
      calls.push(`create:${lease.worktreeLeaseId}`)
      const run = rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'add', '-b', lease.branch, lease.path, lease.baseSha)
      if (run.status !== 0) throw new Error(run.stderr)
    },
    inspect: async (lease: PiWorktreeLeaseV1) => {
      if (!existsSync(lease.path)) return { exists: false, dirty: false, branch: '', baseSha: '' }
      const status = rig.git(lease.path, '-C', lease.path, 'status', '--porcelain')
      const branch = rig.git(lease.path, '-C', lease.path, 'branch', '--show-current')
      const head = rig.git(lease.path, '-C', lease.path, 'rev-parse', 'HEAD')
      const headSha = head.stdout.trim()
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
      calls.push(`remove:${lease.worktreeLeaseId}`)
      // No `--force`, exactly as production: git's refusal of a locked
      // worktree IS the interlock, so swallowing it here would delete the
      // property under test.
      const run = rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'remove', lease.path)
      if (run.status !== 0) throw new Error(run.stderr)
    },
  }
  if (options.withLockPorts === false) return { git: base, calls }
  return {
    git: {
      ...base,
      lockState: async (lease: PiWorktreeLeaseV1) => {
        calls.push(`lockState:${lease.worktreeLeaseId}`)
        if (options.lockStateThrows === true) throw new Error('git unavailable')
        const wanted = resolve(lease.path)
        const entry = parseWorktreeListLocks(rig.porcelain()).find(value => resolve(value.path) === wanted)
        return entry === undefined
          ? { locked: false }
          : { locked: entry.locked, ...(entry.lockReason === undefined ? {} : { reason: entry.lockReason }) }
      },
      lock: async (lease: PiWorktreeLeaseV1, reason: string) => {
        calls.push(`lock:${lease.worktreeLeaseId}`)
        const run = rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', '--reason', reason, lease.path)
        if (run.status !== 0) throw new Error(run.stderr)
      },
      unlock: async (lease: PiWorktreeLeaseV1) => {
        calls.push(`unlock:${lease.worktreeLeaseId}`)
        const run = rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'unlock', lease.path)
        if (run.status !== 0) throw new Error(run.stderr)
      },
    },
    calls,
  }
}

function build(rig: Rig, options: {
  leases?: PiWorktreeLeaseV1[]
  withLockPorts?: boolean
  lockStateThrows?: boolean
  lockOwner?: () => WorktreeLockOwner
  lockOwnerAlive?: (owner: WorktreeLockOwner) => boolean
} = {}) {
  const port = gitPort(rig, {
    ...(options.withLockPorts === undefined ? {} : { withLockPorts: options.withLockPorts }),
    ...(options.lockStateThrows === undefined ? {} : { lockStateThrows: options.lockStateThrows }),
  })
  const initialState: PiWorktreeLeaseStateV1 = {
    schemaVersion: 1,
    revision: 1,
    leases: options.leases ?? [],
  }
  let persisted = initialState
  const service = new WorktreeLeaseService({
    workspaceId: 'ws-lock',
    initialState,
    persist: async state => { persisted = state },
    policy: {
      select: async input => ({
        path: join(rig.worktreeRoot, input.worktreeLeaseId),
        branch: `nessy/agent/${input.worktreeLeaseId}`,
        baseSha: rig.baseSha,
      }),
    },
    git: port.git,
    repoRoot: () => rig.repoRoot,
    ...(options.lockOwner === undefined ? {} : { lockOwner: options.lockOwner }),
    ...(options.lockOwnerAlive === undefined ? {} : { lockOwnerAlive: options.lockOwnerAlive }),
  })
  return { service, calls: port.calls, state: () => persisted }
}

/** A lease for a worktree the rig has already created on disk. */
function seed(rig: Rig, id: string, lastUsedAt = OLD): PiWorktreeLeaseV1 {
  const path = join(rig.worktreeRoot, id)
  const branch = `nessy/agent/${id}`
  const run = rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'add', '-b', branch, path, rig.baseSha)
  if (run.status !== 0) throw new Error(run.stderr)
  return {
    schemaVersion: 1,
    worktreeLeaseId: id,
    workspaceId: 'ws-lock',
    ownerAgentId: `agent-${id}`,
    path,
    branch,
    baseSha: rig.baseSha,
    status: 'active',
    lastUsedAt,
  }
}

describe('the lock reason, which carries what git will not', () => {
  it('round-trips the owner it names', () => {
    const owner: WorktreeLockOwner = { pid: 4242, host: 'box-1' }
    const reason = worktreeLockReason({ owner, worktreeLeaseId: 'lease-a' })
    expect(reason).toContain('lease=lease-a')
    expect(parseWorktreeLockReason(reason)).toEqual(owner)
  })

  it('reads anything else as somebody else lock — the never-release rule', () => {
    // A hand-set `git worktree lock` writes an EMPTY reason file, and porcelain
    // then prints a bare `locked` line, so `undefined` is the common case.
    for (const reason of [
      undefined,
      '',
      'my own lock',
      'nessy-agent worktree lease=x pid=abc host=box',
      'nessy-agent worktree lease=x pid=0 host=box',
      'nessy-agent worktree lease=x pid=12',
      'nessy-agent-other worktree lease=x pid=12 host=box',
    ]) {
      expect(parseWorktreeLockReason(reason)).toBeUndefined()
    }
  })

  it('answers alive for every uncertainty, because dead is the destructive answer', () => {
    expect(worktreeLockOwnerIsAlive({ pid: process.pid, host: hostname() })).toBe(true)
    expect(worktreeLockOwnerIsAlive({ pid: process.pid, host: 'some-other-machine' })).toBe(true)
    expect(worktreeLockOwnerIsAlive({ pid: -1, host: hostname() })).toBe(true)
    // A pid this high is not allocatable on any supported platform.
    expect(worktreeLockOwnerIsAlive({ pid: 4_294_967_294, host: hostname() })).toBe(false)
  })

  it('parses the porcelain lock lines real git emits, reason and none', () => {
    const rig = makeRig()
    const withReason = seed(rig, 'reasoned')
    const bare = seed(rig, 'bare')
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', '--reason', 'nessy-agent worktree lease=reasoned pid=7 host=h', withReason.path)
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', bare.path)

    expect(rig.lockOf(withReason.path)).toEqual({
      path: expect.any(String),
      locked: true,
      lockReason: 'nessy-agent worktree lease=reasoned pid=7 host=h',
    })
    expect(rig.lockOf(bare.path)).toEqual({ path: expect.any(String), locked: true })
    expect(rig.lockOf(rig.repoRoot)).toEqual({ path: expect.any(String), locked: false })
  })
})

describe('acquire, release and recover hold git own lock', () => {
  it('locks the worktree at creation and unlocks it on release', async () => {
    const rig = makeRig()
    const { service, calls } = build(rig)

    const lease = await service.acquire({ ownerAgentId: 'agent-1', worktreeLeaseId: 'lease-live' })

    const held = rig.lockOf(lease.path)
    expect(held?.locked).toBe(true)
    expect(parseWorktreeLockReason(held?.lockReason)).toEqual(currentWorktreeLockOwner())
    // The lock goes on before the setup script would run, i.e. immediately
    // after create.
    expect(calls.indexOf('lock:lease-live')).toBe(calls.indexOf('create:lease-live') + 1)

    await service.release('lease-live')

    expect(existsSync(lease.path)).toBe(false)
    expect(rig.lockOf(lease.path)).toBeUndefined()
    expect(service.list()).toEqual([])
  })

  it('locks a worktree recover had to re-create, which carried no lock at all', async () => {
    const rig = makeRig()
    // Crashed between `git.create` and the `active` commit, and the directory
    // never made it to disk: the lease is `creating` and recovery re-creates it.
    const lease: PiWorktreeLeaseV1 = {
      schemaVersion: 1,
      worktreeLeaseId: 'lease-half-made',
      workspaceId: 'ws-lock',
      ownerAgentId: 'agent-half',
      path: join(rig.worktreeRoot, 'lease-half-made'),
      branch: 'nessy/agent/lease-half-made',
      baseSha: rig.baseSha,
      status: 'creating',
      lastUsedAt: OLD,
    }
    const { service } = build(rig, { leases: [lease] })

    const recovered = await service.recover()

    expect(recovered.map(value => value.status)).toEqual(['active'])
    expect(existsSync(lease.path)).toBe(true)
    expect(parseWorktreeLockReason(rig.lockOf(lease.path)?.lockReason)).toEqual(currentWorktreeLockOwner())
  })

  it('re-stamps a stale lock on recover, so another process sweep does not read a dead pid', async () => {
    const rig = makeRig()
    const lease = seed(rig, 'lease-crashed')
    // The lock a previous run left behind, naming a process that is gone.
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', '--reason',
      worktreeLockReason({ owner: { pid: 4_294_967_294, host: hostname() }, worktreeLeaseId: 'lease-crashed' }),
      lease.path)
    const { service } = build(rig, { leases: [lease] })

    await service.recover()

    expect(parseWorktreeLockReason(rig.lockOf(lease.path)?.lockReason)).toEqual(currentWorktreeLockOwner())
  })
})

describe('the sweep, against real git', () => {
  it('POSITIVE CONTROL — a worktree locked by a live process survives the sweep', async () => {
    const rig = makeRig()
    const lease = seed(rig, 'lease-other-process')
    const other: WorktreeLockOwner = { pid: 999_001, host: hostname() }
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', '--reason',
      worktreeLockReason({ owner: other, worktreeLeaseId: 'lease-other-process' }), lease.path)
    const { service, calls } = build(rig, {
      leases: [lease],
      // Another window, a headless server or a CDP rig: a live process this
      // ledger cannot see. Its liveness is the only thing stubbed.
      lockOwnerAlive: owner => owner.pid === other.pid,
    })

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed).toEqual([])
    expect(result.skipped).toEqual([{
      worktreeLeaseId: 'lease-other-process', path: lease.path, branch: lease.branch, reason: 'locked',
    }])
    expect(existsSync(lease.path)).toBe(true)
    expect(rig.lockOf(lease.path)?.locked).toBe(true)
    expect(service.list()).toHaveLength(1)
    expect(calls).not.toContain('remove:lease-other-process')
    expect(calls).not.toContain('unlock:lease-other-process')
  })

  it("P6.136 — a FOREIGN lease locked by a live process survives too, against real git", async () => {
    // The row's own control, on the arm that decides whether the widened
    // candidate set can be trusted: the lock is git's answer rather than one
    // process's, and it is asked of somebody else's lease exactly as it is asked
    // of ours. The lease is offered through `foreignLeases` and this service's
    // ledger never holds it.
    const rig = makeRig()
    const lease = seed(rig, 'lease-foreign-live')
    const other: WorktreeLockOwner = { pid: 999_003, host: hostname() }
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', '--reason',
      worktreeLockReason({ owner: other, worktreeLeaseId: 'lease-foreign-live' }), lease.path)
    const { service, calls } = build(rig, {
      leases: [],
      lockOwnerAlive: owner => owner.pid === other.pid,
    })

    const result = await service.sweepOrphans({
      cutoffMs: CUTOFF, liveLeaseIds: [], foreignLeases: [lease],
    })

    expect(result.removed).toEqual([])
    expect(result.skipped).toEqual([{
      worktreeLeaseId: 'lease-foreign-live', path: lease.path, branch: lease.branch, reason: 'locked',
    }])
    expect(existsSync(lease.path)).toBe(true)
    expect(rig.lockOf(lease.path)?.locked).toBe(true)
    expect(calls).not.toContain('remove:lease-foreign-live')
    expect(calls).not.toContain('unlock:lease-foreign-live')
  })

  it("P6.136 — a FOREIGN lease whose locking process has exited is swept, and our ledger stays empty", async () => {
    // The positive half, against real git: the leaked worktree of a scheduled
    // task's earlier run is finally reclaimed. The ledger assertion is the part
    // that separates this from a normal sweep — the record belongs to another
    // session's file and this pass must not write ours.
    const rig = makeRig()
    const lease = seed(rig, 'lease-foreign-dead')
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', '--reason',
      worktreeLockReason({ owner: { pid: 999_004, host: hostname() }, worktreeLeaseId: 'lease-foreign-dead' }), lease.path)
    const { service } = build(rig, { leases: [], lockOwnerAlive: () => false })

    const planned = await service.sweepOrphans({
      cutoffMs: CUTOFF, liveLeaseIds: [], foreignLeases: [lease], dryRun: true,
    })
    expect(planned.removed.map(entry => entry.worktreeLeaseId)).toEqual(['lease-foreign-dead'])

    const result = await service.sweepOrphans({
      cutoffMs: CUTOFF, liveLeaseIds: [], foreignLeases: [lease],
    })

    expect(result.removed.map(entry => entry.worktreeLeaseId)).toEqual(['lease-foreign-dead'])
    expect(result.skipped).toEqual([])
    expect(existsSync(lease.path)).toBe(false)
    expect(service.list()).toEqual([])
  })

  it('NEGATIVE — a worktree whose locking process has exited is unlocked and swept', async () => {
    const rig = makeRig()
    const lease = seed(rig, 'lease-killed')
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', '--reason',
      worktreeLockReason({ owner: { pid: 999_002, host: hostname() }, worktreeLeaseId: 'lease-killed' }), lease.path)
    const { service, calls } = build(rig, { leases: [lease], lockOwnerAlive: () => false })

    const planned = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [], dryRun: true })
    // The dry run has to report it, or the call site — which returns early on an
    // empty dry-run set — never runs the real pass. And it must not unlock.
    expect(planned.removed.map(entry => entry.worktreeLeaseId)).toEqual(['lease-killed'])
    expect(rig.lockOf(lease.path)?.locked).toBe(true)

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed.map(entry => entry.worktreeLeaseId)).toEqual(['lease-killed'])
    expect(result.skipped).toEqual([])
    expect(existsSync(lease.path)).toBe(false)
    expect(service.list()).toEqual([])
    expect(calls).toContain('unlock:lease-killed')
  })

  it('NEGATIVE — an unlocked orphan is swept exactly as before this row', async () => {
    const rig = makeRig()
    const lease = seed(rig, 'lease-unlocked')
    const { service } = build(rig, { leases: [lease] })

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed.map(entry => entry.worktreeLeaseId)).toEqual(['lease-unlocked'])
    expect(existsSync(lease.path)).toBe(false)
  })

  it('never releases a lock the user set themselves, whatever the age', async () => {
    const rig = makeRig()
    const lease = seed(rig, 'lease-user-locked')
    // A hand-set lock: no reason at all, which is what `git worktree lock`
    // writes without `--reason`.
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', lease.path)
    const { service, calls } = build(rig, { leases: [lease] })

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed).toEqual([])
    expect(result.skipped.map(skip => skip.reason)).toEqual(['locked-elsewhere'])
    expect(existsSync(lease.path)).toBe(true)
    expect(rig.lockOf(lease.path)?.locked).toBe(true)
    expect(calls).not.toContain('unlock:lease-user-locked')
  })

  it('is enforced by GIT, not by this code: an explicit release of a foreign-locked worktree fails', async () => {
    const rig = makeRig()
    const lease = seed(rig, 'lease-foreign')
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', '--reason', 'mine, hands off', lease.path)
    const { service } = build(rig, { leases: [lease] })

    await expect(service.release('lease-foreign')).rejects.toMatchObject({
      residuals: [{ resourceType: 'worktree', resourceId: 'lease-foreign', code: 'worktree-remove-failed' }],
    })
    expect(existsSync(lease.path)).toBe(true)
    expect(service.list()).toHaveLength(1)
  })

  it('keeps a worktree whose lock state cannot be read — unreadable is not unlocked', async () => {
    const rig = makeRig()
    const lease = seed(rig, 'lease-unreadable')
    const { service, calls } = build(rig, { leases: [lease], lockStateThrows: true })

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed).toEqual([])
    expect(result.skipped.map(skip => skip.reason)).toEqual(['locked'])
    expect(existsSync(lease.path)).toBe(true)
    expect(calls).not.toContain('remove:lease-unreadable')
  })

  it('is byte-identical to before this row when the host supplies no lock ports', async () => {
    const rig = makeRig()
    const lease = seed(rig, 'lease-no-ports')
    const { service, calls } = build(rig, { leases: [lease], withLockPorts: false })

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed.map(entry => entry.worktreeLeaseId)).toEqual(['lease-no-ports'])
    expect(existsSync(lease.path)).toBe(false)
    expect(calls.filter(call => call.startsWith('lock'))).toEqual([])
  })

  it('P6.21 GUARD — our own pid lock does not stop the vanished-directory reclaim, and the admin dir stays prunable', async () => {
    const rig = makeRig()
    const lease = seed(rig, 'lease-vanished')
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'lock', '--reason',
      worktreeLockReason({ owner: currentWorktreeLockOwner(), worktreeLeaseId: 'lease-vanished' }), lease.path)
    // The user cleaned up the directory by hand; the lease record is the orphan.
    rmSync(lease.path, { recursive: true, force: true })
    const { service } = build(rig, { leases: [lease] })

    const result = await service.sweepOrphans({ cutoffMs: CUTOFF, liveLeaseIds: [] })

    expect(result.removed.map(entry => entry.worktreeLeaseId)).toEqual(['lease-vanished'])
    expect(service.list()).toEqual([])
    // A LOCKED stale entry is not prunable (measured: `prune -v` leaves it), so
    // keeping the lock here would trade a leaked worktree for a leaked admin
    // directory nothing in this app ever prunes.
    expect(rig.lockOf(lease.path)?.locked ?? false).toBe(false)
    rig.git(rig.repoRoot, '-C', rig.repoRoot, 'worktree', 'prune')
    expect(rig.lockOf(lease.path)).toBeUndefined()
  })
})
