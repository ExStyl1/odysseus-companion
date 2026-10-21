/**
 * check-conditional-expect — find `expect(…)` nested inside an `if (…)` whose
 * discriminator is never asserted unconditionally.
 *
 * P2.405. The shape this looks for is the one where a test reads green while
 * asserting nothing:
 *
 *   it('rejects the bad shape', () => {
 *     const verdict = classify(input)
 *     if (verdict.kind === 'denied') {
 *       expect(verdict.reason).toContain('policy')   // never runs if kind flipped
 *     }
 *   })
 *
 * If `verdict.kind` is never asserted OUTSIDE the `if`, a regression that makes
 * `classify` return `{ kind: 'allowed' }` deletes the assertion instead of
 * failing it. The suite stays green and the coverage number does not move.
 *
 * ## Why this file exists at all
 *
 * The scanner was written twice — once for P2.386 and once for the residue this
 * row is — and both times it lived in a session scratch directory that is
 * deleted with the session. Committing it is the row. **The measurement it
 * produces is expensive and has now been paid for twice; the next lane should
 * re-run it, not re-derive it.**
 *
 * ## The selector, stated
 *
 * 1. Files: the `*.ts` / `*.tsx` git lists — tracked, plus untracked that no
 *    ignore rule covers — whose name matches `*.test.*` / `*.spec.*` or whose
 *    path contains `__tests__/`. A path through a `SKIP` segment is dropped.
 *    See {@link listTestFiles} (F1.608) for what is read from disk and why.
 * 2. Blocks: a line starting (after indentation, optionally after `} else`) with
 *    `if (`, whose condition closes within 12 lines, whose `{` follows the `)`
 *    with nothing but whitespace between them, and whose brace-matched body
 *    contains `expect(`. That set is the CANDIDATE population — `--all` prints it.
 * 3. Discriminator: the LHS of a `===`/`!==`/`==`/`!=` comparison, or the whole
 *    condition for a truthy/`in` test, with leading `!` and wrapping parens
 *    stripped, capped at 80 characters.
 * 4. A candidate is REPORTED only if that discriminator does not appear inside an
 *    `expect(…)` anywhere in the enclosing `it()`/`test()` body **after every
 *    nested `if`-block body has been stripped out** — i.e. only if nothing
 *    asserts it unconditionally.
 *
 * ## Three shapes that are legitimate and must not be treated as defects
 *
 * Measured over ~15 hand-read candidates in P2.386; nearly all were sound, and
 * these are the reasons why. A sweep that flags them is a sweep people stop
 * running.
 *
 *  a. **Guarded from ABOVE by the discriminator assertion.** The unconditional
 *     assertion exists but sits in a `beforeEach`, a helper the test calls, or an
 *     earlier `it()` in the same `describe`. Step 4 only reads the enclosing
 *     `it()`/`test()` body, so it cannot see any of those.
 *  b. **A documented two-outcome acceptance.** The test deliberately accepts
 *     either branch — a race, a platform-dependent ordering, a "one of these two
 *     errors" contract — and says so at the line. The `if` is the contract, not a
 *     hole in it.
 *  c. **An environment gate.** `process.platform`, `existsSync(...)`, or a
 *     tool-present probe deciding whether the case is runnable here at all —
 *     e.g. `apps/cli/src/plugin.test.ts:49` (`if (existsSync(join(dir,
 *     'staging')))`) and the `if (process.platform === 'win32') return` guards in
 *     `packages/server-core/src/bootstrap/plugin-runtime-dependencies.test.ts`.
 *     Asserting the discriminator here would assert the CI runner, not the code.
 *
 * ## Precision to budget against
 *
 * From P2.386, reading candidates in full: **one real defect per six candidates
 * read.** Budget accordingly before starting a sweep — the list is a queue of
 * things to read, not a list of bugs.
 *
 * ## Known limits of the instrument
 *
 * Brace and paren matching is done by scanning characters, so a `{`, `}` or `)`
 * inside a string literal, a regex literal or a comment miscounts. The condition
 * scan gives up after 12 lines and the body scan after 3000. The nested-`if`
 * stripper in step 4 looks for the block's `{` within 15 lines of the `if`. Each
 * of those makes the tool MISS candidates rather than invent them, which is the
 * safe direction for a queue but means the population figure is a floor.
 *
 * ## Measured population
 *
 * | Date | test files | candidate blocks | no unconditional discriminator |
 * | --- | --- | --- | --- |
 * | 2026-08-29 (P2.386) | 1458 | 172 | 72 |
 * | 2026-08-29 (P2.405, this commit) | 1463 | 160 | 68 |
 *
 * **Both readings are hours apart on the same day and they disagree by 12 and 4.**
 * Nothing was fixed in between; four sibling lanes were editing test files the
 * whole time. Within one session the last figure moved 71 → 68 while this file
 * was being written, and the scratch original re-run at that moment reported the
 * same 68 with a byte-identical hit list — so the drift is the tree, not the
 * tool. Treat every number here as a reading with a date, never a standing fact:
 * **re-run it.** Of the P2.386 population ~15 were hand-read; the rest were not,
 * and nothing is claimed about them.
 *
 * ## `--check`: the gate, and why it gates on NEW hits only
 *
 * P2.416. This script was committed with tests and invoked by nothing, and an
 * uninvoked guard is a guard that has already stopped working. But the obvious
 * wiring — fail when the count is non-zero — would have failed on day one at 68,
 * and a gate that is red on arrival gets commented out within the week. The
 * population is mostly LEGITIMATE (the three shapes above), so the total is a
 * FLOOR to read, not a defect count.
 *
 * So `--check` compares the current hit set against `conditional-expect-baseline.txt`
 * and fails only on a hit that is not in it. Adding a new undiscriminated
 * `expect` inside an `if` turns it red; the 68 that were already there do not.
 *
 * The baseline is keyed by `file :: test title :: discriminator`, NOT by line
 * number, because line numbers in this repo's test files move under every
 * sibling lane — the two readings in the table above drifted 12 and 4 in hours
 * with nothing fixed. A key that moves with the file is a gate that cries wolf.
 *
 * Removing a hit is not a failure; it just leaves a stale baseline line, which
 * `--check` reports as a note. Re-record with `--update-baseline` and say in the
 * commit which hits you FIXED as opposed to accepted.
 *
 * ## The SECOND selector: a matcher that hollows the object under test (P2.433)
 *
 * P2.413 measured this on **bun 1.3.14** and it is not documented anywhere:
 *
 *   expect(received).toMatchObject({ k: expect.any(Object) })
 *
 * **overwrites `received.k` with the matcher instance.** Afterwards
 * `Object.keys(received.k)` is `[]`. Both the probe with a literal expected
 * value and the probe with a matcher PASS, so nothing warns you — and every
 * later assertion that reads `received.k` is reading an empty object. P2.404
 * was exactly this: its assertions never ran and the suite was green.
 *
 * The two genuine defects this found were both security guards proving nothing
 * (`runtime-pool-servers.test.ts`): `env: expect.objectContaining(...)` emptied
 * the very environment a leak guard then searched, and a mutant that forwarded a
 * real `CODEX_HOME` SURVIVED. Fixed in `64ea6f9c5` by moving each absence check
 * ABOVE its shape check — which is why this selector reports zero hits on the
 * tree it was written against, and why the sites in that file are the positive
 * control that the "read again afterwards" half of the predicate works.
 *
 * ### The predicate, stated
 *
 * 1. Balance parentheses from each `.toMatchObject(`. **`toEqual` is never
 *    flagged: it does not mutate.** That one fact retired one of the eight sites
 *    the original row listed.
 * 2. The argument must contain one of `expect.any`, `anything`,
 *    `objectContaining`, `arrayContaining`, `stringContaining`,
 *    `stringMatching`, `closeTo`. That set is the SITE population.
 * 3. Only the exact matched LEAF PATH is overwritten — siblings, unmatched keys
 *    and object identity elsewhere all survive. So the key paths carrying a
 *    matcher are extracted, and a matcher at the top level marks the whole
 *    received object.
 * 4. A site is a DEFECT only if the received expression is a bound identifier
 *    that is read again later in the same `it()` — at a matched path, or
 *    wholesale (passed on, destructured, indexed) where the matched leaf is
 *    inside what was passed.
 *
 * ### Three shapes that must NOT be flagged, each real in this tree
 *
 *  a. **An unbound temporary** — `expect(await call()).toMatchObject(...)`.
 *     Nothing else holds the object, so nothing can read the hollowed leaf.
 *  b. **The last assertion in the block.** No later read, no defect.
 *  c. **A later read of an UNMATCHED SIBLING key.**
 *     `custom-slash-command-boundary.test.ts:100` matches `path` and then reads
 *     `resolved?.body`; `body` was never overwritten. This is the shape that
 *     separates this class from a silent one: had `body` been hollowed, the
 *     test would have THROWN rather than passed quietly.
 *
 * ### Two implementation traps, both already paid for
 *
 *  - **Do not strip comments.** The lane's first pass did, naively, and
 *    `https://` inside a string literal read as the start of a line comment —
 *    silently dropping two real sites. Nothing is stripped here. A commented-out
 *    call therefore counts as a site, which costs one line of output; the
 *    alternative costs findings, and it costs them invisibly.
 *  - **Optional chaining and non-null assertions are property reads.** A first
 *    cut that matched only `received.` flagged shape (c) above as a defect,
 *    because the later read was spelled `resolved?.body`. `!` and `?` are
 *    skipped before the dot.
 *
 * ### Measured population
 *
 * | Date | sites | files | defects |
 * | --- | --- | --- | --- |
 * | 2026-08-30, before this commit's own fixtures | 28 | 19 | 0 |
 * | 2026-08-30, ~1h later, same tree | 27 | 19 | 0 |
 * | 2026-08-30, with this commit's 8 fixture sites | 35 | 20 | 0 |
 *
 * P2.413 recorded 28 sites in 16 files with 2 harmful; the 2 were fixed in
 * `64ea6f9c5`, and the tree moved 28 → 27 in the hour it took to write the
 * tests, with nothing fixed. Same rule as everything else in this header: **it
 * is a reading with a date, re-run it.** The third row is why the gate keys on
 * DEFECTS and not on sites — eight of the current sites are this file's own
 * test fixtures.
 *
 * ### One limit worth knowing, because it is also what makes the fixtures inert
 *
 * A site outside any `it()`/`test()` block is counted but can never be a defect:
 * "read again later in the SAME `it()`" has no answer there, and the predicate
 * declines rather than guessing. That is why the eight fixture bodies in
 * `check-conditional-expect.test.ts` are hoisted to module scope — written
 * inline they sit inside real `test()` blocks, and the gate went red on arrival
 * against the tests that prove it works. The cost of the same rule: a genuinely
 * hollowed object inside a shared helper called by tests is MISSED. Like every
 * other limit in this file, it makes the tool under-report rather than invent.
 *
 * `--check-matchers` gates on DEFECTS not in `matcher-mutation-baseline.txt`,
 * for the same reason its sibling gates on new hits: a gate that is red on
 * arrival is a gate that gets commented out. Here the honest starting baseline
 * is EMPTY, because the tree really does carry zero of them today.
 *
 * Usage:
 *   bun scripts/check-conditional-expect.ts                   # REPORT, always exit 0 — not the gate
 *   bun scripts/check-conditional-expect.ts --all             # every candidate block
 *   bun scripts/check-conditional-expect.ts --count           # the three counts only
 *   bun scripts/check-conditional-expect.ts --check           # exit 1 on a hit not in the baseline
 *   bun scripts/check-conditional-expect.ts --update-baseline # re-record the baseline
 *   bun scripts/check-conditional-expect.ts --matchers        # selector 2: every matcher site
 *   bun scripts/check-conditional-expect.ts --check-matchers  # exit 1 on a defect not in the baseline
 *   bun scripts/check-conditional-expect.ts --update-matcher-baseline
 *
 * Without `--check` the exit code is always 0: this is an instrument, and
 * failing a plain run on a population we documented as mostly correct would be
 * failing on the shapes the header just called legitimate.
 *
 * ## That sentence is not enough, and P3.305 is what it cost
 *
 * A lane ran the plain form, read exit 0, ran `bun run lint:conditional-expect`,
 * read exit 1, and reported the two as a GATE DISAGREEING WITH ITSELF — the
 * P2.255 shape. They are not the same command: one is a report that always
 * exits 0 by the paragraph above, the other is the gate. But an instrument whose
 * exit code is indistinguishable from a passing gate will be read as one, and
 * documenting that in a header the reader has not opened does not prevent it.
 * So the plain run now SAYS it is not the gate and names the gate, on its own
 * last line. `--check` is the honest invocation; nothing else here is a verdict.
 *
 * ## And the population includes files git has never seen — P3.305's real cause
 *
 * The scan reads UNTRACKED files too — it walked the filesystem until F1.608 and
 * lists `git ls-files --others --exclude-standard` beside the index since —
 * which is correct (a gate that only sees committed files cannot stop anything
 * before it is committed) and is also how that lane's red arose: both flagged
 * files were UNTRACKED, written minutes earlier by two other lanes in the same
 * wave, and the gate is green on a clean worktree at the same commit. A hit in a
 * file that is not committed belongs to whoever is writing it. `--check`
 * therefore labels each NEW hit `[untracked]` when git says so — one more
 * `git ls-files` call, only on the failing path. (Since F1.608 every form needs
 * git: the listing itself is git's, and outside a work tree the scan refuses
 * rather than reporting an empty tree as a clean one.)
 */

