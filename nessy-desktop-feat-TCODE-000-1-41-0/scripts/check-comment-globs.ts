/**
 * check-comment-globs — a path pattern written into a block comment CLOSES it.
 *
 * P2.492.
 *
 * ## The defect
 *
 * A block comment ends at the first star-then-slash. Write a directory glob
 * into one — the wildcard segment of any workspace path — and the comment ends
 * in the middle of the sentence. Everything after it becomes code.
 *
 * Four separate instances on 2026-08-31, two of them the controller's, all
 * AFTER the trap had been written down twice in this repo. The costs were not
 * cosmetic:
 *
 *   - one produced nine hard errors in a shared module and made `tsc` report
 *     the SYNTACTIC category instead of the semantic one, so every typecheck in
 *     the repo went blind for a window while exiting non-zero against someone
 *     else's file — three lanes read that output and two blamed the wrong owner;
 *   - another landed in `check-exports-map.ts` itself (`704b80f07`, fixed by
 *     `82671b752`) and stopped the gate parsing at line 9, so the check could
 *     not run at all.
 *
 * A rule that fails four times in one day with everyone aware of it does not
 * want more care. It wants a check.
 *
 * ## Why it cannot be a grep
 *
 * The same sequence is legal and deliberate inside a string: `check-exports-map`
 * holds workspace globs in a constant, which is exactly where they belong. A
 * grep fires on that constant and on nothing else, so it would be pure noise.
 * This gate asks `ts-comment-scan` which spans are comments and looks only
 * there.
 *
 * ## What it reports
 *
 *   - a block comment whose terminator is the tail of a path pattern — the run
 *     of stars ending it is preceded by a slash that came from the comment's own
 *     text rather than from its opening delimiter;
 *   - a block comment with no terminator at all, which is the same mistake seen
 *     from the far end of the file.
 *
 * ## The remedy is not "escape it"
 *
 * The durable fix at every one of the four sites was to STOP REPEATING THE
 * PATTERN IN PROSE and point at the constant that holds it — a comment and a
 * constant that both spell out a glob are two things to keep in step, and the
 * comment is the one nothing checks. The diagnostic says so, because a
 * diagnostic that only names the character sequence invites an escape, and an
 * escaped glob in prose is still a second copy.
 *
 * ## How it reads the tree (F1.195, the D1.318/D1.320 shape)
 *
 * It enumerates with `git ls-files` (the INDEX) and reads a CLEAN file's bytes
 * as its index blob, all of them through ONE `git cat-file --batch`; only the
 * files `git status --porcelain` names are opened from disk, and one deleted in
 * the working tree is named and skipped. A clean file's working-tree bytes ARE
 * its index blob, which is what clean means, so the verdict is the one a
 * per-file `readFileSync` gave — measured 2026-09-23 as 201 s at `user 0.60`
 * over 5 303 files on this rig, every second of it open latency. See
 * {@link loadSourceTexts}.
 *
 * Usage:
 *   bun scripts/check-comment-globs.ts            # report
 *   bun scripts/check-comment-globs.ts --check    # exit 1 on any finding
 */

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'
import { parsePorcelainZ } from './git-status-z'
import { readFilesConcurrently } from './read-changed-files'
import { scanSpans, type Span } from './ts-comment-scan'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export type FindingKind = 'closed-by-a-path-pattern' | 'never-closed'

export interface Finding {
  readonly file: string
  readonly line: number
  readonly kind: FindingKind
  /** The comment's last line as written, trimmed — enough to recognise the site. */
  readonly excerpt: string
}

const lineOf = (text: string, offset: number): number =>
  text.slice(0, offset).split('\n').length

/**
 * Did this block comment end because someone wrote a path pattern into it?
 *
 * The terminator is a run of one or more stars followed by a slash. When that
 * run is immediately preceded by a slash from the comment BODY, the sequence
 * read as a glob's wildcard segment, not as a closer somebody meant to write.
 * The run must not reach back to the comment's own opening delimiter, or an
 * empty block comment would report itself.
 */
export function closedByPathPattern(text: string, span: Span): boolean {
  if (span.unterminated) return false
  let run = span.end - 2
  while (run > span.start && text[run - 1] === '*') run -= 1
  if (run <= span.start + 2) return false
  return text[run - 1] === '/'
}

export function findInSource(file: string, text: string): Finding[] {
  const findings: Finding[] = []
  for (const span of scanSpans(text)) {
    if (span.kind !== 'block-comment') continue

    const kind: FindingKind | null = span.unterminated
      ? 'never-closed'
      : closedByPathPattern(text, span)
        ? 'closed-by-a-path-pattern'
        : null
    if (kind === null) continue

    const offset = span.unterminated ? span.start : span.end - 1
    const body = text.slice(span.start, span.end)
    const lastLine = body.split('\n').filter((l) => l.trim() !== '').pop() ?? body
    findings.push({
      file,
      line: lineOf(text, offset),
      kind,
      excerpt: lastLine.trim().slice(0, 120),
    })
  }
  return findings
}

/** Every extension this gate scans — ONE list, so the enumeration and the dirty set cannot disagree. */
export const SCANNED_PATHSPEC: readonly string[] = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.mjs', '*.cjs', '*.js', '*.jsx']

