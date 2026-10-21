import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWorktreeSettings } from '@nessy-agent/shared/config'
import {
  WORKTREE_NO_COMMIT_YET_PREFIX,
  explainWorktreeBaseFailure,
  mergeRequestFetchCommands,
  parseForgeMergeRequestRef,
  worktreeBaseShaCandidates,
  worktreeConfigCleanupCommands,
  parseWorktreeFilterDrivers,
  worktreeConfigProbeCommand,
  worktreeCreateCommands,
  worktreeFilterDriverProbeCommand,
  worktreeSymlinkPlan,
  type WorktreeGitCommand,
} from './worktree-git-plan'

const repoRoot = '/projects/app'
const worktreePath = '/projects/.nessy-worktrees/app/lease-1'

describe('worktree.baseRef reaches the base-commit resolution', () => {
  it('asks the remote first under the documented "fresh" default (no-freshness overload)', () => {
    expect(worktreeBaseShaCandidates(repoRoot, 'fresh')).toEqual([
      { operation: 'base-fresh', cwd: 'repo', args: ['-C', repoRoot, 'rev-parse', 'origin/HEAD'], allowFailure: true },
      { operation: 'base', cwd: 'repo', args: ['-C', repoRoot, 'rev-parse', 'HEAD'] },
    ])
  })

  it('asks only local HEAD under "head"', () => {
    expect(worktreeBaseShaCandidates(repoRoot, 'head')).toEqual([
      { operation: 'base', cwd: 'repo', args: ['-C', repoRoot, 'rev-parse', 'HEAD'] },
    ])
  })

  it('resolves the default from settings, not from a literal', () => {
    const { baseRef } = resolveWorktreeSettings([])
    expect(worktreeBaseShaCandidates(repoRoot, baseRef)[0]!.args).toContain('origin/HEAD')
  })
})

describe('the "fresh" freshness prelude (worktrees.md:128)', () => {
  const NOW = Date.parse('2026-08-06T12:00:00.000Z')
  const DAY_MS = 24 * 60 * 60 * 1000
  const fetchCommand: WorktreeGitCommand = {
    operation: 'base-fetch',
    cwd: 'repo',
    args: ['-C', repoRoot, 'fetch', '--no-tags', '--quiet', 'origin'],
    allowFailure: true,
    timeoutMs: 5_000,
  }
  const setHeadCommand: WorktreeGitCommand = {
    operation: 'base-set-head',
    cwd: 'repo',
    args: ['-C', repoRoot, 'remote', 'set-head', 'origin', '--auto'],
    allowFailure: true,
    timeoutMs: 5_000,
  }
  const resolveCandidates: WorktreeGitCommand[] = [
    { operation: 'base-fresh', cwd: 'repo', args: ['-C', repoRoot, 'rev-parse', 'origin/HEAD'], allowFailure: true },
    { operation: 'base', cwd: 'repo', args: ['-C', repoRoot, 'rev-parse', 'HEAD'] },
  ]

  const rows = [
    {
      name: 'fetched within 24 hours: no fetch command',
      freshness: { lastFetchedAtMs: NOW - DAY_MS + 1, nowMs: NOW, originHeadCached: true },
      expected: resolveCandidates,
    },
    {
      name: 'exactly 24 hours old: stale, fetch first with the 5s cap',
      freshness: { lastFetchedAtMs: NOW - DAY_MS, nowMs: NOW, originHeadCached: true },
      expected: [fetchCommand, ...resolveCandidates],
    },
    {
      name: 'no FETCH_HEAD (never fetched): treated as stale',
      freshness: { nowMs: NOW, originHeadCached: true },
      expected: [fetchCommand, ...resolveCandidates],
    },
    {
      name: 'origin/HEAD not cached: set-head recovery, still ahead of local HEAD',
      freshness: { lastFetchedAtMs: NOW - 1_000, nowMs: NOW, originHeadCached: false },
      expected: [setHeadCommand, ...resolveCandidates],
    },
    {
      name: 'stale AND uncached: fetch, then set-head, then the resolution pair',
      freshness: { nowMs: NOW, originHeadCached: false },
      expected: [fetchCommand, setHeadCommand, ...resolveCandidates],
    },
  ]

  for (const row of rows) {
    it(row.name, () => {
      expect(worktreeBaseShaCandidates(repoRoot, 'fresh', row.freshness)).toEqual(row.expected)
    })
  }

  it('"head" never fetches, even stale and uncached', () => {
    expect(worktreeBaseShaCandidates(repoRoot, 'head', { nowMs: NOW, originHeadCached: false })).toEqual([
      { operation: 'base', cwd: 'repo', args: ['-C', repoRoot, 'rev-parse', 'HEAD'] },
    ])
  })
})

