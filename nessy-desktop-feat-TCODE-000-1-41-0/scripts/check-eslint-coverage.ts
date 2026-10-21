/**
 * check-eslint-coverage — every workspace package must be lintable, and must
 * actually be linted.
 *
 * P2.319. The row that produced this script was opened as "a second unlintable
 * package"; enumerating found **11 of 15**. Both earlier numbers came from
 * someone noticing rather than counting, and that is the whole defect:
 *
 *   A package added without a lint config is silently exempt forever, because
 *   nothing fails when a config is absent.
 *
 * A package with no config and a package that lints clean are indistinguishable
 * from the outside. `npx eslint .` in a package with no config exits 2 with
 * "ESLint couldn't find an eslint.config.(js|mjs|cjs) file" — and with
 * `--format unix` or `--format json` it writes an EMPTY report that reads
 * exactly like a clean one. So the gap grew from 1 to 2 to 11 unseen, and
 * adding eleven configs without adding this check would only reset the clock.
 *
 * Two things are asserted, because either alone is bypassable:
 *
 *   1. Every workspace package has an `eslint.config.{js,mjs,cjs,ts}`.
 *      Without this, ESLint cannot run there at all.
 *   2. Every workspace package is reachable from the root `lint` script.
 *      Without this, the config exists and nothing ever invokes it — which is
 *      how `packages/server-core` sat unlinted with a config-shaped hole until
 *      P2.88, and how `scripts/` sat outside `lint` before that.
 *
 * Neither says the config MATCHES anything, and a `files: []` config lints zero
 * files while exiting 0 and printing nothing. That third level is P2.358, and
 * it is enforced per run rather than here, by `scripts/lint-package.ts` — the
 * count only exists while ESLint is running, so it is asserted there.
 *
 * "Workspace package" is defined the way the package manager defines it: a
 * directory matched by a `workspaces` glob in the root `package.json` that
 * contains a `package.json`. Directories under those globs WITHOUT a
 * `package.json` are not packages and are not checked — `apps/ios` (Swift),
 * and `packages/messaging-gateway` / `packages/messaging-whatsapp-worker`
 * (untracked `node_modules`/`dist` leftovers, zero files in git).
 *
 * F1.584 — "contains" means git's working-tree listing, not the disk: the
 * directories, the `package.json` and the `eslint.config.*` are all read from
 * `git ls-files --cached --others --exclude-standard` (the typecheck twin's
 * `listWorkingTreeFiles`, which F1.564 moved that gate onto). Until this row the
 * check walked the filesystem, so an IGNORED `apps/zz-scratch/package.json` was
 * reported as an unlinted package on the one machine holding it, and an IGNORED
 * config counted as the package's config although no other checkout has it. The
 * discriminator is IGNORED, not untracked: a lane's new package is judged before
 * its first commit. It needs a git work tree, and throws outside one.
 *
 * Usage:
 *   bun scripts/check-eslint-coverage.ts            # check, exit 1 on a gap
 *   bun scripts/check-eslint-coverage.ts --list     # print the coverage table
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listWorkingTreeFiles } from './check-typecheck-coverage.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The filenames ESLint 9 will actually load as a flat config. */
const CONFIG_FILENAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
]

interface RootPackageJson {
  workspaces?: string[]
  scripts?: Record<string, string>
}

interface WorkspacePackage {
  /** Repo-relative directory, POSIX separators, e.g. `packages/core`. */
  dir: string
  /** `name` from the package's own `package.json`, when it has one. */
  name: string
  configFile: string | null
  linted: boolean
}

function readRootPackageJson(): RootPackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as RootPackageJson
}

/**
 * F1.584 — the working-tree listing, taken once per run over the whole repo.
 * A tracked file deleted from disk is still listed by `--cached`, so the
 * readers below also ask the disk about each path they keep.
 */
let workingTreeListing: Set<string> | undefined

function repoWorkingTreeFiles(): Set<string> {
  workingTreeListing ??= new Set(listWorkingTreeFiles(REPO_ROOT, REPO_ROOT))
  return workingTreeListing
}

/** Whether repo-relative `path` is a working-tree file: listed by git and present on disk. */
function isWorkingTreeFile(path: string): boolean {
  return repoWorkingTreeFiles().has(path) && existsSync(join(REPO_ROOT, path))
}

/**
 * Expand the `workspaces` globs. Only the `<dir>/*` shape this repo uses is
 * supported, and an unrecognised pattern is a hard failure rather than a silent
 * skip: a glob this script cannot expand is a set of packages it cannot check,
 * which is the exact failure mode it exists to prevent.
 *
 * F1.584 — a child directory is one holding at least one working-tree file
 * (`repoWorkingTreeFiles`), so a directory whose every file is ignored is not
 * expanded at all: the typecheck twin's expansion, F1.564, word for word.
 */
