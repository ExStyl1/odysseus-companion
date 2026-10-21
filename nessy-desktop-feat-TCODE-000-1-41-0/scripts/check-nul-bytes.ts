/**
 * check-nul-bytes — which tracked TypeScript files carry a raw NUL byte, and
 * therefore silently defeat any absence claim made with plain `grep`.
 *
 * P2.411.
 *
 * ## The defect this exists to make visible
 *
 * A NUL byte in a source file is legal TypeScript — it is a hash or cache-key
 * domain separator, written as the raw byte instead of the `\u0000` escape. It
 * changes nothing at runtime and everything about searching:
 *
 *   $ grep -c ManagedPolicyCaveat packages/server-core/src/bootstrap/storage-runtime.ts
 *   $                                     <- no output, exit 1
 *   $ grep -ac ManagedPolicyCaveat packages/server-core/src/bootstrap/storage-runtime.ts
 *   4
 *
 * Plain `grep` classifies the file as binary and skips it **without saying so**.
 * A sweep over such a file reports a clean absence while never having read it.
 * One lane lost ten `withCapabilitySnapshot` call sites this way.
 *
 * ## The instrument, and why BOTH obvious ones are wrong
 *
 * Measured 2026-08-29 over this repo's 6,000-odd tracked `.ts`/`.tsx` files:
 *
 * | Instrument | Result |
 * | --- | --- |
 * | this script — read every byte of every file | **14 of 14** |
 * | `comm -23 <(git ls-files) <(git grep -lI '')` | **4 of 14, plus 1 file that carries no NUL at all** |
 * | plain `grep` / `grep -c` over the same files | 0 of 14, and SILENT about it |
 *
 * The middle row is the trap, because it is the clever answer and it looks like
 * a complete one. **Git's binary detection only inspects a prefix of the blob**,
 * and the cut measured here falls between 3848 and 10046: it sees the four files
 * whose first NUL sits at 730 / 1787 / 1981 / 3848 and misses the ten whose first
 * NUL sits at 10046 and beyond — including `base-agent.ts` (25606) and
 * `storage-runtime.ts` (33936), the two that matter most. (Git's own constant is
 * `FIRST_FEW_BYTES` = 8000, which is consistent with the split; the SPLIT is what
 * was measured here, the constant is not.) It ALSO reports
 * `packages/shared/src/agent/__tests__/__tmp_build_call_llm__/empty.ts`, which is
 * a zero-byte file carrying no NUL at all: `git grep -lI ''` matches lines, and a
 * file with no lines has none to match. So the shortcut is wrong in both
 * directions at once, which is exactly the shape of an answer nobody re-checks.
 *
 * And one probe that manufactures a false positive with total confidence:
 * `grep -qa $'\x00' <file>` under zsh. **A shell argument cannot carry a NUL**, so
 * the pattern collapses to the empty string and matches every line of every file.
 * It once reported 6,449 affected files. Detect a NUL by READING BYTES — which is
 * all this script does.
 *
 * ## The reading, dated
 *
 * 2026-08-29, `bun scripts/check-nul-bytes.ts`: **14 tracked `.ts`/`.tsx` files**,
 * 28 NUL bytes in total. The same commit escaped 25 of those 28 as `\u0000` in the
 * twelve files not held by another lane, leaving `packages/shared/src/agent/
 * base-agent.ts` (1) and `packages/server-core/src/bootstrap/storage-runtime.ts`
 * (2) for the lanes that hold them.
 *
 * **Do not trust that number, or any number in prose about this — re-run the
 * script.** The count in this tree's documentation has read "one", "eight",
 * "thirteen" and "fourteen" at different times, each written by someone who had
 * measured it correctly at the time. That is the whole reason this is a committed
 * script and not a sentence.
 *
 * ## The fix, when you find one
 *
 * Write `\u0000` (six ASCII characters) instead of the raw byte. Inside a string
 * or template literal the escape denotes exactly U+0000, so the runtime value —
 * and any hash taken over it — is byte-identical, while the source stays text and
 * stays greppable. `fb7970791` did this for `scripts/gate-projects.ts` and is the
 * worked example. Prove it the mechanical way: replacing the six-character
 * sequence in the new file with a raw NUL must reproduce the old file byte for
 * byte.
 *
 * Usage:
 *   bun scripts/check-nul-bytes.ts                 # report over tracked *.ts/*.tsx
 *   bun scripts/check-nul-bytes.ts --check         # same, but exit 1 if any found
 *   bun scripts/check-nul-bytes.ts <path> [<path>] # report over given repo-relative paths
 *   bun scripts/check-nul-bytes.ts --rev <sha>     # read a past commit — the historical control
 *
 * The default exit code is 0: two files still carry NULs on purpose, held by
 * other lanes, so a failing default would be a red gate nobody could turn green.
 * `--check` is there for the commit that closes the last of them.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertInsideRepo, assertNoHomeOrRootPath, GateSafetyRefusal } from './gate-safety'
import { parsePorcelainZ } from './git-status-z'
import { readFilesConcurrently } from './read-changed-files'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface NulFinding {
  /** Repo-relative path, POSIX separators. */
  file: string
  /** Byte offset of the FIRST NUL — the number that decides whether git sees it. */
  firstOffset: number
  /** How many NUL bytes the file carries in total. */
  count: number
  /** 1-based line numbers carrying at least one NUL. */
  lines: number[]
}