// F1.904 — driven against REAL git, because the whole question is what git
// answers in a repository with no commit, and a scripted answer would only
// restate the fix. `run` mirrors `SessionManager.runWorktreeGit`: a command
// that does not tolerate failure throws `worktree-git-<operation>-failed:…`.
describe('a repository with no commit yet (F1.904)', () => {
  // The ceiling keeps git from finding a repository ABOVE the temp dir, so the
  // not-a-repository case means what it says wherever the runner's tmpdir is.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()) }
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe', env })
  const run = async (command: WorktreeGitCommand) => {
    const result = git(...command.args)
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (!command.allowFailure && result.exitCode !== 0) {
      throw new Error(`worktree-git-${command.operation}-failed:${output.trim()}`)
    }
    return { output, exitCode: result.exitCode }
  }
  // The same loop `SessionManager`'s `select` runs, with the same catch.
  const resolveBase = async (root: string) => {
    for (const candidate of worktreeBaseShaCandidates(root, 'fresh')) {
      const result = await run(candidate).catch(error => explainWorktreeBaseFailure(error, candidate.operation, root, run))
      if (result.exitCode === 0 && result.output.trim()) return result.output.trim()
    }
    return ''
  }
  const dirs: string[] = []
  const tempDir = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-worktree-base-')))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('refuses with a plain message that names the first commit, not git\'s "ambiguous argument"', async () => {
    const root = tempDir()
    expect(git('init', '--quiet', root).exitCode).toBe(0)
    const error = await resolveBase(root).then(() => undefined, (caught: unknown) => caught as Error)
    expect(error?.message).toStartWith(`${WORKTREE_NO_COMMIT_YET_PREFIX}: this repository has no commit yet`)
    expect(error?.message).toContain('Make a first commit')
    expect(error?.message).not.toContain('ambiguous argument')
  })

  // CONTROL — the same loop on a repository WITH a commit still answers its sha.
  it('resolves the base sha once the repository has a commit', async () => {
    const root = tempDir()
    expect(git('init', '--quiet', root).exitCode).toBe(0)
    const commit = git('-C', root, '-c', 'user.email=base@nessy.test', '-c', 'user.name=Base',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'first')
    expect(commit.exitCode).toBe(0)
    const head = git('-C', root, 'rev-parse', 'HEAD').stdout.toString().trim()
    expect(await resolveBase(root)).toBe(head)
  })

  // NEGATIVE — a failure that is NOT "no commit yet" keeps git's own message:
  // the probe exits 128 outside a repository and must not be read as empty.
  it('keeps git\'s own error for a directory that is not a repository', async () => {
    const root = tempDir()
    const error = await resolveBase(root).then(() => undefined, (caught: unknown) => caught as Error)
    expect(error?.message).toStartWith('worktree-git-base-failed:')
    expect(error?.message).not.toContain(WORKTREE_NO_COMMIT_YET_PREFIX)
  })
})

