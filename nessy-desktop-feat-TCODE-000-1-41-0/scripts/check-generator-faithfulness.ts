#!/usr/bin/env bun
/**
 * check-generator-faithfulness.ts — do the Python generators still produce the
 * artifacts they are committed alongside?
 *
 * MEASURED 2026-08-25 (`P2.165`): nothing validates `scripts/*.py` at all. No
 * `pyproject.toml`, no ruff, no flake8, no mypy, no pre-commit config, no test,
 * no CI step, no git hook — and `docs-integrity.test.ts` guards neither
 * generated artifact. Staleness and syntax errors alike were invisible.
 *
 * WHY THIS IS A FAITHFULNESS GATE AND NOT A SYNTAX GATE. A `py_compile` sweep
 * would fail for the wrong reason and get switched off: the CI image is
 * `nodejs-22` and has no Python, which is also why `test:doc-tools` sits
 * commented out in `package.json`. And syntax was never the risk — a generator
 * that no longer reproduces its artifact is. That is the failure `P2.171` was
 * opened for (a 364-vs-363 reading that turned out to be a comparison against a
 * later tree, not a generator defect) and the discipline `P2.67` and `P2.69`
 * both followed: prove a generator faithful BEFORE changing it, because a
 * generator you re-run without that proof can silently rewrite an artifact.
 *
 * WHY IT REGENERATES FROM `git archive` AND NOT FROM THE WORKING TREE. Two
 * independent reasons, both measured:
 *
 *   1. `build-parity-report.py` reads ALL of `docs/superpowers/plans/`, so its
 *      output moves with any plan edit — including another lane's UNTRACKED plan
 *      file. That is exactly how `P2.171` got its one-line contamination: 6 lines
 *      of drift traced to an untracked plan, and the faithful regeneration that
 *      settled the question was taken from `git archive` while five lanes were
 *      mid-edit.
 *   2. Two of these generators WRITE THEIR ARTIFACTS IN PLACE. Running them in
 *      the working tree to check them would modify the tree it is checking.
 *
 * So the question this gate answers is precise: **is each committed artifact
 * byte-identical to what its generator produces from the committed inputs at
 * HEAD?** For an input set that legitimately changes — and plans change every
 * day — that is the only form of "faithful" with a stable answer. It follows
 * that a commit which changes a tracker row without regenerating the report
 * turns this red. That is not a false positive: it is the rule `AGENTS.md`
 * already states ("GENERATED: run … after any tracker change"), and the failure
 * message names the command. `P2.171` considered narrowing the script's inputs
 * instead and rejected it, because narrowing would delete §3's page axis.
 *
 * WHAT IT DOES NOT CHECK. Whether an artifact is CORRECT — only that it is
 * reproducible. A generator with a wrong rule reproduces its wrong output
 * perfectly. It says nothing about the Python's style, types, or dead branches;
 * nothing about the generators listed in `NOT_GATED`; and on a machine without
 * `python3` it says NOTHING AT ALL — see `SKIP_MEANING`.
 *
 * Usage:  bun scripts/check-generator-faithfulness.ts
 *
 * Its enforcing reader is `scripts/check-generator-faithfulness.test.ts`,
 * because CI runs `bun test` and never runs `validate:ci`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  appendFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dir ?? new URL('.', import.meta.url).pathname
export const REPO = resolve(HERE, '..')

/**
 * What a skipped run means. Printed on skip and asserted by the reader, because
 * a skipped gate that is read as a passed gate is worse than no gate.
 */
export const SKIP_MEANING =
  'SKIPPED IS NOT PASSED: nothing was compared. This gate needs `python3` and `git`; the CI image is '
  + 'nodejs-22 and carries no Python, so it skips there BY DESIGN and the drift is caught on developer '
  + 'machines and in pre-commit instead. If it must run in CI, the fix is a Python in the image — never '
  + 'a weaker assertion here.'

export type GeneratorMode = 'stdout' | 'in-place'

export interface Generator {
  /** Repo-relative path of the generator. */
  script: string
  /** `stdout` artifacts are redirected by hand; `in-place` writers open the file themselves. */
  mode: GeneratorMode
  /** Repo-relative artifacts, in the order the generator writes them. */
  artifacts: string[]
  /** What it reads, and whether that input set is stable — the honest half. */
  inputs: string
  /** How to regenerate, verbatim, for the failure message. */
  regenerate: string
}

