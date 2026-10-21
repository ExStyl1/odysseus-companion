#!/usr/bin/env bun
/**
 * parity-report-drift.ts — is the committed parity report still what its generator produces
 * from HEAD, and when it is not, WHICH INPUT MOVED? (F1.108)
 *
 * THE COUPLING THIS EXISTS FOR. `scripts/build-parity-report.py` reads every plan file under
 * `docs/superpowers/plans/` (and the parity audit, the deviation register, the coverage map,
 * the page snapshot and our own document names). So a plan commit and a merge are coupled:
 * a plan edit that changes what the generator extracts, and is not followed by a
 * regeneration, turns `check-generator-faithfulness.test.ts`'s comparison case red on CI
 * (F1.109 confirmed it runs there), and that red reads exactly like the calendar drift D1.422
 * closed — "the report differs" with nothing saying a PLAN moved it, or which one. Measured on
 * `ce20dd44f` (§3b 79 → 80) and again by WJ-p (P-WJ-p-2) after controller plan commits.
 * NOT every plan edit (measured 2026-09-23 on a shared clone, report regenerated first): a
 * one-line plan edit citing a page by URL, or citing a page that already has a tracker row,
 * left the report byte-identical; citing a row-less page by its bare name (`accessibility.md`)
 * moved it, and this script then named exactly that one plan.
 *
 * WHAT IT DOES. It regenerates the report from `git archive HEAD` exactly as the faithfulness
 * gate does (`checkGenerator`, reused — one regeneration rule, not two), and on a non-empty
 * difference names the inputs that changed since the report was last committed, sorted into
 * the classes the generator reads. The verdict is the faithfulness gate's; only the MESSAGE
 * is new. Exit 1 on drift, 0 on a faithful report, and 0 with a stated SKIP where it cannot
 * run (no python3, no git work tree) — a skip is never a pass, and it says so.
 *
 * THE TWO SHAPES F1.108 ASKED TO PRICE (measured 2026-09-23, this tree):
 *
 * - (a) THIS, as its own CI job. Cost: one `git archive` + one generator run (the `--check`
 *   run alone was 22.36 s real / 0.59 s user at load ~11 — I/O, not CPU). Where the red
 *   lands: on the pipeline of the commit that moved an input without regenerating, in a job
 *   whose NAME says "parity report", with the moved inputs listed. What it cannot do: stop the
 *   commit before it is pushed.
 * - (b) `python3 scripts/build-parity-report.py --check` as a `lint:chain` step. Cost: the same
 *   ~22 s on every lane's chain run. Where the red lands: on EVERY lane's chain in a shared
 *   tree the moment the controller commits a plan row, until the controller regenerates — the
 *   coupling moves from one CI job onto every gate in the wave, which is the very shape this
 *   row exists to remove. At the moment it was measured it answered `STALE — 26 line(s)
 *   differ` for plan commits no lane made.
 *
 * (a) is built; (b) is not, for the reason above. The CI wiring is the controller's
 * (`.gitlab-ci.yml`); the job text is handed back in the F1.108 report.
 *
 * Usage:  bun scripts/parity-report-drift.ts
 */

import { execFileSync } from 'node:child_process'
import {
  GENERATORS,
  REPO,
  SKIP_MEANING,
  checkGenerator,
  gitAvailable,
  pythonExecutable,
} from './check-generator-faithfulness.ts'

export const REPORT = 'docs/superpowers/specs/2026-07-30-parity-report.md'
export const GENERATOR = 'scripts/build-parity-report.py'

/** One class of input the generator reads, and how a changed path is recognised as one. */
export interface InputClass {
  name: string
  match: (path: string) => boolean
}

/**
 * The inputs, in the generator's own terms (`build-parity-report.py`: `TRACKER`, `REGISTER`,
 * `COVERAGE_MAP`, `PLANS.glob`, `SPECS.glob` for our own names, the page snapshot, and the
 * generator itself). A spec counts only as a NAME: the generator reads the specs directory to
 * tell our documents from Claude's pages, so a spec's content moving is not an input.
 */
export const INPUT_CLASSES: readonly InputClass[] = [
  { name: 'the parity audit tracker', match: p => p === 'docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md' },
  { name: 'the deviation register', match: p => p === 'docs/superpowers/specs/2026-07-29-deviation-register.md' },
  { name: 'the Claude coverage map', match: p => p === 'docs/superpowers/specs/2026-07-31-claude-coverage-map.md' },
  { name: 'the Claude doc-page snapshot', match: p => p === 'scripts/claude-doc-pages.tsv' },
  { name: 'the generator itself', match: p => p === GENERATOR },
  { name: 'a plan', match: p => p.startsWith('docs/superpowers/plans/') && p.endsWith('.md') },
]