describe('extensions.worktreeConfig ownership probe and cleanup (large-codebases.md:245)', () => {
  it('probes with --local so a global value is never read as ours', () => {
    expect(worktreeConfigProbeCommand(repoRoot)).toEqual({
      operation: 'worktree-config-probe',
      cwd: 'repo',
      args: ['-C', repoRoot, 'config', '--local', '--get', 'extensions.worktreeConfig'],
      allowFailure: true,
    })
  })

  it('counts worktrees, then unsets --local, tolerating an already-absent key', () => {
    expect(worktreeConfigCleanupCommands(repoRoot)).toEqual([
      { operation: 'worktree-list', cwd: 'repo', args: ['-C', repoRoot, 'worktree', 'list', '--porcelain'] },
      {
        operation: 'worktree-config-unset',
        cwd: 'repo',
        args: ['-C', repoRoot, 'config', '--local', '--unset', 'extensions.worktreeConfig'],
        allowFailure: true,
      },
    ])
  })
})

describe('worktree.sparsePaths reaches worktree creation', () => {
  const base = { repoRoot, worktreePath, branch: 'nessy/session/lease-1', baseSha: 'abc123' }

  it('creates and checks out in one step with no sparse paths', () => {
    expect(worktreeCreateCommands({
      ...base,
      branchExists: false,
      settings: resolveWorktreeSettings([]),
    })).toEqual([
      {
        operation: 'create',
        cwd: 'repo',
        args: ['-C', repoRoot, 'worktree', 'add', '-b', 'nessy/session/lease-1', worktreePath, 'abc123'],
      },
    ])
  })

  it('reuses an existing branch without -b', () => {
    expect(worktreeCreateCommands({
      ...base,
      branchExists: true,
      settings: resolveWorktreeSettings([]),
    })[0]!.args).toEqual(['-C', repoRoot, 'worktree', 'add', worktreePath, 'nessy/session/lease-1'])
  })

  it('defers the checkout so the excluded files never land on disk', () => {
    const commands = worktreeCreateCommands({
      ...base,
      branchExists: false,
      settings: resolveWorktreeSettings([{ sparsePaths: ['packages/shared', 'docs'] }]),
    })

    expect(commands.map(command => command.operation)).toEqual(['create', 'sparse-set', 'sparse-checkout'])
    expect(commands[0]!.args).toContain('--no-checkout')
    expect(commands[1]!.args).toEqual([
      '-C', worktreePath, 'sparse-checkout', 'set', '--cone', 'packages/shared', 'docs',
    ])
    expect(commands[2]!.args).toEqual(['-C', worktreePath, 'checkout'])
  })
})

describe('worktree.symlinkDirectories reaches worktree creation', () => {
  it('links each entry from the main checkout into the worktree', () => {
    expect(worktreeSymlinkPlan({
      repoRoot,
      worktreePath,
      settings: resolveWorktreeSettings([{ symlinkDirectories: ['node_modules', '.cache/'] }]),
    })).toEqual([
      { target: `${repoRoot}/node_modules`, link: `${worktreePath}/node_modules` },
      { target: `${repoRoot}/.cache`, link: `${worktreePath}/.cache` },
    ])
  })

  it('plans nothing by default', () => {
    expect(worktreeSymlinkPlan({ repoRoot, worktreePath, settings: resolveWorktreeSettings([]) })).toEqual([])
  })
})

/**
 * P6.324 half (b) — a repository's own filter drivers do not run as shell
 * commands when we create a worktree.
 *
 * Measured on git 2.43.0 rather than argued: a repo whose `.gitattributes`
 * says `f.txt filter=evil` and whose LOCAL config sets `filter.evil.smudge`
 * to a shell command executes it on a plain `git worktree add`, and the
 * `-c filter.<name>.<key>=` form suppresses it while checking out the stored
 * bytes unchanged. `filter.evil.process` is a third binding that survived
 * clearing the other two, which is why three keys are cleared and not two.
 */