import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parsePorcelainZ } from './git-status-z'
import { readFilesConcurrently } from './read-changed-files'

/**
 * The repo root, derived from this file's own location rather than
 * `process.cwd()`. The scratch original used cwd, which silently scanned
 * whatever directory it happened to be launched from — a scan of nothing prints
 * `0 candidates`, which reads exactly like a clean tree.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SKIP = new Set([
  'node_modules', '.git', 'dist', 'release', 'build', '.codegraph', 'out', 'coverage', '.references',
])

/**
 * Whether repo-relative `path` is a file this scan reads: selector rule 1's name
 * test (`*.test.*` / `*.spec.*`, or under `__tests__/`) on a `.ts`/`.tsx` path
 * with no `SKIP` segment. The segment test is the belt the walk's directory skip
 * was: a `node_modules` a clone's own ignore rules do not name is still not ours.
 */
export function isScannedTestPath(path: string): boolean {
  if (!/\.tsx?$/.test(path)) return false
  if (path.split('/').some((segment) => SKIP.has(segment))) return false
  return /\.(test|spec)\.tsx?$/.test(path.slice(path.lastIndexOf('/') + 1)) || path.includes('__tests__/')
}

/** `git <args>` in `root`, stdout as bytes; a non-zero exit is a hard error naming git's own words. */
function runGit(root: string, args: readonly string[], input?: Uint8Array): Buffer {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: root,
    stdin: input ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(
      `check-conditional-expect: \`git ${args.join(' ')}\` failed in ${root} (exit ${String(proc.exitCode)}): ` +
      `${proc.stderr.toString().trim()}`,
    )
  }
  return proc.stdout
}

