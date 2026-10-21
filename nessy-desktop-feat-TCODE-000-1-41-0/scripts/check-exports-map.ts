/**
 * check-exports-map — which workspace subpaths are IMPORTED but not EXPORTED,
 * and therefore break the only build that enforces an `exports` map.
 *
 * P2.448.
 *
 * ## The defect this exists to make visible
 *
 * EVERY package and app manifest carries a hand-maintained
 * `exports` map with no catch-all — this gate scans all of them, not just `shared`
 * (that narrower claim stood in this docblock until 2026-08-31, and it made the gate
 * look inapplicable to a lane adding a subpath to `packages/ui`). The globs are in
 * MANIFEST_GLOBS below — deliberately not repeated here, because a glob ending in a
 * star-slash closes a block comment. That trap cost four separate edits on 2026-08-31.
 *
 * `packages/shared/package.json` carries a hand-maintained `exports` map with
 * no catch-all, so every new module needs a line written by hand. Several were
 * not written, and the renderer build died on the first one it reached:
 *
 *   $ bun run electron:build:renderer
 *   ✗ Build failed in 858ms
 *   [commonjs--resolver] Missing "./config/notification-timing" specifier in
 *   "@nessy-agent/shared" package
 *
 * The reason nobody noticed is the part worth writing down. **Three resolvers
 * read this package and only one of them enforces the map.** Measured
 * 2026-08-30:
 *
 * | Resolver | Honors `exports`? | Sees the defect? |
 * | --- | --- | --- |
 * | Vite / Rollup (`electron:build:renderer`) | yes | **YES** |
 * | `tsc` via `typecheck:all` | no — tsconfig `paths` | no |
 * | Bun via `bun test` | no — the same tsconfig `paths` | no |
 *
 * Both misses come from ONE line, present in `packages/server-core/tsconfig.json`
 * and again in `apps/electron/tsconfig.json`:
 *
 *   "@nessy-agent/shared/*": ["../shared/src/*"]
 *
 * That is a catch-all, and Bun honors tsconfig `paths` too. So the package
 * behaves as if it had a `./*` export for every consumer except the bundler,
 * and the map's job — deciding what is public — is done in exactly one place
 * while being contradicted in two others. `typecheck:all` and `bun test` were
 * both green across all 71 violations this script found on its first run.
 *
 * The positive control for that claim, from the repo root where no tsconfig
 * `paths` applies:
 *
 *   Bun.resolveSync('@nessy-agent/shared/agent')             -> resolves   (exported)
 *   Bun.resolveSync('@nessy-agent/shared/sessions/types')    -> FAILS      (not exported)
 *
 * and from inside `packages/server-core/src/pi-harness/`, where the `paths`
 * entry does apply, BOTH resolve. Same specifier, same package, two answers.
 *
 * ## Why a gate and not a `./*` catch-all
 *
 * A catch-all was the other option on the row and it is the wrong one here, for
 * a reason that is visible in the map itself: the map is deliberate in places.
 * `./agent/memory` points at `./src/agent/memory/memory-store.ts` and
 * `./agent/modes` at `./src/agent/mode-types.ts` — renames, not passthroughs —
 * and three shapes coexist under one prefix (`<sub>.ts`, `<sub>/index.ts`, and
 * a `.json` asset). A single `./*` pattern cannot express those three, an array
 * fallback resolves differently in Node and in each bundler, and the result
 * would publish every internal module as public API to make one build pass.
 * More to the point, a catch-all deletes the question instead of answering it:
 * there would be nothing left for a gate to check, and "what is public" would
 * stop being written down anywhere.
 *
 * ## What it gates on
 *
 * The CONDITION, never a count: the set of imported subpaths must be a subset
 * of the set the map carries. Counts here move hourly — the first measurement
 * of this defect said 25 `./config/*` entries when there were 21, and 16
 * imported-but-unexported subpaths when there were 71. A gate pinned to a
 * number would have been wrong the day it landed. Set membership is not.
 *
 * Two directions, because they are one defect seen from either end:
 *
 *   1. IMPORTED-NOT-EXPORTED — something imports `@nessy-agent/x/y` and the
 *      map has no key matching `./y`. The renderer build dies on it.
 *   2. DANGLING — the map has a key whose target file does not exist. The
 *      renderer build dies on that too, and nothing else looks at it at all.
 *
 * ## The instrument, and why the obvious one is unusable here
 *
 * Specifiers are extracted with a single `git grep`, not by reading files.
 * Measured on this box at load ~11: reading all 3,983 tracked source files took
 * **124.9s**; `git grep` over the same set returned all 2,398 matches in
 * **0.47s**. A gate nobody will wait for is a gate nobody runs.
 *
 * `-a` is not decoration. A source file carrying a raw NUL byte is classified
 * as binary and skipped **silently** — this repo has measured that trap costing
 * ten missed call sites (see `check-nul-bytes.ts`). The tree carries zero such
 * files today; `-a` is what keeps that from mattering when it stops being true.
 *
 * ## Known limits, stated rather than hidden
 *
 *   - Only STATIC specifiers are seen: a specifier assembled at runtime
 *     (`import(base + name)`) is invisible here, and is invisible to the
 *     bundler's resolver for the same reason.
 *   - A self-import (a file inside the package naming its own package) is
 *     exempt: it resolves relatively and never consults the map.
 *   - Conditional export targets (`{ "import": …, "require": … }`) are checked
 *     for membership but not for a dangling target. There are none today; this
 *     says so rather than pretending the check is total.
 *   - TRACKED files only. `git grep` takes `--untracked`, and it was measured
 *     and deliberately not used: with nine lanes in flight it found six extra
 *     specifiers in other lanes' uncommitted files, which means a lane's gate
 *     could go red for work it did not write and cannot fix. A gate that cries
 *     wolf is one people stop running, and CI reads committed code anyway. The
 *     cost is that a new module is invisible here until it is committed — at
 *     which point this gate names it before the renderer build does. One such
 *     case was live when this landed: an uncommitted test imports
 *     `@nessy-agent/shared/prompts/compaction`, which no key carries, so this
 *     gate goes red on that lane's commit with the line to add already printed.
 *
 * Usage:
 *   bun scripts/check-exports-map.ts          # report; exit 1 if anything is wrong
 *   bun scripts/check-exports-map.ts --list   # report only, always exit 0
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal, assertInsideRepo, assertNoHomeOrRootPath } from './gate-safety.ts'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Source extensions worth searching for an import specifier. */
const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.jsx'] as const