/**
 * Git stops looking for a NUL after this many bytes when deciding whether a blob
 * is binary. Recorded here because it is the reason the `git grep -lI` shortcut
 * under-reports, not because this script uses it.
 */
export const GIT_BINARY_DETECTION_PREFIX_BYTES = 8000

/**
 * Where to read from — D1.320.
 *
 * `root` is the repository to read (the tests build a temp one with a pending
 * deletion in it; this tree is never mutated to test a gate). `rev` reads a past
 * commit instead of the working tree, which is how the historical control below
 * is taken.
 */
export interface SourceOptions {
  readonly root?: string
  readonly rev?: string
}

function git(args: readonly string[], options: SourceOptions = {}): string {
  return execFileSync('git', [...args], {
    cwd: options.root ?? REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Every tracked `.ts`/`.tsx` file, repo-relative. */
export function trackedTypeScriptFiles(options: SourceOptions = {}): string[] {
  if (options.rev === undefined) {
    return git(['ls-files', '-z', '--', '*.ts', '*.tsx'], options).split('\0').filter((f) => f !== '')
  }
  // `git ls-tree` refuses `:(glob)` pathspec magic, so a revision is listed whole
  // and filtered here (measured 2026-09-18 — the same refusal
  // `check-shape-pointer-reasons` records). `-z` for the reason `ls-files` has
  // it (F1.453): without it git C-quotes a name carrying a double quote, a
  // backslash or a non-ASCII byte, the closing quote fails the extension test,
  // and the historical control silently drops the file.
  return git(['ls-tree', '-r', '-z', '--name-only', options.rev], options)
    .split('\0').filter((f) => /\.tsx?$/.test(f))
}

/**
 * Tracked paths whose working tree differs from the index — read with `-z`
 * through the parser `check-comment-globs.ts` shares (F1.271: the unquoted form
 * mangled a path git quotes, and read its stale blob). See `git-status-z.ts`.
 */
function dirtyPaths(options: SourceOptions): Set<string> {
  if (options.rev !== undefined) return new Set()
  return parsePorcelainZ(git(['status', '--porcelain', '-z', '--', '*.ts', '*.tsx'], options))
}

export interface LoadedSources {
  /** The bytes of every file that could be read. */
  bytes: Map<string, Buffer>
  /** Enumerated but DELETED in the working tree — reported, never read. */
  skipped: string[]
}

/**
 * Read every enumerated file — through ONE `git cat-file --batch` for the clean
 * ones, from disk for the few the working tree has changed, and NOT AT ALL for
 * the ones it has deleted.
 *
 * D1.320, and both halves were measured rather than reasoned:
 *
 *  - **The crash.** This gate enumerated with `git ls-files` (the INDEX) and read
 *    with `readFileSync` (the DISK). A tracked file deleted and not yet committed
 *    is in the first and not the second, so the gate died with a raw
 *    `ENOENT … at scanFile` — and `lint:nul-bytes` is the SECOND step of
 *    `lint:chain`, so every lane's chain run died on one lane's pending deletion.
 *    Measured 2026-09-18 on `packages/server-core/src/__tests__/fixtures/test-jwt.ts`
 *    while it sat ` D`; the same gate had answered `0 of 5090` twenty minutes
 *    earlier. A deleted file is now NAMED on stdout and skipped: it has no bytes
 *    to carry a NUL, and the gate's job is to report, not to die.
 *  - **The speed.** Opening files on this rig costs ~180 ms each whatever opens
 *    them — 860 files cost `readFileSync` 155 s and one `cat` process 138.81 s
 *    (`user 0.00`), against 0.27 s for `git grep` over 4 790 and ~2 s for
 *    `git cat-file --batch` over the 860. This gate opens EVERY tracked `.ts`.
 *    Reading clean files as blobs is not a shortcut: a clean file's working-tree
 *    bytes ARE its index blob, which is what clean means.
 *
 * The batch protocol: header line `<oid> <type> <size>`, then exactly that many
 * BYTES, then a newline. Sliced by the declared size and kept as a Buffer —
 * never decoded, never split on a separator, because the subject of this gate is
 * a byte that a decoder or a separator scan would be the first thing to lose.
 *
 * The changed files are opened all at once through `read-changed-files.ts`
 * (F1.622): opened one after another they were this gate's remaining cost.
 */
export async function loadSources(files: readonly string[], options: SourceOptions = {}): Promise<LoadedSources> {
  const root = options.root ?? REPO_ROOT
  const dirty = dirtyPaths(options)
  const bytes = new Map<string, Buffer>()
  const skipped: string[] = []

  const batched = files.filter((file) => !dirty.has(file))
  const opened = files.filter((file) => dirty.has(file))
  const reads = await readFilesConcurrently(opened.map((file) => resolve(root, file)))
  opened.forEach((file, index) => {
    const read = reads[index]!
    if (read.ok) bytes.set(file, read.bytes)
    // Any failure: deleted in the working tree but still in the index — the
    // whole reason this function exists.
    else skipped.push(file)
  })

  if (batched.length > 0) {
    const prefix = options.rev ?? ''
    const stdout = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: `${batched.map((file) => `${prefix}:${file}`).join('\n')}\n`,
      maxBuffer: 512 * 1024 * 1024,
    })
    let at = 0
    for (const file of batched) {
      const newline = stdout.indexOf(0x0a, at)
      if (newline < 0) break
      const size = Number(stdout.toString('utf8', at, newline).split(' ')[2])
      if (!Number.isFinite(size)) { at = newline + 1; skipped.push(file); continue }
      bytes.set(file, stdout.subarray(newline + 1, newline + 1 + size))
      at = newline + 1 + size + 1
    }
  }

  return { bytes, skipped }
}

/**
 * Read `file` whole and report its NUL bytes. Reading the WHOLE file is the
 * point: every cheaper instrument in this script's header fails by reading a
 * prefix, or by not reading at all.
 *
 * `trusted` says where the path came from, and it buys a 30x speedup honestly
 * rather than by weakening the guard where it matters. A path typed as an
 * ARGUMENT is operator input and gets the full `realpath` containment check. A
 * path that came out of `git ls-files -z` did not: it is repo-relative by
 * construction, there are ~3900 of them, and `assertInsideRepo` costs two
 * `realpath` calls each — measured here at 16.3s against 0.5s for reading every
 * one of those files. Those keep the cheap textual refusal (`~`, `$HOME`, an
 * absolute path), which is what would catch a mangled enumeration. The residue
 * is a tracked symlink whose target sits outside the tree: this script would read
 * it and print its repo-relative name. It reads and reports; it executes,
 * modifies and deletes nothing, so that residue is a wrong line of output rather
 * than a wrong action.
 */
export function scanFile(repoRelative: string, trusted = false, loaded?: Buffer): NulFinding | null {
  let absolute: string
  if (trusted) {
    assertNoHomeOrRootPath('an enumerated file', repoRelative)
    absolute = resolve(REPO_ROOT, repoRelative)
  } else {
    absolute = assertInsideRepo(REPO_ROOT, repoRelative)
  }
  // The guards above run either way: `loaded` changes WHERE the bytes came from,
  // never whether the path was allowed to be named.
  const bytes = loaded ?? readFileSync(absolute)

  const firstOffset = bytes.indexOf(0)
  if (firstOffset < 0) return null

  let count = 0
  const lines: number[] = []
  let line = 1
  for (const byte of bytes) {
    if (byte === 0) {
      count++
      if (lines[lines.length - 1] !== line) lines.push(line)
    } else if (byte === 0x0a) {
      line++
    }
  }

  return { file: relative(REPO_ROOT, absolute), firstOffset, count, lines }
}

export function scan(files: string[], trusted = false, loaded?: Map<string, Buffer>): NulFinding[] {
  const findings: NulFinding[] = []
  for (const file of files) {
    // A file the loader could not read is a DELETED one; it is named by the
    // caller and has no bytes to carry a NUL.
    if (loaded !== undefined && !loaded.has(file)) continue
    const finding = scanFile(file, trusted, loaded?.get(file))
    if (finding !== null) findings.push(finding)
  }
  return findings.sort((a, b) => a.firstOffset - b.firstOffset)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const revAt = args.indexOf('--rev')
  const rev = revAt < 0 ? undefined : args[revAt + 1]
  const paths = args.filter((a, index) => !a.startsWith('--') && index !== revAt + 1)

  const fromArgs = paths.length > 0
  const options: SourceOptions = rev === undefined ? {} : { rev }
  const files = fromArgs ? paths : trackedTypeScriptFiles(options)
  const loaded = await loadSources(files, options)
  const findings = scan(files, !fromArgs, loaded.bytes)

  for (const file of loaded.skipped) {
    console.log(
      `  skipped (deleted in the working tree, still in the index): ${file} — no bytes to read.`,
    )
  }

  for (const f of findings) {
    console.log(
      `first@${String(f.firstOffset).padStart(7)}  n=${f.count}  ${f.file}  ` +
      `(line${f.lines.length > 1 ? 's' : ''} ${f.lines.join(', ')})`,
    )
  }

  const totalNuls = findings.reduce((sum, f) => sum + f.count, 0)
  const where = rev === undefined ? '' : ` in revision ${rev}`
  console.log(
    `check-nul-bytes: ${findings.length} of ${files.length} file(s) carry a NUL byte${where} ` +
    `(${totalNuls} NUL bytes total` +
    `${loaded.skipped.length > 0 ? `; ${loaded.skipped.length} deleted file(s) skipped` : ''}).`,
  )
  if (findings.length > 0) {
    const pastGitPrefix = findings.filter((f) => f.firstOffset >= GIT_BINARY_DETECTION_PREFIX_BYTES)
    console.log(
      `  ${pastGitPrefix.length} of them carry their first NUL past byte ` +
      `${GIT_BINARY_DETECTION_PREFIX_BYTES}, which is past the prefix git inspects — so git ` +
      'does NOT call those files binary, and any `git grep -lI` shortcut misses them entirely.',
    )
    console.log(
      '  Any absence claim over any of these files made with plain `grep` is worthless: ' +
      'grep skips them SILENTLY. Use `grep -a`, or escape the byte as `\\u0000` ' +
      '(identical runtime value — see this script\'s header).',
    )
  }

  if (check && findings.length > 0) process.exit(1)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  })
}
