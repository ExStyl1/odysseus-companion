/**
 * run-gates — run every step of a gate chain and report ALL of them.
 *
 * P2.222. `typecheck:all` and `lint` were both `&&` chains, and an `&&` chain
 * is a gate that stops gating at its first red:
 *
 *   - measured at this branch's tip, `typecheck:all` was RED at
 *     `packages/server-core` — the THIRD of fourteen links — so roughly ten
 *     packages were never typechecked at all, and CI's typecheck job failed
 *     with nothing saying which packages had not been looked at;
 *   - P2.106's reviewer planted a violation in the root `lint` chain and
 *     measured the same thing in miniature: one red at `lint:server-core` and
 *     `lint:ui` / `lint:scripts` were never executed.
 *
 * Both scripts are one defect, so both are run through here. The chain body
 * stays in package.json (`<name>:chain`) because that is where a reader looks
 * for what a gate covers; this script is only the thing that refuses to stop
 * early.
 *
 *
 * **Which half of D1.1's split this gate sits in:** the collecting runner itself
 * is a pure derivation over plain values and rides every lane's own
 * `typecheck:<pkg>`/`lint` invocation; its own invariants — that a red step
 * never suppresses a later one, that a KILLED step is not a pass, that the
 * verdict survives a `| tail` — are asserted in `run-gates.test.ts`, which rides
 * the root `bun test` and is therefore a MERGE-time protection. That is the
 * trade D1.1 states as policy rather than a gap: see
 * `packages/pi-agent-server/scripts/check-surface-selftest.ts` §"The SPLIT is
 * the policy" for the guarantee it rests on and the four reasons the obvious
 * alternative is worse.
 *
 * What it guarantees, in the order the failures actually happened:
 *
 *   1. EVERY step runs. A red step never suppresses a later one.
 *   2. Every step gets a WORD: PASS / FAIL (exit n) / KILLED. A step killed
 *      mid-run (exit >= 128, Bun's OOM abort is 134) is the third outcome, and
 *      it has been recorded as a pass on this branch before (P2.353).
 *   3. The verdict is the LAST thing printed, and it names the red steps.
 *      P2.275: `pipefail` is off by default, so `bun run lint | tail -20`
 *      reports tail's status, not the gate's — a `| tail` therefore has to
 *      still SHOW the verdict, because the exit status may not survive.
 *      An exit status says a process ended; the output says what it did.
 *   4. A step names the TSCONFIG it ran — or, when it compiles nothing, the
 *      SCRIPT it ran (P2.416) — in the banner, the summary table AND
 *      the verdict, not just its own nickname. P2.390: two lanes saw one
 *      diagnostic within an hour and attributed it to two different owners,
 *      because a step called `typecheck:scripts` printed a red against a file
 *      under `apps/electron/`. Both guesses were wrong, and a gate that
 *      misnames the owner of a failure sends every lane to audit the wrong
 *      zone. See `gate-projects.ts` for the measurement.
 *
 * ## What the chain COSTS, measured rather than assumed (P2.506)
 *
 * P2.506 was opened on the reading that the lint chain "now reads the whole tree
 * three times where it read it once", at a measured 201 s + 192 s + 182 s, with
 * the conclusion that the box's filesystem is the cost, that no optimisation is
 * warranted, and that the open question is whether to fold three walks into one.
 * **Re-measured on this branch 2026-09-03/04 — TWICE, because one reading would
 * have been wrong — the durations are nothing like those three and the shape of
 * the question changes.** There is no three-way tie; there is one step, or two
 * depending on the run, that dwarfs everything else. There are also EIGHT steps
 * in the chain that touch the repo broadly, not three, and four of them do walk
 * the whole tree:
 *
 * | Step | Duration | Enumerates by |
 * | --- | --- | --- |
 * | Step | Run A, alone | Run B, in chain | Enumerates by |
 * | --- | --- | --- | --- |
 * | `lint:nul-bytes` | **874.3 s** | **231.6 s** | `git ls-files`, then every BYTE of every `.ts`/`.tsx` |
 * | `lint:i18n:reachable` | 2.5 s | **764.2 s** (red) | `git ls-files`, then reads 2 538 source files |
 * | `lint:shared` | 17.8 s | 19.3 s | ESLint over 1 468 files |
 * | `lint:minified-citations` | 9.4 s | 11.1 s | `git grep -l` selects candidates |
 * | `lint:comment-globs` | 4.6 s | 1.7 s | `git ls-files` then reads them |
 * | `lint:conditional-expect` | 3.3 s | 1.3 s | filesystem walk, test files only (a `git ls-files` listing + one blob batch since F1.608) |
 * | `lint:exports-map` | 1.4 s | 2.1 s (red) | a single `git grep` |
 * | `lint:matcher-mutation` | 0.9 s | 1.1 s | the same enumeration as `conditional-expect`, a second time |
 * | `lint:coverage` | 0.2 s | 2.1 s | package directories only |
 *
 * Run A ran each step alone in chain order; run B is `bun run lint` an hour
 * later, same box, same branch, load 13 both times. **The two runs disagree by
 * 4x on one step and by 300x on another, and they disagree in OPPOSITE
 * directions** — page-cache warmth and seven sibling lanes decide the numbers far
 * more than the gates do. Any conclusion drawn from one column alone is a
 * conclusion about that afternoon.
 *
 * **The decision, so the next reader does not re-derive it: do NOT couple the
 * walks.** Two things survive both runs. First, the cost is concentrated in the
 * one or two gates that read every tracked file's CONTENT, never in the number
 * of walks: the four cheap whole-tree steps together are 11.3 s in run A and
 * 6.2 s in run B, so folding them into one shared walk would buy back less than
 * the run-to-run variance of a single expensive step — while creating exactly
 * the coupling that makes a gate hard to remove, and each of those gates is
 * independently justified by a measured defect. Second, the expensive ones
 * cannot adopt the cheap instrument: `check-nul-bytes`'s own header records that
 * `git grep -lI ''` inspects only an ~8000-byte prefix and found 4 of 14 known
 * files, which is why the two gates that DID move to `git grep` selection
 * (`minified-citations`, `exports-map`) cannot be copied for NUL detection.
 * Batching, caching by blob hash, or accepting the cost are all decisions inside
 * `check-nul-bytes.ts`, not decisions about the chain's shape.
 *
 * `check-conditional-expect` reading the tree TWICE — its two selectors are
 * deliberately separate steps so a red names which class it found — is the one
 * genuine duplicate here, and it cost 1.1 s (a walk then; F1.608's listing now). It stays.
 *
 * Every duration above is a READING WITH A DATE. Re-measure before acting on any
 * of them, and take two readings, not one.
 *
 * ## Who calls a chain, and the subset that drifts (P2.431)
 *
 * A chain is only a gate for whoever RUNS it. Measured 2026-08-30 against
 * `.gitlab-ci.yml`: no job runs `validate:ci` at all — the `lint` job runs
 * `bun run lint` plus the two i18n scripts, `typecheck` runs `typecheck:all`,
 * `test` runs `bun test` and `test:shared:all`. So despite its name
 * **`validate:ci` is the DEVELOPER path**, and it is the command AGENTS.md tells
 * people to run before claiming completion.
 *
 * It used to call `bun run lint:coverage` — ONE hand-copied step out of
 * `lint:chain`'s nineteen. P2.416 wired `check-nul-bytes` and
 * `check-conditional-expect` into the chain, CI picked them up through
 * `bun run lint`, and the developer command picked up neither. Two gates that
 * run only in CI, invisible on the path where a defect is cheapest to fix —
 * which is the same shape as the uninvoked guard those two scanners were
 * written to find, and the same shape as `typecheck:all` reporting green while
 * covering step one alone (P2.222).
 *
 * The fix is delegation, not a longer copy: `validate:ci` now runs
 * `bun run lint`, the whole gate, and `lint:coverage` disappears from its body
 * because it is that chain's first step. Adding the two missing steps by hand
 * would have been correct for exactly as long as it took someone to add a
 * twentieth — a subset maintained by memory is the defect, not the fix.
 * `validate-ci-wiring.test.ts` pins the reach transitively so the next
 * narrowing fails a test rather than going unnoticed for a month.
 *
 * Delegation alone did not deliver the row, and the proof run is what said so.
 * With both scanner mutants planted, `bun run validate:ci` exited 1 having run
 * ONE step: `lint:i18n:parity` was red from a sibling lane's locale work, and
 * the `&&` stopped there — so the two scanners this row exists to expose were
 * still never reached, by a developer or by this lane's own acceptance run. The
 * same lane fixed the locales minutes later and the step went green again, which
 * is exactly how invisible this failure mode is: nothing recorded that four
 * gates had been skipped, and re-running proves only that they run TODAY.
 * That is P2.222 in a third chain, and it is not a separate defect to hand on:
 * an unreachable gate is an unreachable gate whether the thing hiding it is a
 * missing step or an earlier red. So `validate:ci` became
 * `run-gates validate:ci:chain` like `lint` and `typecheck:all` before it, and
 * a red i18n step now costs the developer a red LINE rather than every gate
 * behind it.
 *
 * The residue, stated: `validate:dev` is still an `&&` chain of three, so a red
 * `typecheck:all` hides `test:shared:all` and `test:doc-tools`. Left alone
 * deliberately — it is a published command of its own (AGENTS.md lists it), and
 * converting a third chain on the way past is the kind of unasked scope this
 * repo's plans are supposed to keep out of a commit.
 *
 * A chain step must be exactly `bun run <script>`. That is not tidiness: the
 * old `typecheck:all` was a chain of RELATIVE `cd`s (`cd packages/core && … &&
 * cd ../shared && …`), which only works when the segments run in one shell in
 * order — i.e. the shape that makes independent execution impossible is the
 * same shape that makes early-exit blindness inevitable. Each step is now a
 * self-contained script.
 *
 * Usage:
 *   bun scripts/run-gates.ts <chain-script>     # run every step, report all
 *   bun scripts/run-gates.ts <chain-script> --list
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ownershipNote, stepOwnerLabels, stepProjectPaths } from './gate-projects.ts'
import { GateSafetyRefusal, assertNoHomeOrRootPath } from './gate-safety.ts'
import { classifyRun, killedExplanation, type Verdict } from './gate-verdict.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface StepResult {
  name: string
  verdict: Verdict
  seconds: string
  /**
   * The tsconfigs this step compiled, repo-relative. Empty for a step that runs
   * no compiler (a lint step, a coverage check) — P2.390 is about typecheck
   * steps and a guessed label would be the defect it was opened over.
   */
  projects: readonly string[]
  /**
   * What to PRINT as this step's owner: its tsconfigs when it compiles, the
   * scripts it ran when it does not. P2.416 — `projects` stays tsconfig-only
   * because `ownershipNote` explains a tsconfig-specific defect and would be
   * wrong under a script name.
   */
  labels: readonly string[]
}