/** A spec that was ADDED, REMOVED or RENAMED changes our own names; a content edit does not. */
export const SPEC_NAMES_CLASS = 'a spec file name (added, removed or renamed)'

export interface ChangedPath {
  /** `git diff --name-status` letter: A, M, D, R… */
  status: string
  path: string
}

/** Sort changed paths into the classes the generator reads; everything else is ignored. */
export function movedInputs(changed: readonly ChangedPath[]): Map<string, string[]> {
  const moved = new Map<string, string[]>()
  const add = (name: string, path: string) => moved.set(name, [...(moved.get(name) ?? []), path])
  for (const { status, path } of changed) {
    const cls = INPUT_CLASSES.find(candidate => candidate.match(path))
    if (cls) {
      add(cls.name, path)
      continue
    }
    if (path.startsWith('docs/superpowers/specs/') && path.endsWith('.md') && !path.includes('/data/') && status !== 'M') {
      add(SPEC_NAMES_CLASS, path)
    }
  }
  return moved
}

/** The drift message: the verdict's own detail, then which inputs moved, then the remedy. */
export function driftMessage(options: {
  detail: string
  since: { sha: string; date: string } | null
  moved: Map<string, string[]>
  regenerate: string
}): string {
  const lines = [`parity report: STALE — ${REPORT} is not what ${GENERATOR} produces from HEAD.`, `  ${options.detail.replace(/\n/g, '\n  ')}`]
  if (options.since === null) {
    lines.push('  Which input moved: unknown — the report has no commit in this history to diff from.')
  } else if (options.moved.size === 0) {
    lines.push(
      `  Which input moved: NONE of the generator's inputs changed since the report was last committed (${options.since.sha}, ${options.since.date}).`,
      '  So the drift is in the generator or its environment (a python or git difference), not in a plan — read the detail above.',
    )
  } else {
    lines.push(`  Inputs moved since the report was last committed (${options.since.sha}, ${options.since.date}):`)
    for (const [name, paths] of options.moved) {
      const shown = paths.slice(0, 3).join(', ')
      lines.push(`    - ${name}: ${paths.length} file(s) — ${shown}${paths.length > 3 ? `, … ${paths.length - 3} more` : ''}`)
    }
  }
  lines.push(
    `  Regenerate from a QUIET tree (untracked plans are excluded by the generator, uncommitted edits are not): ${options.regenerate}`,
    '  and commit it as the LAST commit before the merge — a plan commit after it re-opens this.',
  )
  return lines.join('\n')
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
}

/** The last commit that touched the report, and what changed in the generator's inputs since. */
export function changedSinceReport(): { since: { sha: string; date: string } | null; changed: ChangedPath[] } {
  const last = git(['log', '-1', '--format=%h %cs', '--', REPORT])
  if (!last) return { since: null, changed: [] }
  const [sha, date] = last.split(' ') as [string, string]
  const out = git(['diff', '--name-status', '--no-renames', sha, 'HEAD', '--', 'docs/superpowers/plans', 'docs/superpowers/specs', 'scripts/claude-doc-pages.tsv', GENERATOR])
  const changed = out
    ? out.split('\n').map(line => {
      const [status, path] = line.split('\t') as [string, string]
      return { status, path }
    })
    : []
  return { since: { sha, date }, changed }
}

if (import.meta.main) {
  const generator = GENERATORS.find(candidate => candidate.script === GENERATOR)
  if (!generator) {
    console.error(`parity-report-drift: ${GENERATOR} is no longer registered in check-generator-faithfulness.ts's GENERATORS.`)
    process.exit(1)
  }
  const python = pythonExecutable()
  if (python === undefined || !gitAvailable()) {
    console.warn(`parity-report-drift: SKIPPED — ${python === undefined ? 'no python3 on PATH' : 'no git work tree here'}. ${SKIP_MEANING}`)
    process.exit(0)
  }
  const { findings, verdicts } = checkGenerator(generator, python)
  const drift = verdicts.find(verdict => verdict.artifact === REPORT && !verdict.identical)
  const other = findings.filter(finding => finding.kind !== 'drifted')
  for (const finding of other) console.error(`[${finding.kind}] ${finding.subject}\n    ${finding.detail}`)
  if (drift) {
    const { since, changed } = changedSinceReport()
    console.error(driftMessage({ detail: drift.detail ?? '', since, moved: movedInputs(changed), regenerate: generator.regenerate }))
    process.exit(1)
  }
  if (other.length > 0) process.exit(1)
  console.log(`parity-report-drift: ${REPORT} is byte-identical to what ${GENERATOR} produces from HEAD.`)
  process.exit(0)
}