/** Where workspace packages live, as `git ls-files` pathspecs. */
const MANIFEST_GLOBS = ['packages/*/package.json', 'apps/*/package.json'] as const

/**
 * A quoted specifier in a module-resolution position. `from` covers `import … from`
 * and `export … from`; `import` covers the bare side-effect and dynamic forms;
 * `mock.module` is Bun's, and it resolves through the same map.
 *
 * POSIX ERE, because it is handed to `git grep -E`.
 */
const SPECIFIER_ERE =
  "(from|import|require|mock\\.module)[[:space:]]*\\(?[[:space:]]*['\"]@nessy-agent/[^'\"]+['\"]"

/** Pull the package name and quoted specifier back out of a `git grep -no` line. */
const GREP_LINE = /^(.*?):(\d+):.*?['"](@nessy-agent\/[^'"]+)['"]$/

/**
 * Comments blanked, NEWLINES KEPT, so a specifier quoted in PROSE is not read
 * as an import site while `git grep`'s line numbers still address the result.
 *
 * Not decoration. `git grep` is line-oriented and comment-blind: measured
 * 2026-09-08 over this tree, 19 of the 2880 sites it reported sat inside a
 * comment — six in `packages/shared/src/index.ts`'s own usage docblock alone.
 * None was red TODAY only because every one of the nineteen is either a
 * self-import (exempt) or names a subpath the map already carries; a `//` probe
 * line naming an unexported subpath turned this step red once, which is where
 * P6.822 came from.
 *
 * `scripts/build/interceptor-pairing.ts` carries a `stripComments` for the same
 * reason. The two are deliberately NOT shared, for two measured reasons:
 *
 *   1. that one blanks a block comment to a single SPACE, which is right for an
 *      import-closure scan and wrong here, where a line number has to survive;
 *   2. **the pass ORDER is reversed here, and copying it verbatim silently ate
 *      four real imports.** Measured 2026-09-08: `slash-command-menu.test.tsx`
 *      carries a `//` line that quotes the glob `@nessy-agent/shared` followed
 *      by a slash and a star. Running the BLOCK pass first, that star-slash
 *      opens a block comment which the next docblock's terminator closes 66
 *      lines later — swallowing four live `import('@nessy-agent/…')` calls, in
 *      the one direction a gate must never fail. Line comments are therefore
 *      stripped FIRST, which removes the glob with the line that quotes it. The
 *      residual failure mode of this order is a block comment whose closing
 *      terminator sits on a line that also carries a `//`: that block then does
 *      not match and its text survives, which over-counts sites — the safe
 *      direction, and the direction this gate already had.
 *
 * The line-comment pass itself is inherited verbatim: a `//` preceded by `:`,
 * a quote or a backslash is left alone, so an `https:` URL inside a string and
 * an escaped slash inside a regex literal both survive.
 */
