/**
 * The enforcing reader for `check-generator-faithfulness.ts`.
 *
 * CI runs `bun test`; it does not run `validate:ci`, and `test:doc-tools` — the
 * only Python step in `package.json` — is commented out. So this is the only
 * channel through which anything at all reads `scripts/*.py`.
 *
 * ON CI THE COMPARISON CASES RUN — this docblock said the opposite until
 * 2026-09-23 (F1.109). The `nodejs-22` image the `test` job runs on DOES carry
 * Python: in the job logs of pipelines 126374378 and 126377033 (2026-09-20) the
 * case `reproduces every committed artifact byte-for-byte from HEAD` reads
 * `(pass)` (3322.70 ms, then 3002.80 ms in the chunked run) and the
 * Python-absent case reads `(skip)`; the `lint` job's first script step is
 * `python3 --version` on the same `.bun-job` anchor. So a drifted artifact is a
 * CI red, not only a developer-machine one — which is how D1.422's date decay
 * became a merge blocker. A job log line is the instrument; re-read one rather
 * than trusting this sentence.
 *
 * WHAT A SKIP MEANS HERE, where Python IS absent: the comparison cases — the
 * ones gated on `canRun` — SKIP, while the registry, comparator and extraction
 * cases still run; the extraction ones need only git. A skipped case is not a
 * passed case; the reason is printed to the run log and asserted in
 * `SKIP_MEANING`, and the case that asserts the skip carries its reason is the
 * one that runs when Python is absent. This is the deliberate shape (`P2.177`):
 * a machine without Python stays green and says so, rather than a Python-syntax
 * gate that fails for the wrong reason and gets switched off — which is what
 * happened to `test:doc-tools`.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GENERATORS,
  NOT_GATED,
  SKIP_MEANING,
  auditRegistry,
  checkFaithfulness,
  REPO,
  compareArtifact,
  extractHead,
  gitAvailable,
  plantDrift,
  pythonExecutable,
} from './check-generator-faithfulness.ts'

const python = pythonExecutable()
const canRun = python !== undefined && gitAvailable()
if (!canRun) console.warn(`[generator faithfulness] ${SKIP_MEANING}`)

const REGISTER = 'docs/superpowers/specs/2026-07-29-deviation-register.md'

describe('generator faithfulness — the registry', () => {
  it('accounts for every Python script in scripts/', () => {
    // Runs everywhere, Python or not: it is a directory listing. This is the half
    // that makes the gate a guard — a new generator cannot slip in ungated.
    expect(auditRegistry().map(finding => `[${finding.kind}] ${finding.subject}`)).toEqual([])
  })

  it('gates something, and says why each ungated script is ungated', () => {
    expect(GENERATORS.length).toBeGreaterThanOrEqual(5)
    expect(GENERATORS.flatMap(generator => generator.artifacts).length).toBeGreaterThanOrEqual(8)
    for (const generator of GENERATORS) {
      expect(generator.artifacts.length).toBeGreaterThan(0)
      // The failure message has to carry the command, or the gate is a riddle.
      expect(generator.regenerate).toContain(generator.script)
      // The honest half: what it reads, and whether that set moves.
      expect(generator.inputs.length).toBeGreaterThan(60)
    }
    for (const excused of NOT_GATED) expect(excused.why.length).toBeGreaterThan(60)
  })

  it('fires on a Python script nobody registered', () => {
    // The positive control for the completeness half. Without it, "no findings"
    // is indistinguishable from a registry check that reports nothing ever — and
    // this plan has already shipped one guard that matched nothing at all.
    const dir = mkdtempSync(join(tmpdir(), 'p2177-registry-control-'))
    try {
      writeFileSync(join(dir, 'zzz-new-generator.py'), 'print("hi")\n')
      const findings = auditRegistry(dir)
      expect(findings.filter(finding => finding.kind === 'ungated-generator').map(finding => finding.subject))
        .toEqual(['scripts/zzz-new-generator.py'])
      // And the mirror: everything registered is missing from this directory.
      expect(findings.filter(finding => finding.kind === 'stale-registration').length)
        .toBe(GENERATORS.length + NOT_GATED.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('states what a skip means, in the gate itself', () => {
    expect(SKIP_MEANING).toContain('SKIPPED IS NOT PASSED')
    expect(SKIP_MEANING).toContain('python3')
    expect(SKIP_MEANING).toContain('never')
  })
})

describe('generator faithfulness — the comparator', () => {
  it('calls identical text identical', () => {
    // Runs without Python: the drift detector stays tested on the very machines
    // where the gate around it skips.
    expect(compareArtifact('a.md', 'one\ntwo\n', 'one\ntwo\n')).toEqual({ artifact: 'a.md', identical: true, bytes: 8 })
  })

  it('finds the first differing line, and does not stop at a length match', () => {
    const changed = compareArtifact('a.md', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')
    expect(changed.identical).toBe(false)
    expect(changed.detail).toContain('first differs at line 2 of 4')

    const truncated = compareArtifact('a.md', 'one\ntwo\n', 'one\n')
    expect(truncated.identical).toBe(false)
    expect(truncated.detail).toContain('produced 2 lines')

    // A single trailing newline is drift. Byte-identity means byte-identity.
    expect(compareArtifact('a.md', 'one\n', 'one').identical).toBe(false)
  })
})

describe('generator faithfulness — the HEAD extraction is a git work tree', () => {
  it.skipIf(!gitAvailable())('answers `git ls-files`, or a generator that asks it degrades in silence', () => {
    // The regression this pins cost a whole false finding on 2026-09-11:
    // `build-parity-report.py` asks `git ls-files -- docs docs-site` to tell OUR
    // documents from someone's contract, the extraction was not a repository, the
    // call exited 128, and the generator did exactly what its docblock promises —
    // degraded, warned on stderr, and counted 99 foreign citations where the
    // committed artifact says 73. The gate reads stdout only, so the degradation
    // arrived as "the committed artifact is stale" about a file `--check` called
    // up to date.
    const workspace = extractHead()
    try {
      const listed = (...pathspec: string[]): string[] =>
        Bun.spawnSync(['git', '-C', workspace.dir, 'ls-files', '--', ...pathspec], { stdout: 'pipe', stderr: 'pipe' })
          .stdout.toString().split('\n').filter(line => line.length > 0)
      // Both trees the generator names, because an index that can see one of them
      // answers half the question and looks like an answer.
      expect(listed('docs').length).toBeGreaterThan(100)
      expect(listed('docs-site').length).toBeGreaterThan(0)
      expect(listed('scripts')).toContain('scripts/build-parity-report.py')
      // The other half of the same fix: nothing in the extraction reads as
      // untracked, which is what that generator excludes inputs by.
      const others = Bun.spawnSync(
        ['git', '-C', workspace.dir, 'ls-files', '--others', '--exclude-standard', '--', 'docs/superpowers'],
        { stdout: 'pipe', stderr: 'pipe' },
      ).stdout.toString().trim()
      expect(others).toBe('')
    } finally {
      workspace.discard()
    }
  }, 120_000)

  it.skipIf(!gitAvailable())('restores to pristine even though git rewrites its own index', () => {
    // `listTree` skips `.git` for this reason: asking git a question touches the
    // index, and a restore verified against the tar would throw over bytes no
    // generator wrote.
    const workspace = extractHead()
    try {
      Bun.spawnSync(['git', '-C', workspace.dir, 'status', '--porcelain'], { stdout: 'pipe', stderr: 'pipe' })
      expect(workspace.restore()).toEqual([])
    } finally {
      workspace.discard()
    }
  }, 120_000)
})

describe('generator faithfulness — against HEAD', () => {
  it.skipIf(canRun)('reports the skip WITH its reason when Python is absent', () => {
    const report = checkFaithfulness()
    expect(report.skipped).toContain('SKIPPED IS NOT PASSED')
    expect(report.verdicts).toEqual([])
    // The registry half still ran.
    expect(report.findings).toEqual([])
  })

  it.skipIf(!canRun)('reproduces every committed artifact byte-for-byte from HEAD', () => {
    const report = checkFaithfulness()
    expect(report.skipped).toBeUndefined()
    expect(report.findings.map(finding => `[${finding.kind}] ${finding.subject}`)).toEqual([])
    // Positive control on the run itself: an empty verdict list would also
    // produce no findings.
    expect(report.verdicts.length).toBe(GENERATORS.flatMap(generator => generator.artifacts).length)
    expect(report.verdicts.every(verdict => verdict.identical)).toBe(true)
    // The budget is set against the MEASURED run, not a round number: this case
    // runs all five generators, and two of them cost ~85 s wall each on this box
    // at 0.6 s user — per-file-open latency under concurrent lanes, which no CPU
    // load average reports. The whole gate measured 124.26 s and then 249.32 s
    // (load 8.0 / 7.8, `user 1.87 sys 2.14` and `user 2.07 sys 2.40`) on
    // 2026-09-11, so 120 s was under the floor and 600 s is ~2.4x the larger.
  }, 600_000)

  it.skipIf(!canRun)('goes RED when an artifact is changed under it', () => {
    // The end-to-end positive control. A gate that cannot go red is
    // indistinguishable from no gate, and this repo has already shipped one
    // absence check that matched nothing.
    const report = checkFaithfulness({
      only: ['scripts/regenerate-deviation-register.py'],
      doctor: plantDrift(REGISTER),
    })
    expect(report.findings.map(finding => [finding.kind, finding.subject])).toEqual([['drifted', REGISTER]])
    expect(report.verdicts.map(verdict => verdict.identical)).toEqual([false])
    // It names the command that fixes it, in the finding itself.
    expect(report.findings[0]?.detail).toContain('python3 scripts/regenerate-deviation-register.py')
    // One generator, and it measured 85.61 s wall at 0.24 s user on this box
    // (2026-09-11). See the budget note on the whole-set case above.
  }, 300_000)

  it.skipIf(!canRun)('leaves the working tree alone — three of these generators write in place', () => {
    // Scoped to the artifacts on purpose. A whole-tree `git status` comparison
    // was tried first and flaked immediately: five lanes are writing this
    // checkout, so the unscoped status gained a line from someone else's file
    // between the two calls. A detector that measures other lanes measures
    // nothing.
    const writers = GENERATORS.filter(generator => generator.mode === 'in-place')
    const paths = writers.flatMap(generator => generator.artifacts)
    expect(paths.length).toBeGreaterThan(3)
    const status = (): string =>
      Bun.spawnSync(['git', 'status', '--porcelain', '--', ...paths], { cwd: REPO }).stdout.toString()
    const before = status()
    checkFaithfulness({ only: writers.map(generator => generator.script) })
    expect(status()).toBe(before)
    // Three generators. Same measured floor as the cases above.
  }, 300_000)
})