/** A regular file on disk right now — the walk's `isFile()`: a symlink, a directory or nothing is not one. */
function isRegularFileOnDisk(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/** What {@link listTestFiles} hands the reader. */
export interface TestFileListing {
  /** Repo-relative test files to scan, POSIX separators. */
  files: string[]
  /**
   * The index blob of each file whose working-tree bytes ARE that blob — tracked,
   * clean, stage 0. A file absent here is read from DISK: untracked, or tracked
   * with a working-tree change.
   */
  blobs: Map<string, string>
}

/**
 * F1.608 — the files this scan reads, from git rather than from a walk.
 *
 * ## Why not the walk
 *
 * This gate walked the disk and opened every test file it found, and on this rig
 * opening a file costs the same whatever opens it: `--check` measured
 * `real 338.14 user 1.38 sys 1.04` over ~2 612 files on 2026-09-24 — 0.7 % CPU,
 * the rest waiting on the filesystem. It is the shape AGENTS.md records for a
 * `lint:chain` gate that OPENS its corpus (D1.318/D1.320), and `check-nul-bytes`
 * went 173.80 s → 1.33 s by reading clean files as blobs; this is that shape.
 *
 * ## What is listed
 *
 * `git ls-files --cached` (the index, with modes and blobs) plus
 * `git ls-files --others --exclude-standard` (every untracked file no ignore rule
 * covers). The discriminator is IGNORED, not UNTRACKED, and both halves of that
 * were paid for:
 *
 *  - **Untracked stays in.** A gate that only saw committed files could stop
 *    nothing before it was committed, and P3.305's real red was two UNTRACKED
 *    files written minutes earlier by sibling lanes.
 *  - **Ignored stays out.** `.gitlab-ci.yml`'s `.bun-cache` anchor keeps the
 *    runner's caches INSIDE the checkout, because GitLab can only cache paths
 *    under the project directory, and the walk counted a cached third-party
 *    package's tests as ours: 2662 test files on the runner against 2318
 *    locally, and 29 NEW hits all under a cached `beautiful-mermaid@1.1.3`
 *    (job 630554861). The walk filtered them through `git check-ignore`; the
 *    listing never names them.
 *
 * ## Which are read from disk
 *
 * The porcelain exceptions only. `git status --porcelain -z` over the `.ts`/`.tsx`
 * files names every tracked file whose working tree differs from its index entry
 * — and a STAGED-only change too, whose disk bytes are its blob, which costs an
 * open and is never wrong (parsed by `git-status-z.ts`, the parser the other
 * blob-reading gates share) — and an untracked file has no blob. Those are
 * opened; the rest are read as blobs, because a clean file's working-tree bytes
 * ARE its index blob — that is what clean means. `--no-optional-locks` keeps the status call from refreshing
 * the index, so it can never hold `index.lock` while a sibling lane commits.
 *
 * ## Kept from the walk, on purpose
 *
 *  - A pending deletion — tracked, gone from disk — is not listed: the walk never
 *    met it, and it carries no `expect` to judge. (One that disappears AFTER the
 *    listing is F1.210's vanished file, named by the caller.)
 *  - A symlink is not listed, tracked (mode `120000`) or not: the walk's
 *    `isFile()` refused it, so following one would count its target twice.
 *
 * ## Residue, stated
 *
 * A file marked `assume-unchanged` or `skip-worktree` is never reported dirty by
 * `git status`, so it is read as its blob even when its disk copy differs — the
 * residue `git-status-z.ts` states for every caller, and the one this file's test
 * uses to prove the blob is what is read.
 *
 * The exceptions are opened all at once (F1.622, `read-changed-files.ts`, shared
 * with the other three blob-reading gates): one after another they were the
 * whole remaining cost on this rig — 25 of them took 12.22 s at load ~12 on
 * 2026-09-24 while the batch for the other 2 592 took under a second, and
 * parallel opens overlap there (the same 25 in 0.19 s, 25 fresh ones 1.11 s
 * against 4.70 s one by one).
 *
 * It needs a git work tree whose TOP is `root`, and throws otherwise: listing
 * nothing would print `0 candidates`, which reads exactly like a clean tree.
 */
export function listTestFiles(root: string = REPO_ROOT): TestFileListing {
  // Outside a work tree this exits 128; inside a SUBDIRECTORY it prints the
  // prefix, and `ls-files` would then answer relative to it while the porcelain
  // answers relative to the top — two path spaces, silently mismatched.
  const prefix = runGit(root, ['rev-parse', '--show-prefix']).toString().trim()
  if (prefix !== '') {
    throw new Error(`check-conditional-expect: ${root} is not the top of its git work tree (prefix ${prefix}).`)
  }
  const dirty = parsePorcelainZ(
    runGit(root, ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=no', '--', '*.ts', '*.tsx'])
      .toString(),
  )

  const files: string[] = []
  const blobs = new Map<string, string>()
  const seen = new Set<string>()

  // `<mode> <blob> <stage>\t<path>`; a conflicted path appears once per stage.
  for (const record of runGit(root, ['ls-files', '-s', '-z', '--cached']).toString().split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const path = record.slice(tab + 1)
    if (seen.has(path) || !isScannedTestPath(path)) continue
    seen.add(path)
    const [mode, blob, stage] = record.slice(0, tab).split(' ')
    if (stage === '0' && !dirty.has(path)) {
      // Clean: the index mode IS the disk's type.
      if (mode !== '100644' && mode !== '100755') continue
      files.push(path)
      blobs.set(path, blob!)
      continue
    }
    // Changed, conflicted or deleted in the working tree: the disk decides.
    if (isRegularFileOnDisk(join(root, path))) files.push(path)
  }

  for (const path of runGit(root, ['ls-files', '-z', '--others', '--exclude-standard']).toString().split('\0')) {
    if (path === '' || seen.has(path) || !isScannedTestPath(path)) continue
    seen.add(path)
    if (isRegularFileOnDisk(join(root, path))) files.push(path)
  }

  return { files, blobs }
}

/** What the scanners read: every listed file's text, in listing order, and the ones that vanished first. */
export interface LoadedTestSources {
  /** Repo-relative path → text. */
  texts: Map<string, string>
  /** Listed, then gone before the read — F1.210. */
  vanished: string[]
}

/**
 * Read a listing: the clean files through ONE `git cat-file --batch`, the rest
 * from disk, all at once, through {@link readTestSources}.
 *
 * The batch protocol: a header line `<blob> <type> <size>`, then exactly that
 * many BYTES, then a newline — sliced by the declared size, never split on a
 * separator, since a test file carries plenty of them. A blob git cannot produce
 * (a `missing` header) falls back to the disk, the old reader, rather than
 * shrinking the scan.
 */
export async function loadTestSources(
  root: string = REPO_ROOT,
  listing: TestFileListing = listTestFiles(root),
): Promise<LoadedTestSources> {
  const fromBlobs = new Map<string, string>()
  const batched = listing.files.filter((file) => listing.blobs.has(file))
  if (batched.length > 0) {
    const input = new TextEncoder().encode(`${batched.map((file) => listing.blobs.get(file)).join('\n')}\n`)
    const stdout = runGit(root, ['cat-file', '--batch'], input)
    let at = 0
    for (const file of batched) {
      const newline = stdout.indexOf(0x0a, at)
      if (newline < 0) break
      const header = stdout.toString('utf8', at, newline).split(' ')
      const size = Number(header[2])
      if (!Number.isInteger(size)) {
        // `<blob> missing` — no body follows it.
        at = newline + 1
        continue
      }
      if (header[1] === 'blob') fromBlobs.set(file, stdout.toString('utf8', newline + 1, newline + 1 + size))
      at = newline + 1 + size + 1
    }
  }

  const opened = listing.files.filter((file) => !fromBlobs.has(file))
  const fromDisk = await readTestSources(opened.map((file) => join(root, file)))
  const diskText = new Map(opened.map((file, index) => [file, fromDisk[index]]))
  const texts = new Map<string, string>()
  const vanished: string[] = []
  for (const file of listing.files) {
    const text = fromBlobs.get(file) ?? diskText.get(file)
    if (text === undefined) vanished.push(file)
    else texts.set(file, text)
  }
  return { texts, vanished }
}

/** An explicit enumeration — absolute paths, read from disk — as the scanners read a listing. */
async function loadListedFiles(root: string, files: readonly string[]): Promise<LoadedTestSources> {
  const fromDisk = await readTestSources(files)
  const texts = new Map<string, string>()
  const vanished: string[] = []
  files.forEach((file, index) => {
    const text = fromDisk[index]
    if (text === undefined) vanished.push(relative(root, file))
    else texts.set(relative(root, file), text)
  })
  return { texts, vanished }
}

/**
 * F1.210 — each test file's text, or `undefined` when it VANISHED between the
 * listing and the read; aligned with `files`, read all at once (F1.622).
 *
 * Measured 2026-09-23 twice in one wave (WJ-o on WJ-l's probe; WJ-n on
 * `zz-wjl-probe.test.ts`): a sibling lane deleted an UNTRACKED test file it had
 * been using as a probe after the enumeration listed it and before the
 * read, and the gate died with an uncaught `ENOENT` — exit 1 in `lint:chain`
 * for a file nobody meant to commit, green on the re-run. A file that no longer
 * exists carries no `expect` for this gate to judge, so it is SKIPPED and NAMED
 * (the caller prints every vanished path) rather than crashing the scan. Only
 * `ENOENT` is forgiven: any other read failure is a real error and still throws
 * — the first one in `files` order, as the one-by-one reader threw it.
 */
export async function readTestSources(files: readonly string[]): Promise<(string | undefined)[]> {
  return (await readFilesConcurrently(files)).map((read) => {
    if (read.ok) return read.bytes.toString('utf8')
    if (read.error.code === 'ENOENT') return undefined
    throw read.error
  })
}

/** The one line every form of this script prints when the listing outran a neighbour's delete. */
export function vanishedNotice(vanished: readonly string[]): string | undefined {
  if (vanished.length === 0) return undefined
  return `  NOTE: ${vanished.length} test file(s) VANISHED between the listing and the read — deleted mid-scan, `
    + `most likely by a neighbour's probe — and were skipped, not scanned: ${vanished.join(', ')}`
}

/** Brace-match from `startLine`/`startCol`, returning the body text and end line. */
function matchBlock(lines: string[], startLine: number, startCol: number): { end: number; text: string } | null {
  let depth = 0
  let text = ''
  let closed = false
  let end = startLine
  for (let l = startLine; l < lines.length && l - startLine < 3000; l++) {
    const s = lines[l]!
    for (let c = (l === startLine ? startCol : 0); c < s.length; c++) {
      const ch = s[c]!
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          closed = true
          end = l
          break
        }
      }
      if (depth > 0) text += ch
    }
    if (closed) break
    text += '\n'
  }
  return closed ? { end, text } : null
}