export function stripComments(source: string): string {
  return source
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
}

export interface PackageExports {
  /** Package name as written in its manifest. */
  name: string
  /** Repo-relative directory holding the manifest. */
  dir: string
  /** Subpath keys with no `*`. */
  exact: ReadonlySet<string>
  /** Subpath PATTERNS, split around their single `*`. */
  patterns: readonly { key: string; prefix: string; suffix: string }[]
  /** Every key with its raw target, for the dangling check. */
  targets: ReadonlyMap<string, unknown>
}

export interface Violation {
  packageName: string
  /** The subpath as the map would have to spell it, e.g. `./config/paths`. */
  subpath: string
  /** `file:line` of every import, sorted. */
  sites: readonly string[]
}

export interface DanglingEntry {
  packageName: string
  subpath: string
  target: string
}

/**
 * Does `subpath` match any key in `pkg`?
 *
 * Node's subpath patterns match on the text either side of a single `*`, and
 * the `*` must capture at least one character — `./a/*` does not match `./a/`.
 */
export function isExported(pkg: PackageExports, subpath: string): boolean {
  if (pkg.exact.has(subpath)) return true
  return pkg.patterns.some(
    ({ prefix, suffix }) =>
      subpath.length > prefix.length + suffix.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix),
  )
}

/** Turn a full specifier into the package name and the subpath key it needs. */
export function splitSpecifier(specifier: string): { name: string; subpath: string } | null {
  const parts = specifier.split('/')
  if (parts.length < 2) return null
  const name = `${parts[0]}/${parts[1]}`
  const subpath = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.'
  return { name, subpath }
}

/** Parse one manifest into the shape the checks need, or null if it declares no `exports`. */
export function readPackageExports(dir: string, manifest: unknown): PackageExports | null {
  const record = manifest as { name?: unknown; exports?: unknown }
  if (typeof record.name !== 'string') return null
  if (record.exports === null || typeof record.exports !== 'object') return null

  const entries = Object.entries(record.exports as Record<string, unknown>)
  const exact = new Set<string>()
  const patterns: { key: string; prefix: string; suffix: string }[] = []

  for (const [key] of entries) {
    const star = key.indexOf('*')
    if (star === -1) exact.add(key)
    else patterns.push({ key, prefix: key.slice(0, star), suffix: key.slice(star + 1) })
  }

  return { name: record.name, dir, exact, patterns, targets: new Map(entries) }
}

