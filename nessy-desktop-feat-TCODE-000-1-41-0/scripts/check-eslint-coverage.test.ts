/**
 * Tests for `check-eslint-coverage.ts` — P2.319.
 *
 * The script's whole purpose is to fail when a workspace package is missing a
 * lint config, so the tests that matter are the ones that BREAK it. Each case
 * builds a synthetic repo in a temp directory, copies the real script into its
 * `scripts/` (the script derives the repo root from its own location, so no
 * argument or double is needed — the real code path runs), and asserts on the
 * process's exit code and stderr.
 *
 * A test double that stubbed the filesystem would pass whether or not the
 * script actually reads a config file, which is the failure mode this row is
 * about; these cases run the real thing against a real tree.
 */

import { describe, expect, test, afterAll } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-eslint-coverage.ts')
/** F1.584 — the script reads its working-tree listing through the typecheck twin's `listWorkingTreeFiles`, so the rig carries both. */
const TWIN = join(dirname(fileURLToPath(import.meta.url)), 'check-typecheck-coverage.ts')

const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

interface FakePackage {
  dir: string
  name: string
  /** Write an `eslint.config.mjs` into the package. */
  config: boolean
  /** Add a `lint:<x>` script for it and chain it into `lint`. */
  inChain: boolean
}

interface RepoOptions {
  /** F1.584 — extra files, written after the packages. */
  files?: Record<string, string>
  /** F1.584 — the rig's `.gitignore`, one pattern per entry. */
  gitignore?: readonly string[]
  /** F1.584 — paths to `git add` (everything else stays untracked). */
  track?: readonly string[]
}