describe('a repository filter driver cannot run during worktree creation (P6.324)', () => {
  const base = { repoRoot, worktreePath, branch: 'nessy/session/lease-1', baseSha: 'abc123' }

  it('probes --local and by NAME only, tolerating the ordinary no-match exit', () => {
    expect(worktreeFilterDriverProbeCommand(repoRoot)).toEqual({
      operation: 'filter-driver-probe',
      cwd: 'repo',
      // --local: a driver in the user's GLOBAL config is their own git-lfs and
      // clearing it would hand them pointer files.
      // --name-only: the driver's COMMAND STRING never enters our argv or logs.
      args: ['-C', repoRoot, 'config', '--local', '--name-only', '--get-regexp', '^filter\\.'],
      allowFailure: true,
    })
  })

  it('reads driver names out of the real probe output, including one with a dot', () => {
    // The first block is verbatim `git config --local --name-only
    // --get-regexp '^filter\.'` output from the reproduction repo.
    expect(parseWorktreeFilterDrivers('filter.evil.smudge\nfilter.evil.clean\n')).toEqual(['evil'])
    // A git subsection name is arbitrary text, so the name is everything
    // between the FIRST and the LAST dot.
    expect(parseWorktreeFilterDrivers('filter.my.driver.process\n')).toEqual(['my.driver'])
    // `required` binds no command, but its driver name still counts: clearing
    // a key that is not set is inert, and the wider reading cannot under-cover.
    expect(parseWorktreeFilterDrivers('filter.lfs.required\nfilter.lfs.smudge\n')).toEqual(['lfs'])
    expect(parseWorktreeFilterDrivers('')).toEqual([])
    expect(parseWorktreeFilterDrivers('core.autocrlf\n')).toEqual([])
  })

  it('clears all THREE binding keys ahead of the add, and leaves the rest of the argv alone', () => {
    const commands = worktreeCreateCommands({
      ...base,
      branchExists: false,
      settings: resolveWorktreeSettings([]),
      filterDrivers: ['evil'],
    })
    expect(commands[0]!.args).toEqual([
      '-c', 'filter.evil.clean=',
      '-c', 'filter.evil.smudge=',
      // The one a two-key remedy would have left armed: measured to execute
      // under an add that cleared only smudge and clean.
      '-c', 'filter.evil.process=',
      '-C', repoRoot, 'worktree', 'add', '-b', 'nessy/session/lease-1', worktreePath, 'abc123',
    ])
  })

  it('covers the SPARSE half too, where the checkout is a separate command', () => {
    const commands = worktreeCreateCommands({
      ...base,
      branchExists: false,
      settings: resolveWorktreeSettings([{ sparsePaths: ['docs'] }]),
      filterDrivers: ['evil'],
    })
    // Suppressing on the add alone would protect only the non-sparse half:
    // with sparsePaths the add carries --no-checkout and the driver would run
    // here instead.
    expect(commands[2]!.args).toEqual([
      '-c', 'filter.evil.clean=', '-c', 'filter.evil.smudge=', '-c', 'filter.evil.process=',
      '-C', worktreePath, 'checkout',
    ])
  })

  it('CONTROL — a repository with no driver spawns a byte-identical command', () => {
    const withoutField = worktreeCreateCommands({
      ...base, branchExists: false, settings: resolveWorktreeSettings([]),
    })
    const withEmpty = worktreeCreateCommands({
      ...base, branchExists: false, settings: resolveWorktreeSettings([]), filterDrivers: [],
    })
    expect(withEmpty).toEqual(withoutField)
  })
})