export function scannedFiles(root: string = REPO_ROOT): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--', ...SCANNED_PATHSPEC],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return out
    .split('\0')
    .filter((f) => f !== '')
    .filter((f) => !f.startsWith('.references/'))
}

/**
 * The paths whose working-tree bytes may differ from their index blob — every
 * entry `git status --porcelain` prints for the scanned extensions. Read with
 * `-z`, so a path with a space or a quote is not mangled; a rename or copy
 * entry carries its ORIGIN as the next field, and only its destination is in
 * the index, so the origin is skipped. An untracked `??` path is named too and
 * harmless: `git ls-files` never enumerates it.
 */
function dirtyPaths(root: string): Set<string> {
  // The loop that stood here moved to `git-status-z.ts` (F1.271), so the NUL
  // gate reads the same fields the same way.
  return parsePorcelainZ(execFileSync('git', ['status', '--porcelain', '-z', '--', ...SCANNED_PATHSPEC], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }))
}

export interface LoadedSourceTexts {
  /** The text of every enumerated file that could be read. */
  readonly texts: Map<string, string>
  /** Enumerated (in the index) but DELETED in the working tree — named, never read. */
  readonly skipped: string[]
}

/**
 * F1.195 — read every enumerated file: the clean ones through ONE
 * `git cat-file --batch` over their index blobs, the ones `git status` names
 * from disk, and a pending deletion not at all.
 *
 * The model is `check-nul-bytes.ts`'s `loadSources` (D1.320), whose docblock
 * carries the measurement that made both gates change: opening a file on this
 * rig costs ~180 ms whoever opens it, and `git cat-file --batch` read 860
 * files in ~2 s where `readFileSync` took 155 s. It is not imported because its
 * dirty set is scoped to `.ts`/`.tsx` and this gate also scans the JavaScript
 * extensions — a modified `.js` read as its stale blob would be a silent miss.
 *
 * The batch protocol: header line `<oid> <type> <size>`, then exactly that many
 * BYTES, then a newline — sliced by the declared size as bytes, and only then
 * decoded, because a multi-byte character makes the character count and the
 * byte count disagree. A header that is not a blob (`<name> missing`) names the
 * file as skipped rather than guessing.
 *
 * The changed files are opened all at once through `read-changed-files.ts`
 * (F1.622): opened one after another they were this gate's remaining cost.
 */
export async function loadSourceTexts(files: readonly string[], root: string = REPO_ROOT): Promise<LoadedSourceTexts> {
  const dirty = dirtyPaths(root)
  const texts = new Map<string, string>()
  const skipped: string[] = []
  const batched = files.filter((file) => !dirty.has(file))

  const opened = files.filter((file) => dirty.has(file))
  const reads = await readFilesConcurrently(opened.map((file) => join(root, file)))
  opened.forEach((file, index) => {
    const read = reads[index]!
    if (read.ok) texts.set(file, read.bytes.toString('utf-8'))
    // In the index, gone from the disk: the state that crashed the sibling
    // gate at its step of `lint:chain` (D1.320).
    else skipped.push(file)
  })

  if (batched.length > 0) {
    const stdout = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: `${batched.map((file) => `:${file}`).join('\n')}\n`,
      maxBuffer: 1024 * 1024 * 1024,
    })
    let at = 0
    for (const file of batched) {
      const newline = stdout.indexOf(0x0a, at)
      if (newline < 0) { skipped.push(file); continue }
      const header = stdout.toString('utf8', at, newline).split(' ')
      const size = Number(header[2])
      if (header[1] !== 'blob' || !Number.isFinite(size)) { at = newline + 1; skipped.push(file); continue }
      texts.set(file, stdout.toString('utf8', newline + 1, newline + 1 + size))
      at = newline + 1 + size + 1
    }
  }

  return { texts, skipped }
}

const REMEDY = [
  '  The fix is NOT to escape the sequence. Delete the pattern from the prose and point',
  '  at the constant that holds it — a comment and a constant that both spell out a glob',
  '  are two copies, and the comment is the one nothing checks. `82671b752` is the',
  '  worked example, in this repo, in the gate this one sits beside.',
].join('\n')

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check')
  const files = scannedFiles()
  if (files.length === 0) {
    throw new GateSafetyRefusal('REFUSED: no tracked source files to scan — the run would be vacuous.')
  }

  const loaded = await loadSourceTexts(files)
  const findings: Finding[] = []
  for (const file of files) {
    const text = loaded.texts.get(file)
    if (text !== undefined) findings.push(...findInSource(file, text))
  }

  for (const file of loaded.skipped) {
    console.log(`  skipped (deleted in the working tree, still in the index): ${file} — no text to read.`)
  }

  for (const f of findings) {
    console.log(
      `${f.file}:${f.line}  ${f.kind === 'never-closed' ? 'block comment never closed' : 'block comment closed by a path pattern'}\n` +
      `    ${f.excerpt}`,
    )
  }

  console.log(
    `check-comment-globs: ${findings.length} block comment(s) closed by a path pattern ` +
    `across ${files.length} tracked source file(s)` +
    `${loaded.skipped.length > 0 ? `; ${loaded.skipped.length} deleted file(s) skipped` : ''}.`,
  )
  if (findings.length > 0) console.log(REMEDY)

  return check && findings.length > 0 ? 1 : 0
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  })
}