export const GENERATORS: Generator[] = [
  {
    script: 'scripts/build-parity-report.py',
    mode: 'stdout',
    artifacts: ['docs/superpowers/specs/2026-07-30-parity-report.md'],
    inputs:
      'the parity audit, the deviation register, the doc-sweep worklist and ALL of '
      + 'docs/superpowers/plans/ — an input set that legitimately changes every day, which is why this '
      + 'gate compares committed output against committed inputs and nothing else. It also asks '
      + '`git ls-files -- docs docs-site` for OUR own documents, which is why the extraction carries an '
      + 'index (see extractHead); without one it degrades rather than failing. It has a --check mode '
      + '(a8782cff5); that mode is the tool, this is the reader.',
    regenerate: 'python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md',
  },
  {
    script: 'scripts/regenerate-deviation-register.py',
    mode: 'stdout',
    artifacts: ['docs/superpowers/specs/2026-07-29-deviation-register.md'],
    inputs:
      'every plan, spec and architecture doc, harvested for deviation bullets. AGENTS.md calls this one '
      + 'out by name because it has silently drifted stale by a third once before.',
    regenerate:
      'python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md',
  },
  {
    script: 'scripts/build-doc-sweep-report.py',
    mode: 'in-place',
    artifacts: [
      'docs/superpowers/specs/2026-08-02-claude-doc-sweep-divergences.md',
      'docs/superpowers/specs/2026-08-02-claude-doc-sweep-worklist.md',
      'docs/superpowers/specs/data/2026-08-02-doc-sweep-divergences.tsv',
      'docs/superpowers/specs/data/2026-08-02-doc-sweep-worklist.tsv',
    ],
    inputs:
      'the phase-1/2/3 sweep datasets under docs/superpowers/specs/data — frozen, so this one should be '
      + 'byte-stable indefinitely. It date-stamps its own output, which is preserved across a re-run '
      + 'rather than restamped; a gate that failed on the stamp would be measuring the clock.',
    regenerate: 'python3 scripts/build-doc-sweep-report.py',
  },
  {
    script: 'scripts/build-parity-verification-checklist.py',
    mode: 'in-place',
    artifacts: ['docs/testing/parity-wave-verification-checklist.md'],
    inputs: 'the same frozen sweep datasets plus the doc-sweep parity-wave plan.',
    regenerate: 'python3 scripts/build-parity-verification-checklist.py',
  },
  {
    script: 'scripts/merge-doc-sweep-verdicts.py',
    mode: 'in-place',
    artifacts: ['docs/superpowers/specs/data/2026-07-31-doc-sweep-phase2.json'],
    inputs:
      'the per-finding challenger verdicts, folded onto the phase-1 findings. Gated because the file it '
      + 'writes is the INPUT to build-doc-sweep-report.py: a drift here moves two more artifacts.',
    regenerate: 'python3 scripts/merge-doc-sweep-verdicts.py',
  },
]

export interface NotGated {
  script: string
  why: string
}

/**
 * Every other `scripts/*.py`, with the reason it is not gated.
 *
 * This list is the completeness half — the thing that makes this a guard rather
 * than a check on five files. A new generator cannot slip in ungated: the reader
 * walks `scripts/` and requires every `.py` to be in one list or the other.
 */
export const NOT_GATED: NotGated[] = [
  {
    script: 'scripts/build-doc-sweep-analysis-wf.py',
    why: 'Emits a workflow script to a path given on argv. Nothing it writes is committed.',
  },
  {
    script: 'scripts/build-doc-sweep-challenge-wf.py',
    why:
      'A workflow emitter for the phase-2 challengers, argv-driven. Re-runnable by design, and its '
      + 'output is not committed — there is no artifact for it to be faithful to.',
  },
  {
    script: 'scripts/build-doc-sweep-remediation-wf.py',
    why:
      'A workflow emitter for the phase-2.5 remediation specs, argv-driven. Same shape as the other two: '
      + 'nothing it writes is committed.',
  },
  {
    script: 'scripts/doc-sweep-extract.py',
    why: 'Prints one slice of a dataset to stdout for an agent to read. There is no artifact to be faithful to.',
  },
  {
    script: 'scripts/plan-status.py',
    why:
      'A reporter, not a generator: it reads the parity-closure plan and the capability ledger and prints '
      + 'the two axes to stdout (row counts, and per-runtime coverage), writing nothing. Its only file '
      + 'access is `io.open(..)` for reading, and the wave briefs invoke it as '
      + '`python3 scripts/plan-status.py --since <sha>` and read the output. Both inputs are moving '
      + 'targets every lane edits, so gating it would be measuring other lanes, not this script.',
  },
  {
    script: 'scripts/promote-doc-sweep-to-audit.py',
    why:
      'Deliberately not idempotent — it refuses to run twice, having already promoted its rows into the '
      + 'parity audit. Re-running it to compare output is the one thing it exists to prevent.',
  },
  {
    script: 'scripts/refresh-claude-doc-pages.py',
    why:
      'Rebuilds claude-doc-pages.tsv from llms.txt read on STDIN, so it needs the network and a piped '
      + 'fetch. An offline gate would only ever measure the absence of a fetch.',
  },
  {
    script: 'scripts/sort-plan-tracker.py',
    why:
      'A fixer, not a generator: it reorders a plan\'s tracker rows and refuses to change their content. '
      + 'Its --check belongs to whoever edits a plan (AGENTS.md says to run it after any row addition), '
      + 'and every plan in the tree is a moving target — gating it here would be measuring other lanes.',
  },
]

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type FindingKind = 'ungated-generator' | 'stale-registration' | 'crashed' | 'drifted' | 'artifact-missing'

