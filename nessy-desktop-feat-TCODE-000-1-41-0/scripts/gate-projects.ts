/**
 * gate-projects — answer "which tsconfig did this gate step actually compile?"
 *
 * P2.390. Two lanes on this branch saw the SAME diagnostic within one hour and
 * attributed it to two different owners, neither of them right:
 *
 *   apps/electron/src/renderer/components/apisetup/nessy-gateway.ts(1,38):
 *     error TS2307: Cannot find module '@config/models'
 *
 * One called it `typecheck:shared`'s. One called it a committed file no lane
 * had modified. Measured 2026-08-29, it is emitted by `typecheck:scripts` —
 * specifically by `scripts/tsconfig.json`, which extends `tsconfig.base.json`,
 * which declares no `paths` at all. Any top-level `scripts/*.ts` that reaches an
 * `apps/electron` file drags that file into a program where the app's own
 * aliases do not exist, and tsc — running from the REPO ROOT for that config —
 * prints the path repo-relative, so the diagnostic reads as if it belonged to
 * `apps/electron`. Reproduced byte-for-byte with a three-line probe, while
 * `typecheck:electron` was green in the same run.
 *
 * So: **a diagnostic's file path is not its owner.** The owner is the program,
 * and the program is named by a tsconfig. The gate had every step's nickname in
 * its summary and its verdict — the two parts that survive a `| tail` (P2.275) —
 * and the tsconfig in neither. This module supplies the missing half.
 *
 * ## Why this is not `check-typecheck-coverage.ts`'s walker
 *
 * That script has the same simulation and a superset of the reporting, and it
 * is NOT importable: it ends in a bare `if (process.argv.includes('--tests'))
 * … else main()` with no `import.meta.main` guard, so importing it RUNS the
 * coverage gate — including `process.exit(1)`. Rather than refactor a gate that
 * landed the same morning while three lanes were mid-flight, this resolver is
 * its own module with a NARROWER job: it labels, it never fails a run, and an
 * unrecognised step shape yields no label rather than an error. If the two are
 * ever merged, this is the side that should move.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertNoHomeOrRootPath } from './gate-safety.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A single compiler invocation a gate step performs. */
export interface StepProject {
  /** Repo-relative directory the compiler ran in; `''` is the repo root. */
  dir: string
  /** Repo-relative path of the tsconfig that defines the program. */
  project: string
  /** The chain segment this was read from, verbatim. */
  command: string
}

/** Reads a directory's `package.json` scripts. `''` is the repo root. */
export type ReadPackageScripts = (dir: string) => Record<string, string> | undefined

function readScriptsFromDisk(dir: string): Record<string, string> | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
    return manifest.scripts
  } catch {
    return undefined
  }
}

/**
 * Join a `cd` target onto the current directory, repo-relative.
 *
 * Returns `null` for anything that leaves the tree. Containment of a path we
 * EXECUTE is a `realpath` question (`gate-safety.ts`); this one is only ever
 * printed, so a lexical answer is the honest scope — and a `..` that climbs out
 * of the repo is a chain nobody should be labelling in the first place.
 */
function descend(dir: string, target: string): string | null {
  assertNoHomeOrRootPath('a `cd` target in a gate step', target)
  const joined = normalize(join(dir, target))
  if (joined === '.' || joined === '') return ''
  if (joined === '..' || joined.startsWith(`..${'/'}`)) return null
  return joined
}

/**
 * The script FILE a non-compiler segment executes, repo-relative, or `null`.
 *
 * P2.416. `resolveStepProjects` answers "which tsconfig" and returns `[]` for a
 * step that runs no compiler — which is most of `lint:chain` and both scanners
 * this row wires in. An unlabelled step is the same defect P2.390 opened over,
 * one rung down: a red `lint:scripts` and a red `lint:shared` are two different
 * files to go read, and the summary named neither. So a step that compiles
 * nothing names the script it ran instead.
 *
 * Deliberately narrow: the FIRST path-looking argument with a known extension.
 * A segment naming no such file yields `null` and stays unlabelled, because a
 * label that guesses is worse than no label — that is this module's own rule.
 */
function scriptOf(dir: string, segment: string): string | null {
  const named = /(?:^|\s)([A-Za-z0-9_@.\-/]+\.(?:ts|tsx|mjs|cjs|js|py|sh))(?:\s|$)/.exec(segment)?.[1]
  if (named === undefined) return null
  assertNoHomeOrRootPath('a script named by a gate step', named)
  const joined = normalize(join(dir, named))
  if (joined === '..' || joined.startsWith(`..${'/'}`)) return null
  return joined
}

function projectOf(dir: string, segment: string): string {
  const explicit = /(?:-p|--project)\s+(\S+)/.exec(segment)?.[1]
  const project = explicit === undefined ? 'tsconfig.json' : explicit
  assertNoHomeOrRootPath('a tsconfig named by a gate step', project)
  const joined = normalize(join(dir, project))
  return joined === '.' ? 'tsconfig.json' : joined
}

/**
 * Every compiler invocation reachable from `stepName`, in execution order.
 *
 * Best effort by design: a step that runs no compiler (`typecheck:coverage`, a
 * lint step) yields `[]` and the caller falls back to showing the step's body
 * verbatim. A label that guesses is worse than no label — guessing is the
 * defect this module exists to end.
 */
export function resolveStepProjects(
  rootScripts: Readonly<Record<string, string>>,
  stepName: string,
  readPackageScripts: ReadPackageScripts = readScriptsFromDisk,
): StepProject[] {
  return resolveStep(rootScripts, stepName, readPackageScripts).projects
}

