/**
 * codex-live-suites — the family of suites that drive the SHIPPED
 * `codex-app-server`, named, so that "run the codex live tests" is a command
 * rather than a memory. D1.123.
 *
 * ## The defect: a family with no name, and three different gates
 *
 * The row that opened this said *"the three codex live-boot suites"*. Measured
 * at HEAD on 2026-09-17 by the classifier below, the family is **fifteen**, and
 * they do not agree on how they decide to run:
 *
 *  - **seven** build `BIN` by hand, take `HAVE_BIN = existsSync(BIN)` and gate a
 *    `describe.if` / `it.skipIf` on it, then `spawn(BIN, …)` themselves;
 *  - **three** (`config-warning-live`, `models-endpoint-live`,
 *    `server-warning-live`) go through the real `CodexRuntimeManager.spawn`, so
 *    they exercise the pre-spawn SHA gate as well;
 *  - **five** `*-e2e.test.ts` gate on `process.env.NESSY_CODEX_E2E === '1'`
 *    instead, which means **an ordinary `bun test` never runs them at all** and
 *    nothing says so.
 *
 * Three more files NAME the staged path without booting it
 * (`runtime-resolver`, `manifest-verifier`, `plugin-node-runtime`) and are
 * deliberately not members: sweeping them in would make the count meaningless.
 * Do not quote any of these numbers — run `--list`, which is the list.
 *
 * That third gate is the one worth a script: an opt-in nobody is told about is
 * indistinguishable from a suite that does not exist.
 *
 * ## The list is DERIVED, which is the whole point
 *
 * A hand-written file list is the thing that goes stale — and the row's own
 * count was already stale by seven when it was read. So membership is computed
 * from the tree every run: a tracked `*.test.ts` under a `__tests__/` directory
 * in `packages/` whose source builds the staged binary's path. The classifier
 * then reports which gate each member uses, so a member that quietly changes
 * gate is visible rather than silently dropped.
 *
 * The rule's own instrument matters, and two AGENTS.md traps shape it. **A `**`
 * pathspec handed to `git grep` is read WITHOUT glob magic and silently answers
 * zero**, so the needle search is scoped to the plain prefix `packages` and the
 * `__tests__/*.test.ts` shape is filtered in TypeScript. And `-a` is passed
 * (never with `-I`, which cancels it) so a source file carrying a NUL byte
 * cannot be skipped in silence.
 *
 * Doing the scan with `git grep` rather than by reading every tracked test file
 * is not a micro-optimisation: the read-everything version took **49.9 s** on
 * the first call here and timed out its own test, while this one is milliseconds.
 * The cost it pays instead is that `git grep` reads TRACKED blobs — a brand-new
 * suite that has not been committed is invisible to it, which is the
 * untracked-reader trap in AGENTS.md. Commit the suite, then run `--list`.
 *
 * ## `skipIf` the bundled binary is absent, VISIBLY
 *
 * The binaries are gitignored, so a clean checkout has none, and every member
 * already skips itself. This script says so once, in one line, and exits 0 —
 * because a live-suite runner that fails on a machine with no binary would be a
 * gate nobody can keep green, and one that exits 0 in SILENCE is how "the codex
 * live tests pass" comes to mean nothing.
 *
 * Usage:
 *   bun scripts/codex-live-suites.ts --list     # the family, with each gate
 *   bun scripts/codex-live-suites.ts            # run it (sets NESSY_CODEX_E2E=1)
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The staged `codex-app-server` for THIS platform, mirroring how every member
 * of the family builds it. Kept in one expression here so the runner and the
 * suites cannot disagree about which artifact "present" means.
 */
export function stagedCodexAppServer(root = REPO_ROOT): string {
  return join(
    root, 'apps', 'electron', 'resources', 'bin', 'codex',
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
  )
}

/** How a member decides whether to run. `none` is a member that cannot say. */
export type CodexLiveGate = 'have-bin' | 'runtime-manager' | 'env-opt-in' | 'none'