/** One `it()`/`test()` block: its title, its line span, and its brace-matched body. */
export interface TestBlock {
  title: string
  start: number
  end: number
  body: string
}

/**
 * Index every `it()`/`test()` block in `lines`.
 *
 * Shared by both selectors (P2.433). Both need the same thing — "which test is
 * this line inside" — and the second one additionally needs the block's END,
 * because its whole predicate is *is the received object read AFTER this
 * assertion and BEFORE the block closes*.
 */
export function indexTestBlocks(lines: readonly string[]): TestBlock[] {
  const tests: TestBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:it|test)(?:\.\w+)*(?:\.each\([\s\S]*?\))?\s*\(\s*(['"`])(.*?)\1/.exec(lines[i]!)
    if (!m) continue
    const brace = lines[i]!.indexOf('{', m[0].length)
    let sl = i
    let sc = brace
    if (brace === -1) {
      // Arrow body opening on a later line.
      let found = false
      for (let l = i; l < Math.min(lines.length, i + 6); l++) {
        const b = lines[l]!.indexOf('{', l === i ? m[0].length : 0)
        if (b !== -1) {
          sl = l
          sc = b
          found = true
          break
        }
      }
      if (!found) continue
    }
    const blk = matchBlock(lines as string[], sl, sc)
    if (blk) tests.push({ title: m[2]!, start: i, end: blk.end, body: blk.text })
  }
  return tests
}

export interface Candidate {
  file: string
  line: number
  cond: string
  disc: string
  test: string
  /** True when the discriminator IS asserted unconditionally in the same test. */
  discriminated: boolean
}

/**
 * `root` is a parameter so the scanner is testable against a fixture tree
 * instead of only against this repo — see `check-conditional-expect.test.ts`,
 * which pins both directions (a planted undiscriminated block is reported; the
 * same block with an unconditional discriminator assertion is not).
 *
 * `files` (absolute paths, read from disk) replaces the git listing — F1.210's
 * seam for reproducing a vanished file exactly. Without it the scan reads
 * {@link loadTestSources}, which is what every CLI form does.
 */
export async function scan(
  root: string = REPO_ROOT,
  files?: readonly string[],
): Promise<{ files: number; candidates: Candidate[]; vanished: string[] }> {
  const candidates: Candidate[] = []
  const { texts, vanished } = files === undefined ? await loadTestSources(root) : await loadListedFiles(root, files)

  for (const [file, text] of texts) {
    if (!text.includes('expect(')) continue
    const lines = text.split('\n')

    // Index every it()/test() block so a candidate can be attributed to one.
    const tests = indexTestBlocks(lines)

    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:\}\s*else\s+)?if\s*\(/.exec(lines[i]!)
      if (!m) continue
      const idx = lines[i]!.indexOf('(', m[0].length - 1)
      let depth = 0
      let cond = ''
      let pl = i
      let pc = idx
      let ok = false
      outer: for (let l = i; l < Math.min(lines.length, i + 12); l++) {
        const s = lines[l]!
        for (let c = (l === i ? idx : 0); c < s.length; c++) {
          const ch = s[c]!
          if (ch === '(') {
            depth++
            if (depth === 1) continue
          }
          if (ch === ')') {
            depth--
            if (depth === 0) {
              pl = l
              pc = c
              ok = true
              break outer
            }
          }
          cond += ch
        }
        cond += ' '
      }
      if (!ok) continue
      const bcol = lines[pl]!.indexOf('{', pc)
      if (bcol === -1 || lines[pl]!.slice(pc + 1, bcol).trim() !== '') continue
      const blk = matchBlock(lines, pl, bcol)
      if (!blk) continue
      if (!/\bexpect\s*\(/.test(blk.text)) continue

      const c = cond.replace(/\s+/g, ' ').trim()
      // Discriminator: LHS of a comparison, the `in`-subject, or the whole truthy expr.
      let disc = c
      const cmp = /^(.+?)\s*(?:===|!==|==|!=)\s*/.exec(c)
      if (cmp) disc = cmp[1]!.trim()
      const inop = /^'([A-Za-z0-9_$]+)'\s+in\s+(.+)$/.exec(c)
      if (inop) disc = c
      disc = disc.replace(/^!+/, '').replace(/^\(/, '').replace(/\)$/, '').trim()
      if (!disc || disc.length > 80) continue

      const t = tests.find((candidate) => candidate.start <= i && i <= candidate.end)
      if (!t) continue

      // Is the discriminator asserted UNCONDITIONALLY anywhere in this test?
      // Strip every nested if-block body from the test body first.
      const tl = lines.slice(t.start, t.end + 1)
      const keep: string[] = []
      let skipUntil = -1
      for (let l = 0; l < tl.length; l++) {
        if (l <= skipUntil) continue
        const mm = /^(\s*)(?:\}\s*else\s+)?if\s*\(/.exec(tl[l]!)
        if (mm) {
          const abs = t.start + l
          let bc = -1
          let bl = -1
          for (let x = abs; x < Math.min(lines.length, abs + 15); x++) {
            const b = lines[x]!.indexOf('{')
            if (b !== -1) {
              bl = x
              bc = b
              break
            }
          }
          if (bl !== -1) {
            const bb = matchBlock(lines, bl, bc)
            if (bb) {
              skipUntil = bb.end - t.start
              continue
            }
          }
        }
        keep.push(tl[l]!)
      }
      const stripped = keep.join('\n')

      const needle = disc.replace(/\s+/g, '')
      const strippedNo = stripped.replace(/\s+/g, '')
      const discriminated = strippedNo.includes('expect(' + needle + ')') ||
        new RegExp('expect\\([^)]{0,40}' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(strippedNo)

      candidates.push({
        file,
        line: i + 1,
        cond: c.slice(0, 100),
        disc,
        test: t.title.slice(0, 70),
        discriminated,
      })
    }
  }

  candidates.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { files: texts.size, candidates, vanished }
}

/** Where the accepted population is recorded. Repo-relative for printing. */
export const BASELINE_FILE = 'scripts/conditional-expect-baseline.txt'

/**
 * A hit's identity for baseline purposes: file, enclosing test title and
 * discriminator — deliberately NOT the line number, which drifts under every
 * sibling lane's edits and would make this gate fire on unrelated commits.
 */
export function baselineKey(hit: { file: string; test: string; disc: string }): string {
  return `${hit.file} :: ${hit.test} :: ${hit.disc}`
}

export function readBaseline(root: string, file: string = BASELINE_FILE): Set<string> {
  const path = join(root, file)
  if (!existsSync(path)) return new Set()
  return new Set(
    readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  )
}

/** New hits (not in the baseline) and baseline lines no hit matches any more. */
export function diffBaseline(
  keys: readonly string[],
  baseline: ReadonlySet<string>,
): { added: string[]; stale: string[] } {
  const present = new Set(keys)
  return {
    added: [...new Set(keys)].filter((k) => !baseline.has(k)).sort(),
    stale: [...baseline].filter((k) => !present.has(k)).sort(),
  }
}

// ---------------------------------------------------------------------------
// Selector 2 (P2.433) — an asymmetric matcher hollows the object under test.
// See this file's header for the measurement, the predicate and the three
// shapes that must not be flagged.
// ---------------------------------------------------------------------------

/**
 * The matchers that MUTATE the received object on bun 1.3.14.
 *
 * `toEqual` is absent on purpose and must stay absent: it compares without
 * writing. Treating the two as equivalent is what put one of P2.413's eight
 * original sites on the list wrongly.
 */
export const ASYMMETRIC_MATCHERS = [
  'expect.any',
  'anything',
  'objectContaining',
  'arrayContaining',
  'stringContaining',
  'stringMatching',
  'closeTo',
] as const

const ASYMMETRIC_RE =
  /\bexpect\s*\.\s*any\b|\banything\b|\bobjectContaining\b|\barrayContaining\b|\bstringContaining\b|\bstringMatching\b|\bcloseTo\b/

/**
 * Index of the `)` that closes the `(` at `open`, or `-1`.
 *
 * String-aware, because a `)` inside `'https://example.com/a)b'` is not a
 * paren. NOT comment-aware — see the header: the naive comment stripper is what
 * dropped two real sites, and over-counting a commented-out call is the safe
 * direction.
 */
export function balanceParens(text: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== '') {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The expression inside the `expect(...)` that owns the `.toMatchObject` at
 * `dotIndex`, or `null` when the chain does not start at an `expect(`.
 *
 * Walks LEFT through the assertion chain, so `expect(x).resolves.not
 * .toMatchObject(...)` resolves to `x` rather than to `not`.
 */
export function receivedExpression(text: string, dotIndex: number): string | null {
  let i = dotIndex
  for (let hop = 0; hop < 8; hop++) {
    let j = i - 1
    while (j >= 0 && /\s/.test(text[j]!)) j--
    if (j < 0) return null

    if (text[j] !== ')') {
      // A chain segment such as `.resolves` / `.not`: step over it and retry.
      let k = j
      while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k]!)) k--
      if (k === j || k < 0 || text[k] !== '.') return null
      i = k
      continue
    }

    let depth = 0
    let p = j
    for (; p >= 0; p--) {
      const ch = text[p]!
      if (ch === ')') depth++
      else if (ch === '(') {
        depth--
        if (depth === 0) break
      }
    }
    if (p < 0) return null

    let q = p - 1
    while (q >= 0 && /\s/.test(text[q]!)) q--
    const end = q + 1
    while (q >= 0 && /[A-Za-z0-9_$]/.test(text[q]!)) q--
    if (text.slice(q + 1, end) !== 'expect') return null
    return text.slice(p + 1, j).trim()
  }
  return null
}

