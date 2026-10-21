/**
 * Tests for `check-typecheck-coverage.ts` — P3.253, and the twin of
 * `check-eslint-coverage.test.ts` down to the method: each case builds a
 * synthetic repo in a temp directory, copies the REAL script into its
 * `scripts/` (the script derives its repo root from its own location, so no
 * argument and no double is needed), and asserts on the process exit code and
 * stderr.
 *
 * ## Why this file exists at all, which is the row's finding rather than a
 * housekeeping note
 *
 * The `packages/codex-protocol` exclusion carried the clause "every reference to
 * them in this tree is a comment" long enough to be measured false at 25
 * non-comment references, and its staleness guard could not notice — all three
 * of its checks asked about the excluded PACKAGE (a tsconfig, a `typecheck`
 * script, tests inside it) while the reason rested on claims about the REST of
 * the tree. P3.253 widened the guard to read the two things the reason names as
 * SUBSTITUTES for the typecheck: `lint:codex-protocol` running inside
 * `lint:chain`, and two suites that parse two generated files as source text.
 *
 * A widened guard nobody pins is one deletion away from gone, and the guard
 * cannot pin itself: delete its own branches and the checker still exits 0. So
 * every new branch gets a case here, and the positive case is on the same rig so
 * "the script always fails" cannot pass.
 *
 * The synthetic repo mirrors only what the real EXCLUSIONS and UNMAPPED_SURFACES
 * tables NAME — `packages/codex-protocol`, `apps/ios` — plus one chained package
 * to stand in for `packages/shared`, which is where both drift ties live, and
 * `apps/viewer`/`apps/webui`, which since P6.738 are CHAINED rather than excluded
 * and stand here for the reachability guard that replaced their exclusion.
 * Anything more would be a second copy of the repo layout, drifting on its own
 * schedule.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REPO_ROOT,
  SKIPPED_DIRS,
  findTestFiles,
  findTsconfigs,
  findWorkingTreeTestFiles,
} from './check-typecheck-coverage.ts'

/**
 * An explicit budget, set against the MEASURED floor rather than bun's 5 s
 * default — the treatment `…specs/2026-07-29-known-failing-tests.md` §(c) asks
 * the owner of such a file to apply.
 *
 * EVERY case here spawns a cold `bun` that compiles this 1 200-line script and
 * then walks a synthetic tree, and that spawn is the whole cost. Measured
 * 2026-09-08 with six sibling lanes on the box: one spawn against a synthetic
 * repo took **8.83 s** on the HEAD script and **9.71 s** on the P6.738 one, at
 * load 7.95 and 9.4 — the same cost, so the overrun is the spawn and not this
 * row's change. The real repo is worse: `bun scripts/check-typecheck-coverage.ts`
 * took **24.06 s wall for 0.06 s user and 0.20 s sys, 1 % cpu**, which is the
 * I/O-bound signature AGENTS.md §Traps names — read `user`/`sys` beside the wall
 * time before calling a slow run contention. Without a budget the whole file
 * fails as 18 timeouts with ZERO assertion failures, which reads exactly like a
 * broken guard and is not one.
 *
 * 180 s per case, three worst observed spawns wide. Never zero, never the
 * global default raised.
 */
setDefaultTimeout(180_000)

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-typecheck-coverage.ts')

const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/** The two ties the real `CODEX_PROTOCOL_DRIFT_TIES` names, and the spelling each must contain. */
const TIES = [
  {
    suite: 'packages/shared/src/automations/runtime-hook-events.test.ts',
    generated: 'packages/codex-protocol/generated/v2/HookEventName.ts',
    spelling: 'packages/codex-protocol/generated/v2/HookEventName.ts',
  },
  {
    suite: 'packages/shared/src/agent/__tests__/codex-config-requirements.test.ts',
    generated: 'packages/codex-protocol/generated/v2/ConfigRequirements.ts',
    spelling: 'codex-protocol/generated/v2/ConfigRequirements.ts',
  },
] as const