/**
 * Every script FILE reachable from `stepName`, repo-relative, in execution
 * order. Empty for a step that runs a compiler (use `resolveStepProjects`) or
 * one whose body names no script file. P2.416.
 */
export function resolveStepScripts(
  rootScripts: Readonly<Record<string, string>>,
  stepName: string,
  readPackageScripts: ReadPackageScripts = readScriptsFromDisk,
): string[] {
  return [...new Set(resolveStep(rootScripts, stepName, readPackageScripts).scripts)]
}

/**
 * What a gate step should be LABELLED with: its tsconfigs when it compiles, the
 * scripts it ran when it does not, and nothing when neither is recognisable.
 *
 * P2.416. The precedence is not arbitrary — for a compiling step the tsconfig is
 * the answer to "who owns this diagnostic" (P2.390) and the script that invoked
 * tsc is noise; for a scanning step the script IS the owner.
 */
export function stepOwnerLabels(
  rootScripts: Readonly<Record<string, string>>,
  stepName: string,
  readPackageScripts?: ReadPackageScripts,
): string[] {
  const projects = stepProjectPaths(rootScripts, stepName, readPackageScripts)
  if (projects.length > 0) return projects
  return resolveStepScripts(rootScripts, stepName, readPackageScripts)
}

function resolveStep(
  rootScripts: Readonly<Record<string, string>>,
  stepName: string,
  readPackageScripts: ReadPackageScripts = readScriptsFromDisk,
): { projects: StepProject[]; scripts: string[] } {
  const found: StepProject[] = []
  const scripts: string[] = []
  const seen = new Set<string>()

  const walk = (body: string, startDir: string): void => {
    let dir = startDir

    for (const rawSegment of body.split('&&')) {
      const segment = rawSegment.trim()
      if (segment === '') continue

      const cdTarget = /^cd\s+(\S+)$/.exec(segment)?.[1]
      if (cdTarget !== undefined) {
        const next = descend(dir, cdTarget)
        if (next === null) return
        dir = next
        continue
      }

      // `bun run <name>` is a SCRIPT when the package.json in the current
      // directory defines it, and a BINARY otherwise — `bun run tsc --noEmit`
      // being the case that matters here.
      const runName = /^bun run ([A-Za-z0-9:._-]+)(?:\s|$)/.exec(segment)?.[1]
      if (runName !== undefined) {
        const scripts = dir === '' ? rootScripts : readPackageScripts(dir)
        const nested = scripts?.[runName]
        // `\u0000` as an ESCAPE, never the raw byte. Written raw first, and the
        // file went `Bin 0 -> 8572 bytes` in `git show --stat`: git reads a NUL as
        // binary and plain `grep` skips such a file SILENTLY — a trap this repo has
        // already measured, which would have shipped inside the gate directory
        // itself. The runtime value is identical; the source stays text.
        const key = `${dir}\u0000${runName}`
        if (nested !== undefined && !seen.has(key)) {
          seen.add(key)
          walk(nested, dir)
          continue
        }
      }

      if (/\btsc\b/.test(segment)) {
        found.push({ dir, project: projectOf(dir, segment), command: segment })
        continue
      }

      const script = scriptOf(dir, segment)
      if (script !== null) scripts.push(script)
    }
  }

  const body = rootScripts[stepName]
  if (body === undefined) return { projects: [], scripts: [] }
  seen.add(`\u0000${stepName}`)
  walk(body, '')
  return { projects: found, scripts }
}

/** The step's tsconfigs, deduplicated, in execution order. */
export function stepProjectPaths(
  rootScripts: Readonly<Record<string, string>>,
  stepName: string,
  readPackageScripts?: ReadPackageScripts,
): string[] {
  const paths = resolveStepProjects(rootScripts, stepName, readPackageScripts).map((p) => p.project)
  return [...new Set(paths)]
}

/**
 * The block a red run needs, and the reason this module exists.
 *
 * Printed next to the failures rather than filed in a spec, because the lane
 * that needs it is reading a gate's output at that moment and will otherwise
 * spend an hour auditing the package named in the diagnostic's path.
 *
 * ONE paragraph for the whole run, not one per step: repeating it under each
 * red made the general claim read as a claim about that particular step, which
 * is the confusion it exists to remove. Measured while proving this row — three
 * red steps, three copies, and two of them had nothing to do with the example.
 *
 * Both examples below were measured in a SINGLE run on 2026-08-29, which is why
 * there are two: the second was not planted, and it is the one that shows the
 * defect is not a quirk of `scripts/`.
 */
export function ownershipNote(reds: readonly { name: string; projects: readonly string[] }[]): string {
  const lines = reds
    .filter((red) => red.projects.length > 0)
    .map((red) => `  ${red.name} failed under: ${red.projects.join(', ')}`)

  if (lines.length === 0) return ''

  return [
    ...lines,
    '',
    "  A diagnostic's FILE PATH is not its owner — the owner is the program named above.",
    '  A program pulls files in from other packages by import and checks them under ITS OWN',
    "  flags and aliases, so a red can name a package whose own step is green. Two measured",
    '  in one run (P2.390):',
    '    - `scripts/tsconfig.json` extends `tsconfig.base.json`, which declares no `paths`,',
    "      so `apps/electron/.../nessy-gateway.ts(1,38) TS2307 Cannot find module",
    "      '@config/models'` is emitted by `typecheck:scripts` — with `typecheck:electron`",
    '      green in the same run, because in ITS program that alias resolves.',
    '    - `typecheck:shared` and `typecheck:server-core` both failed on',
    '      `../codex-responses-adapter/src/config-writer.ts` while',
    '      `typecheck:codex-responses-adapter` passed.',
    '  Audit the tsconfig, not the directory in the path.',
  ].join('\n')
}