/**
 * The key paths inside a `toMatchObject` argument whose value is an asymmetric
 * matcher. `''` means the matcher sits at the top level, i.e. the WHOLE received
 * object is overwritten.
 *
 * Only these paths matter: P2.413 measured that the overwrite touches the exact
 * matched LEAF PATH and nothing else — which is why 26 of 28 sites are harmless
 * and why a later read of an unmatched sibling key is not a defect.
 */
export function matchedKeyPaths(argument: string): string[] {
  const paths: string[] = []
  const stack: (string | null)[] = []
  let key: string | null = null

  for (let i = 0; i < argument.length; i++) {
    const ch = argument[i]!

    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      for (; j < argument.length; j++) {
        if (argument[j] === '\\') j++
        else if (argument[j] === ch) break
      }
      let k = j + 1
      while (k < argument.length && /\s/.test(argument[k]!)) k++
      if (argument[k] === ':') {
        key = argument.slice(i + 1, j)
        i = k
      } else {
        i = j
      }
      continue
    }

    if (ch === '{') {
      stack.push(key)
      key = null
      continue
    }
    if (ch === '}') {
      stack.pop()
      key = null
      continue
    }
    if (ch === ',') {
      key = null
      continue
    }
    if (!/[A-Za-z_$]/.test(ch)) continue

    let j = i
    while (j < argument.length && /[A-Za-z0-9_$.\s]/.test(argument[j]!)) j++
    const word = argument.slice(i, j).replace(/\s+/g, '')

    if (ASYMMETRIC_MATCHERS.some((m) => word === m || word.endsWith(`.${m}`))) {
      paths.push([...stack, key].filter((part): part is string => part !== null && part !== '').join('.'))
      // Step over the matcher's OWN argument, so keys inside
      // `objectContaining({ a: 1 })` are not read as keys of the received object.
      let k = j
      while (k < argument.length && /\s/.test(argument[k]!)) k++
      const close = argument[k] === '(' ? balanceParens(argument, k) : -1
      i = close > 0 ? close : j - 1
      continue
    }

    let k = j
    while (k < argument.length && /\s/.test(argument[k]!)) k++
    if (argument[k] === ':') {
      key = word
      i = k
      continue
    }
    i = j - 1
  }

  return [...new Set(paths)]
}