function expandWorkspaceGlobs(patterns: string[]): string[] {
  const dirs: string[] = []

  for (const pattern of patterns) {
    const parentName = /^([A-Za-z0-9._-]+)\/\*$/.exec(pattern)?.[1]
    if (parentName === undefined) {
      throw new Error(
        `Unsupported workspaces pattern ${JSON.stringify(pattern)} in the root package.json. ` +
        'check-eslint-coverage.ts only expands "<dir>/*". Teach it the new shape rather than ' +
        'leaving the packages it matches unchecked.',
      )
    }

    const children = new Set<string>()
    for (const file of repoWorkingTreeFiles()) {
      if (!file.startsWith(`${parentName}/`)) continue
      const child = file.slice(parentName.length + 1).split('/')[0]
      // A file directly under the parent is not a package directory.
      if (child === undefined || file === `${parentName}/${child}`) continue
      if (existsSync(join(REPO_ROOT, parentName, child))) children.add(child)
    }

    for (const child of [...children].sort()) dirs.push(`${parentName}/${child}`)
  }

  return dirs
}

/**
 * Every command the root `lint` script reaches, transitively through
 * `bun run <other-script>` AND through `run-gates.ts <chain-script>`. A package
 * counts as linted when some script in that closure `cd`s into its directory,
 * names it as an eslint target, or hands it to `lint-package.ts`.
 *
 * P2.222 moved `lint` from an `&&` chain to `bun scripts/run-gates.ts
 * lint:chain`, so the closure has one more hop to follow. Without it this check
 * would see a `lint` script naming no package at all and report all fifteen as
 * unlinted — a checker that cries wolf is one people stop running.
 */
function resolveLintClosure(scripts: Record<string, string>): string[] {
  const commands: string[] = []
  const seen = new Set<string>()
  const queue: string[] = ['lint']

  while (queue.length > 0) {
    const scriptName = queue.shift()!
    if (seen.has(scriptName)) continue
    seen.add(scriptName)

    const body = scripts[scriptName]
    if (body === undefined) continue
    commands.push(body)

    const indirections = [
      ...body.matchAll(/\bbun run ([A-Za-z0-9:._-]+)/g),
      ...body.matchAll(/\brun-gates\.ts ([A-Za-z0-9:._-]+)/g),
    ]
    for (const referenced of indirections) {
      const name = referenced[1]
      if (name !== undefined) queue.push(name)
    }
  }

  return commands
}

/**
 * The directory must be followed by end-of-string or a shell separator, NOT by
 * `\b`. Measured while re-breaking this script against the commit before it
 * existed: `\bcd packages/server\b` matches `cd packages/server-core && …`,
 * because `-` is a non-word character, so `packages/server` reported as linted
 * by `lint:server-core`. A checker that false-passes on a hyphen prefix is the
 * same class of silent exemption this whole row is about.
 */
function mentions(command: string, dir: string): boolean {
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `\\S*` so the script's own path prefix (`bun scripts/lint-package.ts …`) is
  // allowed while the separator before it is still required.
  const introducers = '(?:cd|eslint|\\S*lint-package\\.ts)'
  return new RegExp(`(?:^|\\s)${introducers}\\s+${escaped}(?=\\s|$)`).test(command)
}

function isLintedBy(dir: string, commands: string[]): boolean {
  return commands.some((command) => mentions(command, dir))
}

function collect(): WorkspacePackage[] {
  const root = readRootPackageJson()
  const commands = resolveLintClosure(root.scripts ?? {})

  return expandWorkspaceGlobs(root.workspaces ?? [])
    .filter((dir) => isWorkingTreeFile(`${dir}/package.json`))
    .map((dir) => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf-8'),
      ) as { name?: string }

      return {
        dir,
        name: manifest.name ?? '(unnamed)',
        configFile: CONFIG_FILENAMES.find((f) => isWorkingTreeFile(`${dir}/${f}`)) ?? null,
        linted: isLintedBy(dir, commands),
      }
    })
}

function main(): void {
  const packages = collect()
  const listOnly = process.argv.includes('--list')

  if (listOnly) {
    for (const pkg of packages) {
      const config = pkg.configFile ?? 'NO CONFIG'
      const chain = pkg.linted ? 'in lint chain' : 'NOT IN LINT CHAIN'
      console.log(`${pkg.dir.padEnd(36)} ${config.padEnd(20)} ${chain}`)
    }
    console.log(`\n${packages.length} workspace packages.`)
    return
  }

  const missingConfig = packages.filter((p) => p.configFile === null)
  const missingFromChain = packages.filter((p) => !p.linted)

  if (missingConfig.length === 0 && missingFromChain.length === 0) {
    console.log(
      `check-eslint-coverage: ${packages.length} workspace packages, ` +
      'all have an eslint config and all are reachable from the root `lint` script.',
    )
    return
  }

  for (const pkg of missingConfig) {
    console.error(
      `check-eslint-coverage: ${pkg.dir} (${pkg.name}) has no eslint.config.* file.\n` +
      '  ESLint cannot run there at all — it exits 2 with "couldn\'t find an eslint.config file",\n' +
      '  and with --format json/unix it writes an EMPTY report that looks clean.\n' +
      `  Add ${pkg.dir}/eslint.config.mjs; the one-liner form is in eslint.config.base.mjs.`,
    )
  }

  for (const pkg of missingFromChain) {
    console.error(
      `check-eslint-coverage: ${pkg.dir} (${pkg.name}) is not reachable from the root \`lint\` script.\n` +
      `  A config nothing invokes lints nothing. Add a "lint:<pkg>" script that does\n` +
      `  \`cd ${pkg.dir} && npx eslint .\` and chain it into "lint".`,
    )
  }

  process.exit(1)
}

main()