function buildFakeRepo(packages: FakePackage[], options: RepoOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'eslint-coverage-'))
  created.push(root)

  mkdirSync(join(root, 'scripts'), { recursive: true })
  cpSync(SCRIPT, join(root, 'scripts', 'check-eslint-coverage.ts'))
  cpSync(TWIN, join(root, 'scripts', 'check-typecheck-coverage.ts'))

  const scripts: Record<string, string> = {}
  const chain: string[] = []

  for (const pkg of packages) {
    mkdirSync(join(root, pkg.dir), { recursive: true })
    writeFileSync(join(root, pkg.dir, 'package.json'), JSON.stringify({ name: pkg.name }))
    if (pkg.config) {
      writeFileSync(join(root, pkg.dir, 'eslint.config.mjs'), 'export default []\n')
    }
    if (pkg.inChain) {
      const key = `lint:${pkg.name}`
      scripts[key] = `cd ${pkg.dir} && npx eslint .`
      chain.push(`bun run ${key}`)
    }
  }

  scripts.lint = chain.join(' && ')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fake', workspaces: ['packages/*', 'apps/*'], scripts }, null, 2),
  )

  for (const [path, body] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  if (options.gitignore !== undefined) writeFileSync(join(root, '.gitignore'), `${options.gitignore.join('\n')}\n`)

  // F1.584 — the check enumerates through `git ls-files`, so every rig is a
  // repository. Nothing is committed: `--others --exclude-standard` lists an
  // untracked file no ignore rule covers, which is what a lane's new package is
  // before its first commit.
  const git = (...args: string[]): void => {
    const proc = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
  git('init', '-q')
  if ((options.track ?? []).length > 0) git('add', '--', ...(options.track ?? []))

  return root
}

async function runCheck(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', join(root, 'scripts', 'check-eslint-coverage.ts')], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, stdout, stderr }
}

const COMPLETE: FakePackage[] = [
  { dir: 'packages/alpha', name: 'alpha', config: true, inChain: true },
  { dir: 'apps/beta', name: 'beta', config: true, inChain: true },
]

describe('check-eslint-coverage', () => {
  test('passes when every workspace package has a config and is in the lint chain', async () => {
    const { code, stdout } = await runCheck(buildFakeRepo(COMPLETE))
    expect(code).toBe(0)
    expect(stdout).toContain('2 workspace packages')
    expect(stdout).toContain('all have an eslint config')
  })

  test('fails when a workspace package has no eslint config', async () => {
    const root = buildFakeRepo([
      ...COMPLETE,
      { dir: 'packages/gamma', name: 'gamma', config: false, inChain: true },
    ])
    const { code, stderr } = await runCheck(root)
    expect(code).toBe(1)
    expect(stderr).toContain('packages/gamma')
    expect(stderr).toContain('has no eslint.config.* file')
    // The other two must not be blamed.
    expect(stderr).not.toContain('packages/alpha')
  })

  test('fails when a package has a config but nothing in the lint chain runs it', async () => {
    const root = buildFakeRepo([
      ...COMPLETE,
      { dir: 'packages/delta', name: 'delta', config: true, inChain: false },
    ])
    const { code, stderr } = await runCheck(root)
    expect(code).toBe(1)
    expect(stderr).toContain('packages/delta')
    expect(stderr).toContain('not reachable from the root `lint` script')
  })

  test('follows `bun run` indirection instead of only reading the lint script body', async () => {
    // The root `lint` is a chain of `bun run lint:*`, so a checker that scanned
    // only `scripts.lint` would see no directory name at all and pass every
    // package. This asserts the closure is walked.
    const root = buildFakeRepo(COMPLETE)
    const manifestPath = join(root, 'package.json')
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      scripts: Record<string, string>
    }
    manifest.scripts['lint:group'] = 'bun run lint:alpha && bun run lint:beta'
    manifest.scripts.lint = 'bun run lint:group'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const { code } = await runCheck(root)
    expect(code).toBe(0)
  })

  test('does not treat `cd packages/server-core` as covering `packages/server`', async () => {
    // Measured against the commit before this script existed: with `\bcd <dir>\b`
    // the hyphen in `server-core` is a non-word character, so `packages/server`
    // reported as linted by `lint:server-core` and the gap was invisible — the
    // very failure mode the script is here to catch.
    const root = buildFakeRepo([
      { dir: 'packages/server-core', name: 'server-core', config: true, inChain: true },
      { dir: 'packages/server', name: 'server', config: true, inChain: false },
    ])
    const { code, stderr } = await runCheck(root)
    expect(code).toBe(1)
    expect(stderr).toContain('packages/server (server) is not reachable')
    expect(stderr).not.toContain('packages/server-core (server-core)')
  })

  test('follows the `run-gates.ts <chain>` hop the root `lint` script now goes through', async () => {
    // P2.222 replaced the `&&` chain with `bun scripts/run-gates.ts lint:chain`,
    // so `scripts.lint` names no package at all. Without this hop the checker
    // reports every package unreachable — fifteen false positives, which is the
    // shape of a check people stop running.
    const root = buildFakeRepo(COMPLETE)
    const manifestPath = join(root, 'package.json')
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      scripts: Record<string, string>
    }
    manifest.scripts['lint:chain'] = manifest.scripts.lint ?? ''
    manifest.scripts.lint = 'bun scripts/run-gates.ts lint:chain'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const { code, stdout } = await runCheck(root)
    expect(code).toBe(0)
    expect(stdout).toContain('all have an eslint config')
  })

  test('counts `lint-package.ts <dir>` as invoking that package, path prefix and all', async () => {
    const root = buildFakeRepo(COMPLETE)
    const manifestPath = join(root, 'package.json')
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      scripts: Record<string, string>
    }
    for (const pkg of COMPLETE) {
      manifest.scripts[`lint:${pkg.name}`] = `bun scripts/lint-package.ts ${pkg.dir}`
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const { code } = await runCheck(root)
    expect(code).toBe(0)
  })

  test('`lint-package.ts packages/server-core` still does not cover `packages/server`', async () => {
    // The hyphen-prefix false pass, re-checked against the new introducer: a
    // wider introducer list is a wider chance to match the wrong directory.
    const root = buildFakeRepo([
      { dir: 'packages/server-core', name: 'server-core', config: true, inChain: true },
      { dir: 'packages/server', name: 'server', config: true, inChain: false },
    ])
    const manifestPath = join(root, 'package.json')
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      scripts: Record<string, string>
    }
    manifest.scripts['lint:server-core'] = 'bun scripts/lint-package.ts packages/server-core'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const { code, stderr } = await runCheck(root)
    expect(code).toBe(1)
    expect(stderr).toContain('packages/server (server) is not reachable')
  })

  test('ignores directories under a workspace glob that have no package.json', async () => {
    // `apps/ios` (Swift) and two leftover `packages/*` directories in this repo
    // are matched by the globs but are not packages. Flagging them would make
    // the check cry wolf, and a check that cries wolf is one people stop running.
    const root = buildFakeRepo(COMPLETE)
    mkdirSync(join(root, 'packages', 'not-a-package', 'node_modules'), { recursive: true })

    const { code, stdout } = await runCheck(root)
    expect(code).toBe(0)
    expect(stdout).toContain('2 workspace packages')
  })

  test('refuses a workspaces glob it cannot expand rather than silently skipping it', async () => {
    const root = buildFakeRepo(COMPLETE)
    const manifestPath = join(root, 'package.json')
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>
    manifest.workspaces = ['packages/*', 'apps/*', 'vendor/**/pkg']
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const { code, stderr } = await runCheck(root)
    expect(code).not.toBe(0)
    expect(stderr).toContain('Unsupported workspaces pattern')
  })
})