/**
 * P6.337 (measure) — what base a reopened worktree of the same name lands on,
 * in each of the five states `worktrees.md#reuse-a-worktree-name` documents.
 *
 * **Answer: the reset is ABSENT in all five, and it is absent BY CONSTRUCTION
 * rather than by omission.** Two findings, both measured at HEAD:
 *
 * 1. The page's flow — *"Passing `--worktree` a name whose directory already
 *    exists opens that existing worktree"* — has no analogue here. A worktree's
 *    path and branch are minted from a lease id, never from a user-chosen name
 *    (`SessionManager`'s selection policy returns
 *    `join(namespaceRoot, worktreeLeaseId)` and `nessy/<agent>/<leaseId>`), and
 *    `WorktreeLeaseService.acquire` throws `worktree-id-reused` /
 *    `worktree-collision` on a live id, path or branch. So for an interactive
 *    session there is nothing to reuse.
 * 2. There IS one reuse path, and the row's rig would have missed it: a
 *    subagent's lease id is DETERMINISTIC (`worktree-<agentId>`), so the same
 *    agent in a later session asks for the same path and branch. That is the
 *    real "same name" case here, and it takes the `branchExists` branch below.
 *
 * Measured on git 2.43.0 against state 1 — the one state the page says SHOULD
 * reset (clean, unmoved, no commits of its own): a worktree created at `main`,
 * released by removing its directory while its branch survived, then reopened
 * with `git worktree add <path> <branch>` after `main` advanced, landed on the
 * OLD tip and not on the default branch. And with the directory still present
 * the reopen does not happen at all — git refuses with *"already exists"*.
 *
 * Recorded rather than built: implementing the reset would need the three
 * probes the page's conditions read (`status --porcelain`, `branch
 * --show-current`, `merge-base --is-ancestor`) on the CREATION path, and they
 * exist only in `inspect`.
 */
describe('a reopened worktree lands on its old tip in every documented state (P6.337)', () => {
  const base = { repoRoot, worktreePath, branch: 'nessy/a/w1', baseSha: 'oldtip' }

  it('the reopen plan is one command and it names the BRANCH, never a base', () => {
    const commands = worktreeCreateCommands({ ...base, branchExists: true, settings: resolveWorktreeSettings([]) })
    expect(commands).toHaveLength(1)
    expect(commands[0]!.args).toEqual(['-C', repoRoot, 'worktree', 'add', worktreePath, 'nessy/a/w1'])
    // `git worktree add <path> <branch>` checks out that branch's tip. The
    // base sha is not passed at all on this branch, so no state could change
    // which commit is landed on.
    expect(commands[0]!.args).not.toContain('oldtip')
  })

  it('and no state can change it, because the plan is not given one', () => {
    // The five documented states differ in worktree cleanliness, current
    // branch, own commits, remote-branch existence and baseRef. Only the last
    // is even an input here, and it does not reach the reopen branch: every
    // baseRef produces the identical command.
    for (const baseRef of ['fresh', 'head'] as const) {
      const commands = worktreeCreateCommands({
        ...base,
        branchExists: true,
        settings: resolveWorktreeSettings([{ baseRef }]),
      })
      expect({ baseRef, args: commands[0]!.args })
        .toEqual({ baseRef, args: ['-C', repoRoot, 'worktree', 'add', worktreePath, 'nessy/a/w1'] })
    }
  })

  it('no command in the whole creation plan could reset a worktree', () => {
    // The absence claim, over the plan the runner actually executes, with the
    // sparse variant included so the longest plan is covered too.
    for (const settings of [resolveWorktreeSettings([]), resolveWorktreeSettings([{ sparsePaths: ['docs'] }])]) {
      for (const branchExists of [true, false]) {
        for (const command of worktreeCreateCommands({ ...base, branchExists, settings })) {
          expect(command.args).not.toContain('reset')
          // The three probes the page's reset conditions read are not here
          // either — they live in `inspect`, which the creation path never calls.
          expect(command.args).not.toContain('--porcelain')
          expect(command.args).not.toContain('merge-base')
        }
      }
    }
  })
})

/**
 * P6.335 — a worktree branched from a merge request.
 *
 * NATIVE, and this is the whole of why the row is host-side rather than forge
 * integration: git supplies it. Gitlab publishes a merge request's head at
 * `refs/merge-requests/<n>/head` and github publishes a pull request's at
 * `refs/pull/<n>/head`; both fetch from `origin`, and neither needs an API
 * token — so no forge credential appears anywhere in this plan.
 */