export interface Finding {
  kind: FindingKind
  subject: string
  detail: string
}

/** Every `.py` in `scripts/` is either gated or excused, and every entry is real. */
export function auditRegistry(scriptsDir: string = HERE): Finding[] {
  const findings: Finding[] = []
  const present = readdirSync(scriptsDir)
    .filter(name => name.endsWith('.py'))
    .map(name => `scripts/${name}`)
    .sort()
  const registered = new Set([...GENERATORS.map(entry => entry.script), ...NOT_GATED.map(entry => entry.script)])

  for (const script of present) {
    if (registered.has(script)) continue
    findings.push({
      kind: 'ungated-generator',
      subject: script,
      detail:
        'a Python script in scripts/ that is neither faithfulness-gated nor listed in NOT_GATED with a '
        + 'reason. If it writes a committed artifact, add it to GENERATORS; if it does not, say so.',
    })
  }
  for (const script of registered) {
    if (present.includes(script)) continue
    findings.push({
      kind: 'stale-registration',
      subject: script,
      detail: 'registered here and no such file exists any more. Renamed, moved, or deleted.',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

export interface ArtifactVerdict {
  artifact: string
  identical: boolean
  /** Bytes of the committed artifact. */
  bytes: number
  /** First differing line (1-based) and both sides of it, when they differ. */
  detail?: string
}

/**
 * Compare a produced artifact with its committed self.
 *
 * Byte-identity, reported at the first differing LINE — a diff nobody can act on
 * is a diff nobody acts on. Kept pure so its own positive control needs neither
 * Python nor a git archive, which is how the drift detector stays tested on a
 * machine where the gate itself skips.
 */
export function compareArtifact(artifact: string, committed: string, produced: string): ArtifactVerdict {
  const bytes = Buffer.byteLength(committed, 'utf-8')
  if (committed === produced) return { artifact, identical: true, bytes }
  const left = committed.split('\n')
  const right = produced.split('\n')
  const at = left.findIndex((line, index) => line !== right[index])
  const line = at === -1 ? Math.min(left.length, right.length) + 1 : at + 1
  const clip = (text: string | undefined): string =>
    text === undefined ? '<past end of file>' : text.length > 120 ? `${text.slice(0, 117)}…` : text
  return {
    artifact,
    identical: false,
    bytes,
    detail:
      `first differs at line ${line} of ${left.length} (produced ${right.length} lines)\n`
      + `      committed: ${clip(left[at === -1 ? left.length : at])}\n`
      + `      produced : ${clip(right[at === -1 ? right.length : at])}`,
  }
}

export interface Report {
  /** Set when nothing ran. Never means "passed". */
  skipped?: string
  findings: Finding[]
  verdicts: ArtifactVerdict[]
}

export interface FaithfulnessOptions {
  /** Gate only these generators, by script path. */
  only?: readonly string[]
  /**
   * Mutate the extracted archive before anything is read or run. The positive
   * control uses it to plant drift; nothing else should.
   */
  doctor?: (archiveDir: string) => void
}

export function pythonExecutable(): string | undefined {
  for (const candidate of ['python3', 'python']) {
    const probe = Bun.spawnSync([candidate, '--version'], { stdout: 'pipe', stderr: 'pipe' })
    if (probe.exitCode === 0) return candidate
  }
  return undefined
}

export function gitAvailable(): boolean {
  return Bun.spawnSync(['git', 'rev-parse', '--git-dir'], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' }).exitCode === 0
}

/**
 * ONE extraction of HEAD, reused by every generator — `P2.348`.
 *
 * Only `scripts/` and `docs/`: every gated generator reads only from them, so a
 * generator that reaches outside fails LOUDLY here instead of quietly passing on
 * a working-tree file. 718 files, 30 MB, measured.
 *
 * WHY IT IS ONE AND NOT FIVE. The extraction used to be per generator, so five
 * `git archive` + `tar` pairs of the same immutable tree ran per call. That is
 * I/O whose duration is set by whatever else is on the box: the same pair timed
 * 2.7 s, 23.0 s and 4.0 s on consecutive runs, and the enforcing test's 120 s
 * budget was exceeded at 193 s on a load average of 21.5 while passing in
 * seconds on a quiet one — a red carrying no information. Re-measured
 * 2026-09-03 at load 17.6: `git archive` 335 ms, `tar -xf` 1 018 ms, so the
 * five pairs were ~6.8 s of the 9.1 s a whole run took.
 *
 * WHY NOT A COPY PER GENERATOR, which is the obvious way to keep the isolation.
 * Measured on the same rig and it is not cheaper: `cp -Rc` (APFS clone) of the
 * extracted tree took 74 984 ms cold under lane contention and 1 206 ms warm,
 * against 1 060 ms for simply re-extracting the tar. A copy buys nothing.
 *
 * HOW THE ISOLATION IS KEPT ANYWAY. Two of these generators write their
 * artifacts IN PLACE, so a shared directory could feed one generator's output to
 * the next one's inputs — which would quietly change what a finding means (a
 * drifted register would then be the input the report is built from). So the
 * tar is KEPT rather than deleted, `restore()` returns the tree to HEAD's exact
 * bytes between generators, and it decides what to restore by comparing every
 * file's size and mtime against the listing taken immediately after extraction:
 * a file the run created is removed, a file it changed or deleted is re-extracted
 * from the tar by name. That is exact for writes this gate does NOT know about
 * as well as for the declared artifacts, which the older per-generator
 * extraction was also exact about and a naive artifact-only restore would not be.
 */
export interface HeadWorkspace {
  /** The extraction root — a generator's cwd, and what artifact paths join onto. */
  readonly dir: string
  /**
   * Put the extraction back to HEAD's bytes; returns the repo-relative paths it
   * had to touch, so a caller can see whether a generator wrote outside its own
   * declared artifacts.
   */
  restore: () => string[]
  discard: () => void
}

interface FileStamp {
  readonly size: number
  readonly mtimeMs: number
}

/**
 * Every file under `root`, by path relative to it. Directories are not listed.
 *
 * Walked by hand rather than with `readdirSync(recursive)`, whose `Dirent`
 * carries the parent under two different property names across runtimes — a
 * detail that would make the listing silently empty rather than wrong.
 */
function listTree(root: string, prefix = '', stamps = new Map<string, FileStamp>()): Map<string, FileStamp> {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
    // The extraction's own `.git` (see {@link extractHead}) is not an input and
    // not an artifact: git rewrites its index as a side effect of being asked a
    // question, so a restore verified against the tar would throw over bytes no
    // generator wrote.
    if (path === '.git' || path.startsWith('.git/')) continue
    if (entry.isDirectory()) {
      listTree(root, path, stamps)
      continue
    }
    if (!entry.isFile()) continue
    const stat = statSync(join(root, path))
    stamps.set(path, { size: stat.size, mtimeMs: stat.mtimeMs })
  }
  return stamps
}

/**
 * Extract HEAD's `scripts`, `docs` and `docs-site` into a temp dir, and make
 * that dir a git work tree whose INDEX holds exactly those bytes.
 *
 * The index is not decoration, and the day it was missing this gate reported a
 * drift that did not exist. `build-parity-report.py` asks
 * `git ls-files -- docs docs-site` for "our own documents" so that a citation
 * to one of OUR files is not counted as somebody's documentation. Outside a
 * repository that call exits 128, and the generator does exactly what its own
 * docblock promises — it degrades, warns on stderr, and counts this repo's own
 * docs as foreign citations. The gate throws the stderr away and compares only
 * stdout, so the degradation arrived as *"§3b — 73 vs 99, the committed
 * artifact is stale"* about a file `--check` called up to date. Measured
 * 2026-09-11 on the gate's own extraction: 50 differing lines with no index,
 * **0** with one.
 *
 * `docs-site` is archived for the same sentence's sake — the generator asks git
 * for both trees, and an index that cannot see one of them answers half the
 * question.
 *
 * `add -Af` rather than `add -A`: the extraction carries no root `.gitignore`,
 * but a developer's `core.excludesFile` would otherwise decide what HEAD
 * contains.
 */
export function extractHead(): HeadWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'nessy-generator-faithfulness-'))
  const dir = join(root, 'head')
  const tar = join(root, 'head.tar')
  mkdirSync(dir)
  const archived = Bun.spawnSync(
    ['git', 'archive', '--format=tar', '-o', tar, 'HEAD', 'scripts', 'docs', 'docs-site'],
    { cwd: REPO, stdout: 'pipe', stderr: 'pipe' },
  )
  if (archived.exitCode !== 0) {
    discard(root)
    throw new Error(`git archive failed: ${archived.stderr.toString()}`)
  }
  const extracted = Bun.spawnSync(['tar', '-xf', tar, '-C', dir], { stdout: 'pipe', stderr: 'pipe' })
  if (extracted.exitCode !== 0) {
    discard(root)
    throw new Error(`tar failed: ${extracted.stderr.toString()}`)
  }
  for (const argv of [['git', 'init', '-q', dir], ['git', '-C', dir, 'add', '-Af']]) {
    const step = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
    if (step.exitCode !== 0) {
      discard(root)
      throw new Error(
        `${argv.join(' ')} failed inside the HEAD extraction: ${step.stderr.toString().trim()}. `
        + 'Without an index a generator that asks `git ls-files` degrades instead of failing, and this '
        + 'gate would report its degraded output as drift in the committed artifact.',
      )
    }
  }
  const pristine = listTree(dir)
  return {
    dir,
    restore(): string[] {
      const current = listTree(dir)
      const touched: string[] = []
      const reExtract: string[] = []
      for (const path of current.keys()) {
        if (pristine.has(path)) continue
        rmSync(join(dir, path), { force: true })
        touched.push(path)
      }
      for (const [path, stamp] of pristine) {
        const now = current.get(path)
        if (now && now.size === stamp.size && now.mtimeMs === stamp.mtimeMs) continue
        reExtract.push(path)
        touched.push(path)
      }
      // Chunked: a restore of many files must not run into the argv limit, and a
      // silent partial restore is the failure this whole mechanism exists to avoid.
      for (let index = 0; index < reExtract.length; index += 200) {
        const batch = reExtract.slice(index, index + 200)
        const result = Bun.spawnSync(['tar', '-xf', tar, '-C', dir, '--', ...batch], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        if (result.exitCode !== 0) {
          throw new Error(
            `restoring the HEAD extraction failed (${batch.length} paths): ${result.stderr.toString().trim()}. `
            + 'Every verdict after this point would have been taken against a tree the previous generator '
            + 'had written into, so this throws rather than continuing.',
          )
        }
      }
      // The restore has to be verifiable, not merely attempted: an mtime that did
      // not come back means the tar did not carry the path.
      const after = listTree(dir)
      for (const [path, stamp] of pristine) {
        const now = after.get(path)
        if (now && now.size === stamp.size) continue
        throw new Error(
          `${path} was not restored from HEAD's archive — the extraction is no longer pristine, `
          + 'so the remaining generators would be measured against a dirty tree.',
        )
      }
      return touched
    },
    discard(): void {
      discard(root)
    },
  }
}

/**
 * Remove a directory this process created under the OS temp dir.
 *
 * The prefix is re-checked here rather than trusted from the caller. An agent in
 * this repo destroyed unrecoverable user data on 2026-08-25 by pointing a
 * recursive delete at a real home directory; a recursive delete whose operand
 * can only ever be one of our own mkdtemp paths costs one line.
 */
function discard(dir: string): void {
  const prefix = join(tmpdir(), 'nessy-generator-faithfulness-')
  if (!dir.startsWith(prefix) || dir === prefix) {
    throw new Error(`refusing to delete ${dir}: not one of this gate's temporary directories`)
  }
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Run one generator in a pristine copy of HEAD and compare what it wrote.
 *
 * Kept at its original signature — it extracts and discards its own workspace —
 * so an existing caller is unaffected by `P2.348`. `checkFaithfulness` uses
 * `checkGeneratorIn` instead, which is the same body against a workspace the
 * caller owns and restores.
 */
export function checkGenerator(generator: Generator, python: string, doctor?: (dir: string) => void): {
  findings: Finding[]
  verdicts: ArtifactVerdict[]
} {
  const workspace = extractHead()
  try {
    return checkGeneratorIn(workspace.dir, generator, python, doctor)
  } finally {
    workspace.discard()
  }
}

/** The comparison itself, in a workspace whose lifetime the caller owns. */
export function checkGeneratorIn(
  dir: string,
  generator: Generator,
  python: string,
  doctor?: (dir: string) => void,
): { findings: Finding[]; verdicts: ArtifactVerdict[] } {
  const findings: Finding[] = []
  const verdicts: ArtifactVerdict[] = []
  doctor?.(dir)
  const committed = new Map<string, string>()
  for (const artifact of generator.artifacts) {
    const path = join(dir, artifact)
    if (!existsSync(path)) {
      findings.push({
        kind: 'artifact-missing',
        subject: artifact,
        detail: `${generator.script} is gated on this artifact and HEAD does not carry it.`,
      })
      continue
    }
    committed.set(artifact, readFileSync(path, 'utf-8'))
  }
  if (committed.size === 0) return { findings, verdicts }

  const run = Bun.spawnSync([python, generator.script], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) {
    findings.push({
      kind: 'crashed',
      subject: generator.script,
      detail:
        `exited ${run.exitCode} on HEAD's own inputs. Nothing else validates these scripts, so this is `
        + `the first reader that would ever have noticed.\n      ${run.stderr.toString().trim().split('\n').slice(-6).join('\n      ')}`,
    })
    return { findings, verdicts }
  }

  for (const [artifact, expected] of committed) {
    const produced =
      generator.mode === 'stdout' ? run.stdout.toString() : readFileSync(join(dir, artifact), 'utf-8')
    const verdict = compareArtifact(artifact, expected, produced)
    verdicts.push(verdict)
    if (verdict.identical) continue
    findings.push({
      kind: 'drifted',
      subject: artifact,
      detail:
        `${generator.script} no longer reproduces this artifact from HEAD's inputs.\n      `
        + `${verdict.detail}\n      Inputs: ${generator.inputs}\n      Regenerate: ${generator.regenerate}`,
    })
  }
  return { findings, verdicts }
}

export function checkFaithfulness(options: FaithfulnessOptions = {}): Report {
  const findings = auditRegistry()
  const python = pythonExecutable()
  if (python === undefined) return { skipped: `no python3 on PATH. ${SKIP_MEANING}`, findings, verdicts: [] }
  if (!gitAvailable()) return { skipped: `no git work tree here. ${SKIP_MEANING}`, findings, verdicts: [] }

  const verdicts: ArtifactVerdict[] = []
  // P2.348 — one extraction, restored between generators, rather than one per
  // generator. `restore()` is what keeps each generator's inputs HEAD's own.
  const workspace = extractHead()
  try {
    for (const generator of GENERATORS) {
      if (options.only && !options.only.includes(generator.script)) continue
      const result = checkGeneratorIn(workspace.dir, generator, python, options.doctor)
      findings.push(...result.findings)
      verdicts.push(...result.verdicts)
      workspace.restore()
    }
  } finally {
    workspace.discard()
  }
  return { findings, verdicts }
}

/** Plant drift in one artifact — the end-to-end positive control's only use. */
export function plantDrift(artifact: string): (dir: string) => void {
  return dir => appendFileSync(join(dir, artifact), '\n<!-- planted by the positive control -->\n')
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const report = checkFaithfulness()
  for (const finding of report.findings) console.error(`[${finding.kind}] ${finding.subject}\n    ${finding.detail}`)
  if (report.skipped !== undefined) {
    console.warn(`generator faithfulness: ${report.skipped}`)
  } else {
    console.log(
      `generator faithfulness: ${report.verdicts.filter(verdict => verdict.identical).length}/${report.verdicts.length} `
      + `artifacts byte-identical to what ${GENERATORS.length} generators produce from HEAD; `
      + `${NOT_GATED.length} scripts not gated, each with a reason. This says nothing about whether an `
      + 'artifact is CORRECT — only that it is reproducible.',
    )
  }
  if (report.findings.length > 0) {
    console.error(`\n${report.findings.length} finding(s).`)
    process.exit(1)
  }
  process.exit(report.skipped === undefined ? 0 : 0)
}