interface RepoOptions {
  /** Root `scripts`, merged over the healthy defaults; `null` deletes a key. */
  scripts?: Record<string, string | null>
  /** Tie suites to leave out of the tree entirely. */
  omitSuites?: readonly string[]
  /** Tie suites to write WITHOUT the spelling they are named for. */
  blankSuites?: readonly string[]
  /** Generated files to leave out of the tree entirely. */
  omitGenerated?: readonly string[]
  /** Write `packages/codex-protocol/src/probe.ts`. */
  withCodexProtocolSrc?: boolean
  /** Write AGENTS.md WITHOUT an `apps/ios` bullet in its Monorepo Map (P2.370). */
  omitIosMapEntry?: boolean
  /** Write .gitlab-ci.yml WITHOUT the `build-ios` job (P2.370). */
  omitIosCiJob?: boolean
  /** F1.564 — extra files, written after the healthy tree. */
  files?: Record<string, string>
  /** F1.564 — the rig's `.gitignore`, one pattern per entry. */
  gitignore?: readonly string[]
  /** F1.564 — paths to `git add` (everything else stays untracked). */
  track?: readonly string[]
}

function write(root: string, relativePath: string, body: string): void {
  const full = join(root, relativePath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

function buildRepo(options: RepoOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'typecheck-coverage-'))
  created.push(root)

  mkdirSync(join(root, 'scripts'), { recursive: true })
  cpSync(SCRIPT, join(root, 'scripts', 'check-typecheck-coverage.ts'))

  const scripts: Record<string, string> = {
    // One chained package, and the chain is spelled the way the real one is so
    // the cwd walk and the bare-`tsc` tsconfig check both run for real.
    'typecheck:all':
      'cd packages/shared && bun run tsc --noEmit && cd ../.. '
      + '&& bun run typecheck:viewer && bun run typecheck:webui',
    'lint:chain': 'bun run lint:codex-protocol',
    'lint:codex-protocol': 'bun scripts/lint-package.ts packages/codex-protocol',
    // P6.738 — the two dormant Vite apps are IN the chain now, so they are
    // reached like any other package and their exclusions are gone. Spelled the
    // way the real ones are, so the cwd walk runs for real on them too.
    'typecheck:viewer': 'cd apps/viewer && bun run tsc --noEmit',
    'typecheck:webui': 'cd apps/webui && bun run tsc --noEmit',
  }
  for (const [key, value] of Object.entries(options.scripts ?? {})) {
    if (value === null) delete scripts[key]
    else scripts[key] = value
  }

  write(root, 'package.json', JSON.stringify({
    name: 'synthetic-root',
    workspaces: ['packages/*', 'apps/*'],
    scripts,
  }))

  // The one chained package. It holds both drift-tie suites, because in the real
  // tree both live in `packages/shared`.
  write(root, 'packages/shared/package.json', JSON.stringify({ name: '@synthetic/shared' }))
  write(root, 'packages/shared/tsconfig.json', '{}')

  // The excluded package: no tsconfig, no `typecheck` script, no tests.
  write(root, 'packages/codex-protocol/package.json', JSON.stringify({ name: '@synthetic/codex-protocol' }))
  if (options.withCodexProtocolSrc === true) {
    write(root, 'packages/codex-protocol/src/probe.ts', 'export const probe = 1\n')
  }

  for (const tie of TIES) {
    if (!(options.omitGenerated ?? []).includes(tie.generated)) {
      write(root, tie.generated, 'export type Generated = string\n')
    }
    if ((options.omitSuites ?? []).includes(tie.suite)) continue
    const readsIt = !(options.blankSuites ?? []).includes(tie.suite)
    write(root, tie.suite, readsIt
      ? `const source = read('${tie.spelling}')\n`
      : 'const source = read(SOME_OTHER_PATH)\n')
  }

  // The two formerly dormant apps, and the non-package surface. Each needs a
  // tsconfig now: the chain runs a bare `tsc --noEmit` in them, and the walker
  // errors on a bare `tsc` in a directory with no config (which is its own
  // guard, pinned elsewhere in this file).
  write(root, 'apps/viewer/package.json', JSON.stringify({ name: '@synthetic/viewer' }))
  write(root, 'apps/viewer/tsconfig.json', '{}')
  write(root, 'apps/webui/package.json', JSON.stringify({ name: '@synthetic/webui' }))
  write(root, 'apps/webui/tsconfig.json', '{}')
  write(root, 'apps/ios/README.txt', 'a Swift client, no TypeScript\n')

  // P2.370 — the two artefacts the `apps/ios` unmapped-surface entry asserts.
  // They are written by DEFAULT, because the healthy tree has both: this rig
  // must be able to show the entry PASSING, or its two failure cases prove
  // nothing but that a synthetic repo is missing files.
  write(root, 'AGENTS.md', [
    '# Synthetic guide',
    '',
    '## Monorepo Map',
    '',
    options.omitIosMapEntry === true
      ? '- `apps/electron` — the only client this map admits to.'
      : '- `apps/ios` — a Swift client the map names.',
    '',
    '## Commands',
    '',
  ].join('\n'))
  write(root, '.gitlab-ci.yml', options.omitIosCiJob === true
    ? 'lint:\n  script:\n    - bun run lint\n'
    : 'build-ios:\n  stage: build\n  script:\n    - cd apps/ios/NessyAgentKit && swift build && swift test\n')

  for (const [path, body] of Object.entries(options.files ?? {})) write(root, path, body)
  if (options.gitignore !== undefined) write(root, '.gitignore', `${options.gitignore.join('\n')}\n`)

  // F1.564 — the default check enumerates through `git ls-files`, so every rig
  // is a repository. Nothing is committed: `--others --exclude-standard` lists
  // an untracked file no ignore rule covers, which is what a lane's new package
  // is before its first commit.
  const git = (...args: string[]): void => {
    const proc = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
  git('init', '-q')
  if ((options.track ?? []).length > 0) git('add', '--', ...(options.track ?? []))

  return root
}

async function run(root: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(['bun', join(root, 'scripts', 'check-typecheck-coverage.ts')], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, output: `${stdout}${stderr}` }
}

describe('check-typecheck-coverage · P3.253 · the guard reads the substitutes the reason names', () => {
  test('passes when the lint chain and both drift ties are intact', async () => {
    // The positive control for every case below: on this rig the script exits 0,
    // so a failure elsewhere is the guard firing rather than the harness being
    // wrong about the synthetic layout.
    const { code, output } = await run(buildRepo())
    expect(output).not.toContain('Stale exclusion')
    expect(code).toBe(0)
  })

  test('fails when the lint script that stands in for the typecheck is gone', async () => {
    const { code, output } = await run(buildRepo({ scripts: { 'lint:codex-protocol': null } }))
    expect(output).toContain('Stale exclusion')
    expect(output).toContain('nothing checks its generated files at all')
    expect(code).toBe(1)
  })

  test('fails when lint:chain itself is gone', async () => {
    const { code, output } = await run(buildRepo({ scripts: { 'lint:chain': null } }))
    expect(output).toContain('`lint:chain` no longer exists')
    expect(code).toBe(1)
  })

  test('fails when the script survives but the chain stopped calling it', async () => {
    // The quiet half, and the reason this guard checks two things rather than
    // one: `lint:codex-protocol` still exists, still passes when run by hand,
    // and runs nowhere in CI. An existence check alone reports this as healthy.
    const { code, output } = await run(buildRepo({ scripts: { 'lint:chain': 'bun run lint:something-else' } }))
    expect(output).toContain('the script survives and runs nowhere')
    expect(code).toBe(1)
  })

  for (const tie of TIES) {
    test(`fails when the drift tie ${tie.suite} is deleted`, async () => {
      const { code, output } = await run(buildRepo({ omitSuites: [tie.suite] }))
      expect(output).toContain('that suite is gone, so nothing catches a bad regeneration')
      expect(output).toContain(tie.suite)
      expect(code).toBe(1)
    })

    test(`fails when ${tie.suite} survives but no longer reads its generated file`, async () => {
      // What a rename produces, and the state no structural check on the
      // excluded package could ever see: the tie is present, green, and reading
      // something else.
      const { code, output } = await run(buildRepo({ blankSuites: [tie.suite] }))
      expect(output).toContain(`${tie.suite} no longer reads ${tie.generated}`)
      expect(code).toBe(1)
    })

    test(`fails when the generated file ${tie.generated} is deleted`, async () => {
      const { code, output } = await run(buildRepo({ omitGenerated: [tie.generated] }))
      expect(output).toContain(`names ${tie.generated} as one of the two files a drift tie parses`)
      expect(code).toBe(1)
    })
  }

  test('fails when a chained dormant app is dropped out of the chain', async () => {
    // P6.738 — what replaced `apps/webui`'s exclusion. It used to be guarded by
    // "the substitute script exists", which stayed true while nothing ran that
    // script and the app sat red with every gate green. Now the app is IN the
    // chain, so the guard is the reachability check every other package gets:
    // plant the removal and the checker names it.
    const { code, output } = await run(buildRepo({
      scripts: { 'typecheck:all': 'cd packages/shared && bun run tsc --noEmit && cd ../.. && bun run typecheck:viewer' },
    }))
    expect(output).toContain('apps/webui')
    expect(output).toContain('is not reachable from `typecheck:all`')
    expect(code).toBe(1)
  })

  test('fails when the chained app keeps its chain entry but loses the script', async () => {
    // The other half, and the one the deleted `staleWhenScriptGone` used to be
    // the whole of: the chain still names it, the script is gone. The walker
    // stops following a name that resolves to nothing, so the app falls out of
    // the reachable set — the same report, from the other direction.
    const { code, output } = await run(buildRepo({ scripts: { 'typecheck:webui': null } }))
    expect(output).toContain('apps/webui')
    expect(output).toContain('is not reachable from `typecheck:all`')
    expect(code).toBe(1)
  })

  test('fails when the generated-only package grows a src/ directory', async () => {
    const { code, output } = await run(buildRepo({ withCodexProtocolSrc: true }))
    expect(output).toContain('now has a src/ directory')
    expect(code).toBe(1)
  })
})

/**
 * P3.190 — the repo-wide sweep's two enumerators, driven against the REAL tree.
 *
 * These cannot use the synthetic repo above: the sweep runs `tsc -p … --showConfig`
 * per config, and a temp directory has no TypeScript to run. What is worth
 * pinning is not the diff — that is a set subtraction — but the two ENUMERATORS
 * that decide its denominators, because each has one way to fail that looks
 * exactly like a correct answer.
 */
describe('check-typecheck-coverage · P2.370 · the unmapped surface asserts its own two artefacts', () => {
  // `apps/ios` is not a workspace package, so nothing above can reach it: it has
  // no package.json, no TypeScript and no program `tsc` could compile. What it
  // DOES have is a map entry naming it and a CI job building it, and both are
  // ordinary text a tidy-up can delete without failing any other check in the
  // repo. Deleting either restores the unLOOKED-at state the entry exists to
  // name, which is why the entry asserts them rather than describing them. The
  // positive control is the first test of the P3.253 block above: the same
  // synthetic repo, both artefacts present, exits 0.

  test('fails when AGENTS.md stops naming apps/ios in its Monorepo Map', async () => {
    const { code, output } = await run(buildRepo({ omitIosMapEntry: true }))
    expect(output).toContain('Monorepo Map no longer names apps/ios')
    expect(code).toBe(1)
  })

  test('fails when the build-ios job leaves .gitlab-ci.yml', async () => {
    const { code, output } = await run(buildRepo({ omitIosCiJob: true }))
    expect(output).toContain('no longer in .gitlab-ci.yml')
    // The line a reader acts on: what is lost is the client's ONLY static gate,
    // in either language.
    expect(output).toContain('NO static gate at all')
    expect(code).toBe(1)
  })
})

/**
 * `.references` is in `.gitignore` and is tracked by nothing, so NO clone
 * carries it until somebody fetches it by hand — CI never does. The first case
 * below therefore splits in two: the walker's own behaviour is asserted
 * unconditionally, and the "the directory really is here" half, which is what
 * gives that behaviour teeth, runs only where the directory exists and SAYS SO
 * when it does not. Asserting its presence unconditionally made a fresh
 * checkout report a walker defect (measured on CI job 630520568, 2026-09-19).
 */
const hasReferences = existsSync(join(REPO_ROOT, '.references'))
if (!hasReferences) {
  // stderr, so the reason travels with the run rather than living only here.
  console.warn(
    '[check-typecheck-coverage.test.ts] the `.references` teeth case is SKIPPED: '
    + `${join(REPO_ROOT, '.references')} is absent. It is gitignored and tracked by nothing, so a clone `
    + 'never carries it; the walker case still runs and is the behaviour this guard protects.',
  )
}

describe('check-typecheck-coverage · P3.190 · the repo-wide sweep enumerates both sides', () => {
  test('the test-file walker does not descend into .references', () => {
    const onDisk = findTestFiles(REPO_ROOT, [], Number.MAX_SAFE_INTEGER)
    // Positive control first: an empty walk would satisfy the assertion below
    // vacuously, and "no test files under .references" would then be true of a
    // walker that found nothing at all.
    expect(onDisk.length).toBeGreaterThan(500)
    expect(onDisk.filter((file) => file.startsWith('.references/'))).toEqual([])
  })

  test.skipIf(!hasReferences)('… and .references really is on this host, which is what gives that case its teeth', () => {
    // Separated rather than deleted: on a host that HAS the directory this is
    // the arm that makes the filter above a measurement instead of a tautology.
    expect(existsSync(join(REPO_ROOT, '.references'))).toBe(true)
    expect(findTestFiles(REPO_ROOT, [], Number.MAX_SAFE_INTEGER).length).toBeGreaterThan(500)
  })

  test('the tsconfig walker finds the non-package configs the per-package table cannot see', () => {
    const configs = findTsconfigs()
    // The four `scripts/` programs are the whole point: `--tests` iterates
    // workspace packages, so every test file under `scripts/` is outside its
    // denominator and only this walker brings them into one.
    for (const config of ['scripts/tsconfig.json', 'scripts/cdp/tsconfig.json', 'scripts/build/tsconfig.json']) {
      expect(configs).toContain(config)
    }
    expect(configs).toContain('packages/pi-agent-server/tsconfig.typecheck.json')
    // And nothing from a dependency tree: node_modules carries thousands.
    expect(configs.filter((config) => config.includes('node_modules'))).toEqual([])
  })

  test('SKIPPED_DIRS names .references, and that is what keeps the sweep from reporting 1081 orphans', () => {
    expect(SKIPPED_DIRS.has('.references')).toBe(true)
    expect(SKIPPED_DIRS.has('node_modules')).toBe(true)
  })
})

/**
 * F1.971 (CI-d2, 2026-09-26) — the walker above `stat`ed every entry, and `stat`
 * FOLLOWS a symlink, so a dangling one threw ENOENT and failed both walker cases
 * on the one host that held it: a finished live sitting leaves Chromium's
 * `SingletonCookie` and `SingletonLock` under the ignored `work/`, pointing at
 * nothing. One rig holds that exact shape beside real test files; a second
 * holds a link to a directory, because the fix reads the entry's OWN type and
 * so stops following directory links too — which is how `git ls-files`, the
 * lister this walker is compared with, records a link.
 */
describe('check-typecheck-coverage · F1.971 · the test-file walker reads an entry, not the target of its link', () => {
  /** `link` picks ONE shape per rig, so each case fails on its own reason and not on the other's. */
  function linkRig(link: 'dangling' | 'directory'): string {
    const root = mkdtempSync(join(tmpdir(), 'typecheck-coverage-links-'))
    created.push(root)
    write(root, 'pkg/a.test.ts', 'export {}\n')
    write(root, 'elsewhere/b.test.ts', 'export {}\n')
    if (link === 'dangling') {
      mkdirSync(join(root, 'ud'))
      // What Chromium writes: a link whose target is a bare number, not a path.
      symlinkSync('1827840024140018609', join(root, 'ud/SingletonCookie'))
    } else {
      symlinkSync(join(root, 'elsewhere'), join(root, 'pkg/linked-dir'))
    }
    return root
  }

  test('a dangling symlink does not throw, and the real test files beside it are still found', () => {
    const root = linkRig('dangling')
    // Positive control: the walk returns the real files, so "did not throw" is
    // not satisfied by a walker that stopped at the first entry.
    expect(findTestFiles(root, [], Number.MAX_SAFE_INTEGER).sort()).toEqual(
      [join(root, 'elsewhere/b.test.ts'), join(root, 'pkg/a.test.ts')].map((file) => relative(REPO_ROOT, file)),
    )
  })

  test('a link to a directory is not descended, so no test file is reported twice under a second path', () => {
    const root = linkRig('directory')
    const found = findTestFiles(root, [], Number.MAX_SAFE_INTEGER)
    expect(found.filter((file) => file.includes('linked-dir'))).toEqual([])
    // The link's target is still walked under its own name.
    expect(found).toContain(relative(REPO_ROOT, join(root, 'elsewhere/b.test.ts')))
  })
})

/**
 * F1.519 item 5 (P-WJai-5, 2026-09-24) — `--tests` read the FILESYSTEM, so an
 * UNTRACKED, IGNORED directory in the checkout was part of its denominator. A
 * lane's scratch copy of the tree (`work/wj-jj-verify/at-parent/scripts/…`)
 * carried a `tsconfig.json` whose `extends` pointed at a base that copy did not
 * hold, `tsc --showConfig` refused it, and the whole run exited 1 with
 * `TS5083 … Cannot read file …/work/wj-jj-verify/at-parent/tsconfig.base.json`
 * (measured 2026-09-24 at `d5ec9426a`, `work/wjax/f1519-5-head.txt`). It is the
 * AGENTS.md trap "a gate that walks the FILESYSTEM meets the runner's caches",
 * met on a developer's machine instead of CI.
 *
 * The discriminator is IGNORED, not untracked (same trap): a lane's brand-new
 * `foo.test.ts` must stay in the sweep, or the sweep stops seeing exactly the
 * files it was written to catch. So the rig is a real git repository with all
 * four kinds of file in it — tracked, tracked-then-deleted, untracked, ignored —
 * plus a `node_modules` its own `.gitignore` does NOT name, which is where the
 * belt of `SKIPPED_DIRS` still has to hold.
 */
function gitRig(): string {
  const root = mkdtempSync(join(tmpdir(), 'typecheck-coverage-git-'))
  created.push(root)
  const git = (...args: string[]): void => {
    const proc = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
  git('init', '-q')
  write(root, '.gitignore', 'ignored/\n')
  write(root, 'tsconfig.json', '{}\n')
  write(root, 'pkg/tsconfig.typecheck.json', '{}\n')
  write(root, 'pkg/a.test.ts', 'export {}\n')
  write(root, 'pkg/gone.test.ts', 'export {}\n')
  git('add', '--', '.gitignore', 'tsconfig.json', 'pkg/tsconfig.typecheck.json', 'pkg/a.test.ts', 'pkg/gone.test.ts')
  // Tracked, then deleted from disk: `git ls-files --cached` still names it, and
  // handing it to `tsc` or `stat` is a crash of its own.
  rmSync(join(root, 'pkg/gone.test.ts'))
  // Untracked and NOT ignored — a lane's new file. Must be seen.
  write(root, 'fresh/b.test.tsx', 'export {}\n')
  write(root, 'fresh/tsconfig.build.json', '{}\n')
  // Ignored — the shape that crashed the real run. Must be invisible.
  write(root, 'ignored/at-parent/scripts/tsconfig.json', '{ "extends": "../tsconfig.base.json" }\n')
  write(root, 'ignored/at-parent/scripts/c.test.ts', 'export {}\n')
  // Not ignored by THIS repo's .gitignore, and still never a program of ours.
  write(root, 'node_modules/dep/tsconfig.json', '{}\n')
  write(root, 'node_modules/dep/d.test.ts', 'export {}\n')
  return root
}

describe('check-typecheck-coverage · F1.519 · --tests enumerates the working tree through git, not the filesystem', () => {
  test('the tsconfig lister sees tracked and untracked configs, and nothing under an ignored directory', () => {
    const root = gitRig()
    expect(findTsconfigs(root)).toEqual(['fresh/tsconfig.build.json', 'pkg/tsconfig.typecheck.json', 'tsconfig.json'])
  })

  test('the test-file lister keeps a new untracked file and drops ignored, deleted and dependency files', () => {
    const root = gitRig()
    expect(findWorkingTreeTestFiles(root, root).sort()).toEqual(['fresh/b.test.tsx', 'pkg/a.test.ts'])
    // Scoped to one directory, as `--tests` asks per package.
    expect(findWorkingTreeTestFiles(join(root, 'pkg'), root)).toEqual(['pkg/a.test.ts'])
  })

  test('on the real tree the lister agrees with git and still finds the suites', () => {
    const onDisk = findWorkingTreeTestFiles(REPO_ROOT)
    // Positive control, as in the walker case above: an empty listing would make
    // every "nothing under X" below vacuously true.
    expect(onDisk.length).toBeGreaterThan(500)
    expect(onDisk).toContain('scripts/check-typecheck-coverage.test.ts')
    expect(onDisk.filter((file) => file.startsWith('.references/') || file.includes('/node_modules/'))).toEqual([])
    expect(findTsconfigs()).toContain('scripts/tsconfig.json')
  })
})

/**
 * F1.564 (P-WJax-2, 2026-09-24) — the DEFAULT check (`typecheck:coverage`, a
 * `lint:chain` step) found packages by WALKING THE FILESYSTEM under the
 * `workspaces` globs, so an IGNORED directory in a checkout was part of what it
 * judged: an ignored `apps/zz-scratch/package.json` was reported as a workspace
 * package outside the chain, and an ignored `packages/scratch/x.ts` as an
 * unmapped surface — red on the one machine that holds the scratch, green on
 * CI. F1.519 item 5 moved `--tests` onto `git ls-files` for the same trap; this
 * is the same move one mode over. The discriminator is IGNORED, not untracked,
 * so a lane's new package is still judged before its first commit.
 */
describe('check-typecheck-coverage · F1.564 · the default check finds packages through git, not the filesystem', () => {
  test('an IGNORED directory holding a package.json is not judged as a workspace package', async () => {
    const { code, output } = await run(buildRepo({
      gitignore: ['apps/zz-scratch/'],
      files: { 'apps/zz-scratch/package.json': JSON.stringify({ name: '@scratch/zz' }), 'apps/zz-scratch/index.ts': 'export {}\n' },
    }))
    expect(output).not.toContain('apps/zz-scratch')
    expect(code).toBe(0)
  })

  test('an IGNORED directory holding files but no package.json is not reported as an unmapped surface', async () => {
    const { code, output } = await run(buildRepo({
      gitignore: ['packages/scratch/'],
      files: { 'packages/scratch/x.ts': 'export {}\n' },
    }))
    expect(output).not.toContain('packages/scratch')
    expect(code).toBe(0)
  })

  test('an IGNORED TypeScript file inside the unmapped surface does not trip its guard', async () => {
    // A SwiftPM `.build/checkouts/<dep>` is where one would come from; the root
    // `.gitignore` of this repo names `.build`.
    const { code, output } = await run(buildRepo({
      gitignore: ['.build'],
      files: { 'apps/ios/NessyAgentKit/.build/checkouts/dep/tool.ts': 'export {}\n' },
    }))
    expect(output).not.toContain('apps/ios now holds TypeScript')
    expect(code).toBe(0)
  })

  test('CONTROL: a TRACKED new package outside the chain is still reported', async () => {
    const { code, output } = await run(buildRepo({
      files: { 'apps/zz-new/package.json': JSON.stringify({ name: '@scratch/new' }) },
      track: ['apps/zz-new/package.json'],
    }))
    expect(output).toContain('apps/zz-new (@scratch/new) is not reachable from `typecheck:all`')
    expect(code).toBe(1)
  })

  test('CONTROL: an UNTRACKED, not ignored, loose directory is still an unmapped surface', async () => {
    const { code, output } = await run(buildRepo({ files: { 'packages/loose/x.ts': 'export {}\n' } }))
    expect(output).toContain('packages/loose is matched by a `workspaces` glob, holds 1 files')
    expect(code).toBe(1)
  })

  test('CONTROL: an UNTRACKED, not ignored, TypeScript file in apps/ios still trips its guard', async () => {
    const { code, output } = await run(buildRepo({ files: { 'apps/ios/tool.ts': 'export {}\n' } }))
    expect(output).toContain('apps/ios now holds TypeScript (apps/ios/tool.ts)')
    expect(code).toBe(1)
  })
})