describe('P6.335 · parseForgeMergeRequestRef', () => {
  it('recognises a gitlab merge request, with and without the `/-/` separator', () => {
    expect(parseForgeMergeRequestRef('https://gitlab.example.com/group/app/-/merge_requests/12'))
      .toEqual({ forge: 'gitlab', number: 12, label: '!12' })
    // The bare spelling predates gitlab 11.11 and every old link still carries
    // it, so both are live.
    expect(parseForgeMergeRequestRef('https://gitlab.example.com/group/app/merge_requests/7'))
      .toEqual({ forge: 'gitlab', number: 7, label: '!7' })
    // A trailing segment (`/diffs`, `/commits`) is what a person actually
    // copies out of the browser.
    expect(parseForgeMergeRequestRef('https://gitlab.example.com/g/a/-/merge_requests/3/diffs'))
      .toEqual({ forge: 'gitlab', number: 3, label: '!3' })
  })

  it('recognises a github pull request and labels it with a hash', () => {
    expect(parseForgeMergeRequestRef('https://github.com/owner/repo/pull/42'))
      .toEqual({ forge: 'github', number: 42, label: '#42' })
    expect(parseForgeMergeRequestRef('https://github.example.corp/owner/repo/pull/9/files'))
      .toEqual({ forge: 'github', number: 9, label: '#9' })
  })

  // Detection is by PATH SEGMENT, never by host: a host allowlist would work
  // for exactly two companies and fail for every self-hosted install.
  it('does not read the host, only the path', () => {
    expect(parseForgeMergeRequestRef('https://git.internal.example/team/svc/-/merge_requests/5')?.forge)
      .toBe('gitlab')
    expect(parseForgeMergeRequestRef('https://scm.internal.example/team/svc/pull/5')?.forge)
      .toBe('github')
  })

  // NEGATIVE — anything unrecognised answers null so the caller can REFUSE.
  // Falling through to the default base would be "ran anyway, somewhere else".
  it('answers null for anything that is not a merge or pull request URL', () => {
    for (const value of [
      '',
      'not a url',
      'gitlab.example.com/g/a/-/merge_requests/12',
      'https://gitlab.example.com/group/app',
      'https://gitlab.example.com/group/app/-/issues/12',
      'https://github.com/owner/repo/pulls',
      'https://github.com/owner/repo/pull/abc',
      'https://gitlab.example.com/g/a/-/merge_requests/0',
      'ssh://git@gitlab.example.com/g/a/-/merge_requests/12',
    ]) {
      expect(parseForgeMergeRequestRef(value), value).toBeNull()
    }
  })
})

describe('P6.335 · mergeRequestFetchCommands', () => {
  it('fetches the gitlab and github namespaces and reads FETCH_HEAD after each', () => {
    const gitlab = mergeRequestFetchCommands('/repo', { forge: 'gitlab', number: 12, label: '!12' })
    expect(gitlab.map(command => command.args)).toEqual([
      ['-C', '/repo', 'fetch', '--no-tags', '--quiet', 'origin', 'merge-requests/12/head'],
      ['-C', '/repo', 'rev-parse', 'FETCH_HEAD'],
    ])
    const github = mergeRequestFetchCommands('/repo', { forge: 'github', number: 12, label: '#12' })
    expect(github[0]!.args.at(-1)).toBe('pull/12/head')
  })

  // NEGATIVE — neither command tolerates failure, unlike the base-ref
  // candidates beside them: those degrade to local HEAD and this has nothing to
  // degrade to.
  it('tolerates no failure, and runs in the repository', () => {
    for (const command of mergeRequestFetchCommands('/repo', { forge: 'gitlab', number: 1, label: '!1' })) {
      expect(command.allowFailure, command.operation).toBeUndefined()
      expect(command.cwd).toBe('repo')
    }
  })
})