export interface MatcherSite {
  file: string
  line: number
  /** The expression inside `expect(...)`, verbatim, collapsed to one line. */
  received: string
  /** Key paths overwritten by a matcher; `''` is the whole object. */
  paths: string[]
  test: string
  /**
   * What the later read touched: a matched key name, `'wholesale'` when the
   * identifier is passed on / destructured / indexed rather than read through a
   * property, or `null` when nothing reads it again. `null` is the harmless
   * case, and it is the majority.
   */
  laterRead: string | null
}

/**
 * How a later read is spelled. `?.` and `!.` are property reads too — a first
 * cut that matched only `received.` flagged `resolved?.body` as a defect, which
 * is the header's must-not-flag shape (c).
 */
const LATER_PROPERTY_RE = /^\s*[!?]*\s*\.\s*([A-Za-z0-9_$]+)/

/** A received expression we can reason about: a bound identifier, nothing else. */
const BOUND_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export async function scanMatcherMutation(
  root: string = REPO_ROOT,
  files?: readonly string[],
): Promise<{
  files: number
  sites: MatcherSite[]
  vanished: string[]
}> {
  const sites: MatcherSite[] = []
  const { texts, vanished } = files === undefined ? await loadTestSources(root) : await loadListedFiles(root, files)

  for (const [file, text] of texts) {
    if (!text.includes('toMatchObject')) continue

    const lines = text.split('\n')
    const tests = indexTestBlocks(lines)

    const lineStarts = [0]
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
    const lineOf = (index: number): number => {
      let lo = 0
      let hi = lineStarts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (lineStarts[mid]! <= index) lo = mid
        else hi = mid - 1
      }
      return lo + 1
    }

    const calls = /\.\s*toMatchObject\s*\(/g
    let match: RegExpExecArray | null
    while ((match = calls.exec(text)) !== null) {
      const open = text.indexOf('(', match.index + 1)
      const close = balanceParens(text, open)
      if (close < 0) continue

      const argument = text.slice(open + 1, close)
      if (!ASYMMETRIC_RE.test(argument)) continue

      const line = lineOf(match.index)
      const endLine = lineOf(close)
      const test = tests.find((block) => block.start <= line - 1 && line - 1 <= block.end)
      const received = receivedExpression(text, match.index)
      const paths = matchedKeyPaths(argument)

      let laterRead: string | null = null
      if (received !== null && BOUND_IDENTIFIER_RE.test(received) && test !== undefined) {
        const later = lines.slice(endLine, test.end + 1).join('\n')
        const tops = new Set(paths.map((path) => path.split('.')[0]!).filter((part) => part !== ''))
        const wholeObjectMatched = paths.includes('')
        const reads = new RegExp(`\\b${received}\\b`, 'g')
        let read: RegExpExecArray | null
        while ((read = reads.exec(later)) !== null) {
          const property = LATER_PROPERTY_RE.exec(later.slice(read.index + received.length))?.[1]
          if (property === undefined) {
            laterRead = 'wholesale'
            break
          }
          if (wholeObjectMatched || tops.has(property)) {
            laterRead = property
            break
          }
        }
      }

      sites.push({
        file,
        line,
        received: (received ?? '<not an expect() chain>').replace(/\s+/g, ' ').slice(0, 90),
        paths,
        test: test?.title.slice(0, 70) ?? '<outside any it()>',
        laterRead,
      })
    }
  }

  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { files: texts.size, sites, vanished }
}