/**
 * Split the chain body into steps. Every segment must be exactly
 * `bun run <script>`; anything else is refused rather than run, because a
 * segment carrying its own `cd` or `&&` cannot be executed independently and
 * quietly reintroduces the ordering dependency this script exists to remove.
 */
export function parseChain(chainName: string, body: string): string[] {
  const steps: string[] = []

  for (const rawSegment of body.split('&&')) {
    const segment = rawSegment.trim()
    if (segment === '') continue

    assertNoHomeOrRootPath(`step ${JSON.stringify(segment)} of ${chainName}`, segment)

    const stepName = /^bun run ([A-Za-z0-9:._-]+)$/.exec(segment)?.[1]
    if (stepName === undefined) {
      throw new GateSafetyRefusal(
        `REFUSED: ${chainName} contains a step this runner cannot execute independently:\n` +
        `  ${segment}\n` +
        '  Every step must be exactly `bun run <script>`. A step that carries its own `cd`\n' +
        '  only works in chain order, which is the coupling that made an early red hide\n' +
        '  every package after it (P2.222). Move the body into its own script.',
      )
    }

    steps.push(stepName)
  }

  if (steps.length === 0) {
    throw new GateSafetyRefusal(`REFUSED: ${chainName} expands to no steps at all.`)
  }

  return steps
}

function readRootScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
  }
  return manifest.scripts ?? {}
}

function readChain(scripts: Readonly<Record<string, string>>, chainName: string): string[] {
  const body = scripts[chainName]
  if (body === undefined) {
    throw new GateSafetyRefusal(
      `REFUSED: the root package.json has no "${chainName}" script to expand.`,
    )
  }
  return parseChain(chainName, body)
}

function runStep(scripts: Readonly<Record<string, string>>, name: string): StepResult {
  assertNoHomeOrRootPath('a gate step name', name)

  const started = Date.now()
  const run = Bun.spawnSync(['bun', 'run', name], {
    cwd: REPO_ROOT,
    stdio: ['inherit', 'inherit', 'inherit'],
  })

  return {
    name,
    verdict: classifyRun(run.exitCode, run.signalCode),
    seconds: ((Date.now() - started) / 1000).toFixed(1),
    projects: stepProjectPaths(scripts, name),
    labels: stepOwnerLabels(scripts, name),
  }
}

function report(chainName: string, results: readonly StepResult[]): number {
  const red = results.filter((r) => r.verdict.kind !== 'pass')
  const width = Math.max(...results.map((r) => r.name.length))

  console.log('')
  console.log(`──── ${chainName}: every step, including the ones after the first red ────`)
  for (const result of results) {
    // P2.390: the tsconfig belongs in the SUMMARY, not only in the step banner
    // scrolled off the top. A step's nickname and the package named in a
    // diagnostic's path are two different things, and this table is one of the
    // two places a lane actually reads.
    const owner = result.labels.length === 0 ? '' : `  ${result.labels.join(', ')}`
    console.log(
      `  ${result.name.padEnd(width)}  ${result.verdict.label.padEnd(22)} ` +
      `${result.seconds.padStart(6)}s${owner}`,
    )
  }
  console.log('')

  for (const result of red) {
    if (result.verdict.kind === 'killed') {
      console.log(killedExplanation(`  ${result.name}`, result.verdict))
      console.log('')
    }
  }

  const ownership = ownershipNote(red)
  if (ownership !== '') {
    console.log(ownership)
    console.log('')
  }

  if (red.length === 0) {
    console.log(`GATE ${chainName}: PASSED — ${results.length} of ${results.length} steps green.`)
    return 0
  }

  console.log(
    `GATE ${chainName}: FAILED — ${red.length} of ${results.length} steps red: ` +
    red
      .map((r) => {
        const owner = r.labels.length === 0 ? '' : ` [${r.labels.join(', ')}]`
        return `${r.name} ${r.verdict.label}${owner}`
      })
      .join(', '),
  )
  console.log(
    'This line is printed last on purpose: a piped run (`| tail`, `| head`) reports the\n' +
    "pipe's exit status, not the gate's, so the verdict has to survive in the OUTPUT.",
  )
  return 1
}

function main(argv: readonly string[]): number {
  const chainName = argv.find((arg) => !arg.startsWith('--'))
  if (chainName === undefined) {
    console.error('usage: bun scripts/run-gates.ts <chain-script> [--list]')
    return 2
  }

  const scripts = readRootScripts()
  const steps = readChain(scripts, chainName)

  if (argv.includes('--list')) {
    for (const step of steps) {
      const labels = stepOwnerLabels(scripts, step)
      console.log(labels.length === 0 ? step : `${step}  ${labels.join(', ')}`)
    }
    console.log(`\n${steps.length} steps in ${chainName}.`)
    return 0
  }

  const results: StepResult[] = []
  for (const [index, step] of steps.entries()) {
    const labels = stepOwnerLabels(scripts, step)
    const owner = labels.length === 0 ? '' : ` — ${labels.join(', ')}`
    console.log(`\n──── ${chainName} step ${index + 1}/${steps.length}: ${step}${owner} ────`)
    results.push(runStep(scripts, step))
  }

  return report(chainName, results)
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