/** Every workspace package that declares an `exports` map, keyed by package name. */
export function collectPackages(repoRoot: string = REPO_ROOT): Map<string, PackageExports> {
  const listed = execFileSync('git', ['ls-files', '--', ...MANIFEST_GLOBS], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })

  const found = new Map<string, PackageExports>()
  for (const manifestPath of listed.split('\n').filter((line) => line !== '')) {
    // Manifest paths come out of `git ls-files` and are repo-relative by
    // construction; the containment check is cheap at this count (single
    // digits) and is what would catch a mangled enumeration.
    assertInsideRepo(repoRoot, manifestPath)
    const dir = manifestPath.replace(/\/package\.json$/, '')
    const pkg = readPackageExports(dir, JSON.parse(readFileSync(`${repoRoot}/${manifestPath}`, 'utf8')))
    if (pkg !== null) found.set(pkg.name, pkg)
  }
  return found
}

/** Every static `@nessy-agent/*` specifier in tracked source, with its site. */
export function collectSpecifierSites(
  repoRoot: string = REPO_ROOT,
): { file: string; line: string; specifier: string }[] {
  let raw: string
  try {
    raw = execFileSync('git', ['grep', '-anoE', SPECIFIER_ERE, '--', ...SOURCE_GLOBS], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    // `git grep` exits 1 on no matches. That is a legitimate empty result, not
    // a failure — distinguish it from a real error rather than reporting a
    // clean tree because git happened to fall over.
    const status = (error as { status?: unknown }).status
    if (status === 1) return []
    throw error
  }

  return codeSitesOnly(raw.split('\n'), (file) => readFileSync(`${repoRoot}/${file}`, 'utf8'))
}

/**
 * `git grep -no` rows, parsed, minus every hit that sits inside a comment.
 *
 * Split out from `collectSpecifierSites` so the filter is testable without a
 * git tree: the whole-tree call reads ~800 files and has been measured at 221 s
 * under wave load, which is not a unit test.
 *
 * `readSource` is handed the repo-relative path the grep row named. `git grep`
 * searches the WORKING TREE for tracked files, so the default reader returns
 * the same bytes git matched.
 */
export function codeSitesOnly(
  rows: readonly string[],
  readSource: (file: string) => string,
): { file: string; line: string; specifier: string }[] {
  const sites: { file: string; line: string; specifier: string }[] = []
  const strippedLines = new Map<string, string[]>()
  for (const row of rows) {
    const match = GREP_LINE.exec(row)
    if (match === null) continue
    const file = match[1] as string
    const line = match[2] as string
    const specifier = match[3] as string
    let lines = strippedLines.get(file)
    if (lines === undefined) {
      lines = stripComments(readSource(file)).split('\n')
      strippedLines.set(file, lines)
    }
    // The specifier survived the strip on its own line, so it is code.
    if (!(lines[Number(line) - 1] ?? '').includes(specifier)) continue
    sites.push({ file, line, specifier })
  }
  return sites
}

/** Direction 1: imported by a specifier the map does not carry. */
export function findUnexported(
  packages: ReadonlyMap<string, PackageExports>,
  sites: readonly { file: string; line: string; specifier: string }[],
): Violation[] {
  const grouped = new Map<string, Violation & { sites: string[] }>()

  for (const { file, line, specifier } of sites) {
    const split = splitSpecifier(specifier)
    if (split === null) continue
    const pkg = packages.get(split.name)
    if (pkg === undefined) continue
    // A file inside the package resolves relatively and never reads the map.
    if (file === pkg.dir || file.startsWith(`${pkg.dir}/`)) continue
    if (isExported(pkg, split.subpath)) continue

    const key = `${split.name}\u0000${split.subpath}`
    let violation = grouped.get(key)
    if (violation === undefined) {
      violation = { packageName: split.name, subpath: split.subpath, sites: [] }
      grouped.set(key, violation)
    }
    violation.sites.push(`${file}:${line}`)
  }

  return [...grouped.values()]
    .map((v) => ({ ...v, sites: [...v.sites].sort() }))
    .sort((a, b) => `${a.packageName}${a.subpath}`.localeCompare(`${b.packageName}${b.subpath}`))
}

/** Direction 2: the map carries a key whose target file is not on disk. */
export function findDangling(
  packages: ReadonlyMap<string, PackageExports>,
  repoRoot: string = REPO_ROOT,
): DanglingEntry[] {
  const dangling: DanglingEntry[] = []
  for (const pkg of packages.values()) {
    for (const [subpath, target] of pkg.targets) {
      // Patterns name a shape, not a file; a conditional object is out of
      // scope and the header says so.
      if (subpath.includes('*') || typeof target !== 'string') continue
      assertNoHomeOrRootPath(`the export target for ${pkg.name}${subpath.slice(1)}`, target)
      if (!existsSync(`${repoRoot}/${pkg.dir}/${target.replace(/^\.\//, '')}`)) {
        dangling.push({ packageName: pkg.name, subpath, target })
      }
    }
  }
  return dangling.sort((a, b) =>
    `${a.packageName}${a.subpath}`.localeCompare(`${b.packageName}${b.subpath}`),
  )
}

function suggestTarget(repoRoot: string, pkg: PackageExports, subpath: string): string | null {
  const base = subpath.slice(2)
  for (const candidate of [`src/${base}.ts`, `src/${base}/index.ts`, `src/${base}.tsx`, `src/${base}`]) {
    if (existsSync(`${repoRoot}/${pkg.dir}/${candidate}`)) return `./${candidate}`
  }
  return null
}

function main(argv: readonly string[]): number {
  const listOnly = argv.includes('--list')

  const packages = collectPackages()
  const unexported = findUnexported(packages, collectSpecifierSites())
  const dangling = findDangling(packages)

  console.log(
    `exports maps: ${packages.size} package(s), ` +
    `${[...packages.values()].reduce((n, p) => n + p.targets.size, 0)} subpath key(s)`,
  )

  if (unexported.length > 0) {
    console.log(`\nIMPORTED BUT NOT EXPORTED (${unexported.length}):`)
    for (const v of unexported) {
      const pkg = packages.get(v.packageName) as PackageExports
      const target = suggestTarget(REPO_ROOT, pkg, v.subpath)
      console.log(`\n  ${v.packageName}${v.subpath.slice(1)}  — ${v.sites.length} import site(s)`)
      for (const site of v.sites.slice(0, 3)) console.log(`      ${site}`)
      if (v.sites.length > 3) console.log(`      … and ${v.sites.length - 3} more`)
      console.log(
        target === null
          ? `      no source file found under ${pkg.dir}/src — is the specifier a typo?`
          : `      add to ${pkg.dir}/package.json: ${JSON.stringify(v.subpath)}: ${JSON.stringify(target)}`,
      )
    }
  }

  if (dangling.length > 0) {
    console.log(`\nEXPORTED BUT MISSING ON DISK (${dangling.length}):`)
    for (const d of dangling) {
      console.log(`  ${d.packageName}${d.subpath.slice(1)} -> ${d.target}  (no such file)`)
    }
  }

  if (unexported.length === 0 && dangling.length === 0) {
    console.log('\nOK: every imported subpath is exported, and every export target exists.')
    return 0
  }

  console.log(
    '\nOnly the Vite renderer build enforces these maps — `typecheck:all` and `bun test`\n' +
    'resolve through the `@nessy-agent/*/*` tsconfig paths entry and stay green. So a miss\n' +
    'here surfaces as a packaged build that will not build, and nothing earlier.',
  )
  return listOnly ? 0 : 1
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}