/** Where selector 2's accepted defects are recorded. Empty is the honest start. */
export const MATCHER_BASELINE_FILE = 'scripts/matcher-mutation-baseline.txt'

/**
 * A defect's identity for baseline purposes. No line number, for the reason its
 * sibling has none: line numbers in this repo's test files drift under every
 * concurrent lane, and a key that moves with the file is a gate that cries wolf.
 */
export function matcherBaselineKey(site: {
  file: string
  test: string
  received: string
  paths: readonly string[]
}): string {
  return `${site.file} :: ${site.test} :: ${site.received} :: ${[...site.paths].sort().join('|')}`
}

/** Selector 2's CLI: report, gate, or re-record. Returns the process exit code. */
async function runMatcherSelector(mode: { report: boolean; check: boolean; update: boolean }): Promise<number> {
  const { files, sites, vanished } = await scanMatcherMutation()
  const defects = sites.filter((site) => site.laterRead !== null)
  const skipped = vanishedNotice(vanished)
  if (skipped !== undefined) console.log(skipped)

  if (mode.update) {
    const keys = [...new Set(defects.map(matcherBaselineKey))].sort()
    writeFileSync(
      join(REPO_ROOT, MATCHER_BASELINE_FILE),
      '# check-conditional-expect selector 2 baseline — ACCEPTED `toMatchObject` sites\n' +
      '# whose received object is hollowed by an asymmetric matcher and read again.\n' +
      '# Regenerate: bun scripts/check-conditional-expect.ts --update-matcher-baseline\n' +
      '# Key: <file> :: <test title> :: <received expression> :: <matched key paths>.\n' +
      '# No line numbers — they drift under every concurrent lane. See the script header.\n' +
      `# Reading at last record: ${sites.length} matcher site(s), ${defects.length} defect(s).\n` +
      `${keys.join('\n')}${keys.length > 0 ? '\n' : ''}`,
    )
    console.log(
      `check-conditional-expect: wrote ${keys.length} key(s) to ${MATCHER_BASELINE_FILE} ` +
      `(from ${sites.length} matcher site(s)).`,
    )
    return 0
  }

  const summary =
    `${files} test files, ${sites.length} \`toMatchObject\` site(s) carrying an asymmetric ` +
    `matcher, ${defects.length} of them read again afterwards`

  if (mode.report) {
    console.log(`check-conditional-expect --matchers: ${summary}.`)
    console.log(
      '  A site is harmless unless the received object is a BOUND IDENTIFIER whose matched ' +
      'key path is read after the assertion — see the header for the three shapes.',
    )
    console.log('---')
    for (const site of sites) {
      const mark = site.laterRead === null ? '  ' : `  [DEFECT: later read of ${site.laterRead}] `
      console.log(
        `${site.file}:${site.line}\n${mark}expect(${site.received}).toMatchObject(...)   ` +
        `[matched: ${site.paths.map((path) => (path === '' ? '<whole object>' : path)).join(', ')}]\n` +
        `    test: ${site.test}`,
      )
    }
    return 0
  }

  const baseline = readBaseline(REPO_ROOT, MATCHER_BASELINE_FILE)
  const { added, stale } = diffBaseline(defects.map(matcherBaselineKey), baseline)

  // D1.312 — the same unit naming as the sibling `--check` line above. Only the
  // unit is named here and no second number is added: `matcherBaselineKey` is
  // deduplicated through a `Set` on write exactly as the other one is, so the
  // same hit/key skew is POSSIBLE, but this line's left-hand side is a sentence
  // rather than a bare count, so the two numbers do not sit side by side and
  // invite the subtraction. Naming the unit is the whole of what is owed.
  console.log(`check-conditional-expect --check-matchers: ${summary} (the baseline holds ${baseline.size} KEY(s)).`)
  console.log(
    '  On bun 1.3.14 `toMatchObject` with an asymmetric matcher OVERWRITES the matched leaf of ' +
    'the RECEIVED object, so any later read of that leaf reads an empty value and its ' +
    'assertions can vanish while the suite reports green.',
  )

  if (stale.length > 0) {
    console.log(`  NOTE: ${stale.length} baseline key(s) no longer present (fixed or moved):`)
    for (const key of stale.slice(0, 10)) console.log(`    - ${key}`)
    console.log('  Re-record with: bun scripts/check-conditional-expect.ts --update-matcher-baseline')
  }

  if (added.length === 0) {
    console.log('  No new hollowed-and-reread object. PASS.')
    return 0
  }

  console.log(`  ${added.length} NEW hollowed-and-reread site(s):`)
  for (const key of added) {
    const site = defects.find((candidate) => matcherBaselineKey(candidate) === key)
    console.log(`    ${site ? `${site.file}:${site.line}` : key}`)
    console.log(
      `      expect(${site?.received ?? ''}).toMatchObject(...)   ` +
      `[matched: ${(site?.paths ?? []).map((path) => (path === '' ? '<whole object>' : path)).join(', ')}]`,
    )
    console.log(`      later read: ${site?.laterRead ?? ''}    test: ${site?.test ?? ''}`)
  }
  console.log(
    '\n  The fix that worked in `64ea6f9c5`: move the LATER read ABOVE the `toMatchObject`, so it\n' +
    '  runs against the object as the code produced it. Assert the shape afterwards. If the later\n' +
    "  read genuinely touches an unmatched sibling key, it is one of the header's harmless shapes —\n" +
    '  accept it with --update-matcher-baseline and say which shape it is in the commit message.',
  )
  return 1
}

/**
 * Which of these paths git has never seen — P3.305.
 *
 * ONE `git ls-files` call, made only when the gate is about to fail, so the
 * green path pays nothing for it. A failing git yields an empty set: the labels
 * disappear and the report is exactly what it was — a label is a convenience,
 * and it must not turn a red it only annotates into a crash. (The scan itself
 * has needed git since F1.608; see {@link listTestFiles}.)
 */