/**
 * F1.584 (P-WJbk-1, 2026-09-24) — `lint:coverage` (a `lint:chain` step) found
 * packages by WALKING THE FILESYSTEM under the `workspaces` globs, so an
 * IGNORED directory in a checkout was part of what it judged: an ignored
 * `apps/zz-scratch/package.json` was reported as a workspace package with no
 * config — red on the one machine that holds the scratch, green on CI. The
 * typecheck twin made the same move in F1.564; these are its rig shapes. The
 * discriminator is IGNORED, not untracked, so a lane's new package is still
 * judged before its first commit.
 */
describe('check-eslint-coverage · F1.584 · packages are found through git, not the filesystem', () => {
  test('an IGNORED directory holding a package.json is not judged as a workspace package', async () => {
    const { code, stdout, stderr } = await runCheck(buildFakeRepo(COMPLETE, {
      gitignore: ['apps/zz-scratch/'],
      files: { 'apps/zz-scratch/package.json': JSON.stringify({ name: 'zz-scratch' }), 'apps/zz-scratch/index.ts': 'export {}\n' },
    }))
    expect(`${stdout}${stderr}`).not.toContain('apps/zz-scratch')
    expect(stdout).toContain('2 workspace packages')
    expect(code).toBe(0)
  })

  test('an IGNORED eslint config is not the package\'s config: a checkout without it has none', async () => {
    const root = buildFakeRepo(
      [...COMPLETE, { dir: 'packages/gamma', name: 'gamma', config: true, inChain: true }],
      { gitignore: ['packages/gamma/eslint.config.mjs'] },
    )
    const { code, stderr } = await runCheck(root)
    expect(stderr).toContain('packages/gamma (gamma) has no eslint.config.* file')
    expect(code).toBe(1)
  })

  test('CONTROL: a TRACKED new package outside the chain is still reported', async () => {
    const root = buildFakeRepo(
      [...COMPLETE, { dir: 'apps/zz-new', name: 'zz-new', config: true, inChain: false }],
      { track: ['apps/zz-new/package.json', 'apps/zz-new/eslint.config.mjs'] },
    )
    const { code, stderr } = await runCheck(root)
    expect(stderr).toContain('apps/zz-new (zz-new) is not reachable from the root `lint` script')
    expect(code).toBe(1)
  })

  test('CONTROL: an UNTRACKED, not ignored, new package with no config is still reported', async () => {
    const root = buildFakeRepo([...COMPLETE, { dir: 'packages/loose', name: 'loose', config: false, inChain: true }])
    const { code, stderr } = await runCheck(root)
    expect(stderr).toContain('packages/loose (loose) has no eslint.config.* file')
    expect(code).toBe(1)
  })
})