export interface CodexLiveSuite {
  /** Repo-relative path, `./`-prefixed so it is a PATH to `bun test` and not a FILTER. */
  readonly path: string
  readonly gate: CodexLiveGate
}

/** The needle every member builds the staged path with. Spelled once. */
const STAGED_PATH_NEEDLE = "'bin', 'codex'"

/**
 * Does this source boot the shipped binary, and how does it gate itself?
 *
 * `undefined` for a file that merely NAMES the staged path — `runtime-resolver`
 * and `manifest-verifier` resolve it without ever spawning it, and sweeping them
 * in would make the family's own count meaningless.
 */
export function classifyCodexLiveSuite(source: string): CodexLiveGate | undefined {
  const namesStagedBinary = source.includes(STAGED_PATH_NEEDLE)
  if (!namesStagedBinary) return undefined
  const spawnsDirectly = /spawn\(\s*(BIN|CODEX_BIN|bin)\b/.test(source)
  const spawnsThroughManager = /manager\.spawn\(/.test(source)
  if (!spawnsDirectly && !spawnsThroughManager) return undefined
  if (/NESSY_CODEX_E2E/.test(source)) return 'env-opt-in'
  if (spawnsDirectly && /\bHAVE_BIN\b/.test(source)) return 'have-bin'
  if (spawnsThroughManager) return 'runtime-manager'
  return 'none'
}

/** The family, derived from the tree. Sorted, so two runs are comparable. */
export function discoverCodexLiveSuites(root = REPO_ROOT): readonly CodexLiveSuite[] {
  // `-a` and never `-I`; `packages` is a plain prefix and not a `**` pattern.
  const listed = spawnSync(
    'git',
    ['grep', '-alF', STAGED_PATH_NEEDLE, '--', 'packages'],
    { cwd: root, encoding: 'utf8' },
  )
  // git grep exits 1 for "no match", which is a legitimate empty answer rather
  // than a failure; anything above that is the tool refusing.
  if (listed.status !== 0 && listed.status !== 1) {
    throw new Error(`git grep failed: ${listed.stderr?.trim() || `exit ${listed.status}`}`)
  }
  const found: CodexLiveSuite[] = []
  for (const relative of listed.stdout.split('\n')) {
    if (!relative.endsWith('.test.ts') || !relative.includes('/__tests__/')) continue
    const gate = classifyCodexLiveSuite(readFileSync(join(root, relative), 'utf8'))
    if (gate === undefined) continue
    found.push({ path: `./${relative}`, gate })
  }
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

function main(): void {
  const listOnly = process.argv.includes('--list')
  const suites = discoverCodexLiveSuites()
  const binary = stagedCodexAppServer()
  const haveBinary = existsSync(binary)

  console.log(`codex live suites: ${suites.length} (derived from the tree, not a written list)`)
  for (const suite of suites) console.log(`  ${suite.gate.padEnd(16)} ${suite.path}`)
  if (listOnly) return

  if (suites.length === 0) {
    console.error('no codex live suite was discovered — the classifier or the tree moved')
    process.exit(1)
  }
  if (!haveBinary) {
    // Said out loud rather than exited quietly: the binaries are gitignored, so
    // this is the ordinary state of a clean checkout, and `bun scripts/fetch-codex.mjs`
    // is what makes them runnable.
    console.log(
      `SKIPPED — no staged codex-app-server at ${binary}. `
      + 'Every suite above would skip itself; run `node scripts/fetch-codex.mjs` to stage one.',
    )
    return
  }

  // `NESSY_CODEX_E2E=1` is set here because the env-gated members exist to be
  // run by THIS command and by nothing else; an ordinary `bun test` leaves them
  // switched off, which is the finding this script is named for.
  const run = spawnSync('bun', ['test', ...suites.map(suite => suite.path)], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, NESSY_CODEX_E2E: '1' },
  })
  process.exit(run.status ?? 1)
}

if (import.meta.main) main()