export function untrackedAmong(paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set()
  try {
    const proc = Bun.spawnSync(['git', 'ls-files', '--error-unmatch', '--', ...paths], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // `--error-unmatch` makes git exit non-zero and name the unknown paths on
    // stderr; the tracked ones still come back on stdout. Deriving the answer
    // from stdout rather than from stderr's wording keeps this independent of
    // git's message text.
    const tracked = new Set(
      new TextDecoder().decode(proc.stdout).split('\n').map((line) => line.trim()).filter(Boolean),
    )
    return new Set(paths.filter((path) => !tracked.has(path)))
  } catch {
    return new Set()
  }
}

async function main(): Promise<void> {
  // Selector 2 is a separate flag family on purpose: `lint:conditional-expect`
  // and `lint:matcher-mutation` are two gate steps, so a red names which of the
  // two classes it found rather than the file they happen to share.
  const matcherMode = {
    report: process.argv.includes('--matchers'),
    check: process.argv.includes('--check-matchers'),
    update: process.argv.includes('--update-matcher-baseline'),
  }
  if (matcherMode.report || matcherMode.check || matcherMode.update) {
    const code = await runMatcherSelector(matcherMode)
    if (code !== 0) process.exit(code)
    return
  }

  const all = process.argv.includes('--all')
  const countOnly = process.argv.includes('--count')
  const check = process.argv.includes('--check')
  const update = process.argv.includes('--update-baseline')

  const { files, candidates, vanished } = await scan()
  const undiscriminated = candidates.filter((c) => !c.discriminated)
  const skipped = vanishedNotice(vanished)
  if (skipped !== undefined) console.log(skipped)

  if (update) {
    const keys = [...new Set(undiscriminated.map(baselineKey))].sort()
    writeFileSync(
      join(REPO_ROOT, BASELINE_FILE),
      '# check-conditional-expect baseline — the ACCEPTED population, not a defect list.\n' +
      '# Regenerate: bun scripts/check-conditional-expect.ts --update-baseline\n' +
      '# Key: <file> :: <enclosing test title> :: <discriminator>. Line numbers are\n' +
      '# deliberately absent: they drift under every sibling lane and would make the\n' +
      '# gate fire on unrelated commits. See this script\'s header.\n' +
      `${keys.join('\n')}\n`,
    )
    console.log(`check-conditional-expect: wrote ${keys.length} key(s) to ${BASELINE_FILE}`)
    return
  }

  if (check) {
    const keys = undiscriminated.map(baselineKey)
    const baseline = readBaseline(REPO_ROOT)
    const { added, stale } = diffBaseline(keys, baseline)

    // D1.312 — the two numbers on this line used to be in DIFFERENT UNITS with
    // nothing saying so: `undiscriminated.length` counts HITS and
    // `baseline.size` counts distinct KEYS, which `--update-baseline` writes
    // through a `new Set`. A passing run therefore read
    // `71 undiscriminated (baseline holds 67)`, which looks exactly like four
    // unbaselined hits — and was read that way twice on 2026-09-18, once in a
    // controller brief that predicted the count would "read 67 again". The
    // comparison the gate actually makes is KEYS against KEYS; the hit count is
    // larger whenever one key covers two lines, and it is printed because a
    // reader triaging the population wants it. Name the unit beside each.
    const distinctKeys = new Set(keys)
    console.log(
      `check-conditional-expect --check: ${files} test files, ${candidates.length} candidate ` +
      `blocks, ${undiscriminated.length} undiscriminated HIT(s) over ${distinctKeys.size} distinct ` +
      `KEY(s) (file :: test :: discriminator); the baseline holds ${baseline.size} KEY(s).`,
    )
    console.log(
      '  The gate compares KEYS with KEYS, never hits with keys: the hit count is the larger of the ' +
      'two whenever one key covers more than one line.',
    )
    console.log(
      '  This gate reports a FLOOR, not a defect count, and fails only on hits NOT in ' +
      `${BASELINE_FILE} — most of the population is legitimate (see the header's three shapes).`,
    )

    if (stale.length > 0) {
      console.log(`  NOTE: ${stale.length} baseline key(s) no longer present (fixed or moved):`)
      for (const k of stale.slice(0, 10)) console.log(`    - ${k}`)
      console.log(`  Re-record with: bun scripts/check-conditional-expect.ts --update-baseline`)
    }

    if (added.length === 0) {
      console.log('  No new undiscriminated `expect` inside an `if`. PASS.')
      return
    }

    console.log(`  ${added.length} NEW undiscriminated hit(s):`)
    const addedHits = added.map((k) => ({ k, hit: undiscriminated.find((c) => baselineKey(c) === k) }))
    const untracked = untrackedAmong([...new Set(addedHits.map((r) => r.hit?.file).filter((f): f is string => f !== undefined))])
    for (const { k, hit } of addedHits) {
      const mark = hit !== undefined && untracked.has(hit.file) ? '   [untracked]' : ''
      console.log(`    ${hit ? `${hit.file}:${hit.line}` : k}${mark}`)
      console.log(`      if (${hit?.cond ?? ''})   [disc: ${hit?.disc ?? ''}]`)
      console.log(`      test: ${hit?.test ?? ''}`)
    }
    if (untracked.size > 0) {
      console.log(
        `\n  ${untracked.size} of the files above ${untracked.size === 1 ? 'is' : 'are'} UNTRACKED — git has never seen ${untracked.size === 1 ? 'it' : 'them'}.\n` +
        '  That hit belongs to whoever is writing the file, not to this tree, and it is NOT a\n' +
        '  pre-existing red: confirm on a clean worktree at your base commit before recording one.',
      )
    }
    console.log(
      '\n  Each is an `expect(...)` inside an `if (...)` whose discriminator is never asserted\n' +
      '  unconditionally, so a regression that flips the condition DELETES the assertion\n' +
      '  instead of failing it. Either assert the discriminator unconditionally, or — if this\n' +
      "  is one of the header's three legitimate shapes — accept it with --update-baseline and\n" +
      '  say which shape it is in the commit message.',
    )
    process.exit(1)
  }

  console.log(
    `check-conditional-expect: ${files} test files, ${candidates.length} candidate blocks ` +
    `(\`expect\` inside an \`if\`), ${undiscriminated.length} with NO unconditional ` +
    'discriminator assertion in the enclosing test.',
  )
  console.log(
    '  Before reading any of them, read the three legitimate shapes in this script\'s header ' +
    '(guarded from above / documented two-outcome acceptance / environment gate).',
  )
  // `--count` used to `return` here. It does not any more, so that the notice
  // below is reached by EVERY non-`--check` form — P3.305's whole point is that
  // the form a reader happens to run must not look like a passing gate, and
  // `--count` is a form a reader happens to run.
  if (!countOnly) {
    console.log('---')
    for (const h of all ? candidates : undiscriminated) {
      const mark = all ? (h.discriminated ? '  [discriminated] ' : '  ') : '  '
      console.log(`${h.file}:${h.line}\n  ${mark}if (${h.cond})   [disc: ${h.disc}]\n    test: ${h.test}`)
    }
  }
  // P3.305 — the last thing printed, because exit 0 from an instrument is
  // indistinguishable from exit 0 from a gate and one lane read it as the second.
  console.log(
    '\n(REPORT, not a gate: this form always exits 0 — see this script\'s header. ' +
    'The gate is `bun run lint:conditional-expect`, i.e. --check, which fails only on hits ' +
    `not in ${BASELINE_FILE}.)`,
  )
}

// P2.403's guard, applied here from the start: this module exports `scan()`, so
// importing it must not run the scan.
if (import.meta.main) void main()
