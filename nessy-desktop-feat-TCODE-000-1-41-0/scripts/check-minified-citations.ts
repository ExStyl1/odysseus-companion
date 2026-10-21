/**
 * check-minified-citations — a comment that cites a bundle symbol by its
 * MINIFIED name is a citation with a half-life of one dependency bump.
 *
 * P3.309. The vendored Claude Agent SDK ships as one minified file, and this
 * tree documents its behaviour by naming symbols inside it — `Mf()`, `tQ()`,
 * `uS()`. Those names are assigned by the minifier, so a bump reassigns them:
 * the comment keeps reading fluently while pointing at nothing, or worse at a
 * DIFFERENT function.
 *
 * ## Why this is a gate and not a lint preference
 *
 * The 0.3.223 -> 0.3.233 bump did exactly that, and one of the citations was
 * not prose but an INSTRUMENT: a guard located its subject by minified name,
 * the bump reassigned it, the guard read an empty list, and two of its four
 * assertions passed over nothing. A control that silently stops controlling is
 * this repo's largest defect class, and a stale minified citation is the
 * cheapest possible way to manufacture one.
 *
 * ## What it checks, stated so nobody assumes more
 *
 *  1. FILES: only those that discuss the vendored bundle at all — they mention
 *     `sdk.mjs`, "shipped binary", "the vendored SDK/bundle" or "in the bundle".
 *     A `Map()` in an unrelated file is not a bundle citation and this must not
 *     pretend otherwise.
 *  2. NAMES: every backticked `x()` / `xyz()` of one to five characters in those
 *     files. Deliberately NOT filtered to "looks minified": every attempt to
 *     decide that mechanically is a guess, and a guess inside a guard is the
 *     thing being guarded against. Ordinary words that resolve cost nothing;
 *     ordinary words that do not are recorded in the baseline with a reason.
 *  3. VERDICT: does the name appear in `sdk.mjs` in a position where a symbol
 *     could be declared or called. It cannot prove the citation still describes
 *     the right function — only that it describes SOMETHING. That is a real
 *     limit and it is the honest one: a bump that reassigns `Mf` to an unrelated
 *     function leaves this green, and only rewriting the citation to locate by
 *     CONTENT (a verbatim string the symbol contains) fixes that.
 *
 * ## Two refusals rather than two silent passes
 *
 *  - **No bundle** (a checkout with no `bun install`): REFUSE, loudly, exit 0.
 *    Not a pass — a pass here would be a gate reporting green because it could
 *    not find its subject, which is P3.309 itself in the checker written to
 *    catch it.
 *  - **Implausible resolution rate**: if fewer than half the cited names resolve,
 *    the matcher is broken rather than the tree, and reporting dozens of stale
 *    citations would be an artefact. REFUSE and exit 1.
 *
 * Usage:
 *   bun scripts/check-minified-citations.ts            # REPORT, always exit 0
 *   bun scripts/check-minified-citations.ts --check    # the gate: exit 1 on a NEW stale citation
 *   bun scripts/check-minified-citations.ts --update-baseline
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BUNDLE = 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
export const BASELINE_FILE = 'scripts/minified-citation-baseline.txt'

/**
 * The NATIVE binary, and it is a second artifact rather than a copy of the first
 * — P3.309, second pass (W2-x).
 *
 * `sdk.mjs` is the JS core; the `claude` binary beside it (188 MB / 197 171 680
 * bytes at `0.3.251`, 222 MB at `0.3.247`, 307 MB before that — a size is a
 * reading with a date, so the two timing figures below are quoted with theirs,
 * and the artefact has now SHRUNK twice in a row) is where a whole
 * class of behaviour actually lives, and this repo documents it by naming symbols
 * inside it exactly as it does for the bundle. Checking only `sdk.mjs` made every
 * such citation invisible: `claude-managed-settings.ts` cites `Ebg`, `XTr` and
 * `vbg`, all three of which are REAL — measured present in the binary, with
 * `zzqzzq` absent as the negative control on the same rig — and none of which
 * this checker could see or resolve.
 *
 * Derived from the platform package directory rather than pinned to
 * darwin-arm64: `manifest.json` names five platforms and only one is installed on
 * any given machine.
 */
export const NATIVE_BINARY_GLOB = 'node_modules/@anthropic-ai/claude-agent-sdk-'

/** This checker and its test — see the note at the filter that uses it. */
const SELF = new Set(['scripts/check-minified-citations.ts', 'scripts/check-minified-citations.test.ts'])

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git', 'release', 'out', 'coverage', '.vite', '.references'])

/**
 * A file only counts if it is talking about the vendored bundle.
 *
 * Written with a CAPTURING group rather than `(?:…)`, because this same source
 * is handed to `git grep -E`, whose POSIX engine rejects `?:` outright —
 * `repetition-operator operand invalid`, which is a loud failure and was, but a
 * second hand-kept copy of the pattern for git would be the drift this file is
 * about. One pattern, spelled so both engines accept it.
 */
export const BUNDLE_TALK = /sdk\.mjs|claude-agent-sdk-|shipped binary|native binary|the vendored (SDK|bundle)|in the bundle/

/**
 * A backticked call of one to five characters: `Mf()`, `$y()`, `bN_()` — and,
 * since P3.309's second pass, one carrying ARGUMENTS: `vbg(d)`.
 *
 * The empty-parens-only form was a blind spot with a measured cost: three real
 * citations in `claude-managed-settings.ts` were written `vbg(d)` and `Ebg` and
 * this checker never considered any of them.
 *
 * WHERE THIS DELIBERATELY STOPS, with the number that decides it. Accepting a
 * BARE backticked name would take the candidate set from **56 to 432** over the
 * same files, because every short backticked identifier in prose — a field, a
 * type, a JSON key — would enter it. Most are not bundle symbols at all, the
 * baseline would swamp the signal, and a gate whose baseline is mostly noise is
 * one nobody reads. So a citation must look like a CALL. The residue is real and
 * named rather than hidden: a bare `` `Ebg` `` is still not scanned.
 */
export const CITATION = /`(\$?[A-Za-z_][A-Za-z0-9_$]{0,4})\([^`]*\)`/g

export interface Citation { readonly name: string; readonly files: readonly string[] }

/**
 * The candidate files, selected by `git grep` rather than by walking and
 * reading the tree.
 *
 * Measured 2026-09-03, and the reason this is not a preference: reading all
 * 5 808 tracked `.ts`/`.tsx` to test each against {@link BUNDLE_TALK} did not
 * finish inside a 300 s budget under wave load, while `git grep -l` answers the
 * same question in about two seconds because the scan happens in C. The regex
 * below is the same one, handed to git.
 *
 * `--untracked` is deliberate: a citation written minutes ago in a file nobody
 * has committed is exactly as stale-able as a committed one, and a gate that
 * only sees committed files cannot stop anything before it is committed.
 *
 * No git, no fallback, and that is on purpose — a walk-and-read fallback would
 * be the slow path this exists to avoid, arriving silently on the one machine
 * where nobody is watching. Refuse instead.
 */
export function bundleDiscussingFiles(repoRoot: string = REPO_ROOT): string[] {
  const proc = Bun.spawnSync(
    ['git', 'grep', '-l', '--untracked', '-E', BUNDLE_TALK.source, '--', '*.ts', '*.tsx'],
    { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
  )
  const out = new TextDecoder().decode(proc.stdout).split('\n').map((line) => line.trim()).filter(Boolean)
  // git grep exits 1 for "no matches", which is a legitimate empty answer; any
  // other non-zero is a broken instrument and must not read as "nothing cited".
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    throw new Error(
      `check-minified-citations: \`git grep\` failed (exit ${proc.exitCode}): ` +
      `${new TextDecoder().decode(proc.stderr).trim().slice(0, 300)}`,
    )
  }
  return out
    .filter((file) => !file.split('/').some((segment) => SKIPPED_DIRS.has(segment)))
    // SELF, and kept to exactly two files. A checker whose subject is citations
    // necessarily contains example citations — this file's own docblock names
    // `Mf()` and a made-up one — and scanning itself would report them as stale
    // findings forever. Widening this list any further would blind the guard to
    // real citations in the same files, which is why it is two names and not a
    // directory.
    .filter((file) => !SELF.has(file))
}

/** Every short backticked call in every file that discusses the bundle. */
export function collectCitations(repoRoot: string = REPO_ROOT): Citation[] {
  const cited = new Map<string, Set<string>>()
  for (const file of bundleDiscussingFiles(repoRoot)) {
    const source = readFileSync(join(repoRoot, file), 'utf8')
    for (const match of source.matchAll(CITATION)) {
      const name = match[1] as string
      if (!cited.has(name)) cited.set(name, new Set())
      ;(cited.get(name) as Set<string>).add(file)
    }
  }
  return [...cited.entries()]
    .map(([name, files]) => ({ name, files: [...files].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Does the bundle carry this symbol anywhere a declaration or a call could sit.
 *
 * Bounded on purpose: a minified bundle has no structure to parse cheaply, and
 * a full parse would buy precision this gate does not need. What it must not do
 * is match the name inside a longer identifier — `Mf` inside `xMfy` — which the
 * boundary character on each side prevents.
 */
export function resolvesInBundle(bundle: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, '\\$')
  return new RegExp(`(?:^|[\\s,;{}()=[\\]!&|?:])${escaped}\\s*(?:=|\\()`, 'm').test(bundle)
}

/**
 * The installed platform binary's path, or null when none is installed.
 *
 * One directory listing, no glob library, no platform table to go stale: the
 * package is `claude-agent-sdk-<platform>-<arch>` and `manifest.json` names five
 * of them, exactly one of which is ever on disk.
 */
export function nativeBinaryPath(repoRoot: string = REPO_ROOT): string | null {
  const parent = join(repoRoot, 'node_modules/@anthropic-ai')
  if (!existsSync(parent)) return null
  for (const entry of readdirSync(parent)) {
    if (!entry.startsWith('claude-agent-sdk-') || entry === 'claude-agent-sdk-') continue
    const candidate = join(parent, entry, 'claude')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Does the name appear in the NATIVE binary — read whole, not through a window.
 *
 * Two measurements shape this, both 2026-09-03 on the 307 MB darwin-arm64 build:
 *
 *  - reading it costs **44 ms** and decoding it to a latin1 string **40 ms**, so
 *    reading the whole file is cheap and there is no reason to sample a window.
 *    A window is how an absence claim becomes an artefact of where you looked.
 *  - the boundary regex over 307 MB costs **~1.5 s per name**, which is why it is
 *    reached only after `Buffer.indexOf` (**~20 ms**) says the name is in there at
 *    all, and only for names that already failed against `sdk.mjs`. A name absent
 *    from the bytes cannot be a symbol, and that is decided for the price of a
 *    memchr.
 *
 * `latin1` rather than `utf8` on purpose: the file is not text, and a utf8 decode
 * would replace invalid sequences and silently move every offset after them.
 *
 * ## HOW WEAK THIS EVIDENCE IS, measured rather than assumed
 *
 * 307 MB of machine code contains almost every short byte sequence by accident.
 * Control run 2026-09-03, nonsense names of the same SHAPE as real citations:
 *
 *   - **2 characters: 5 of 5 resolved by chance.**
 *   - 3 characters: 2 of 10.
 *   - `zzqzzq` (6): 0.
 *
 * So a positive answer here is **NOT evidence that a citation is live** — for a
 * two-character name it is worth nothing at all. It means only that the gate
 * cannot prove the citation stale, which is exactly the job it is being given:
 * P3.309's first pass accused twelve citations of being stale on `sdk.mjs`
 * evidence alone, and every one of them turned out to name a symbol the NATIVE
 * binary carries. Refusing to accuse is the whole value; confirming is beyond it.
 *
 * The consequence, stated so no reader takes the green for more than it is: this
 * gate is meaningful against `sdk.mjs`, where the haystack is 1.3 MB of
 * JavaScript, and is a false-accusation brake against the binary. A citation into
 * the binary that really did go stale will very likely pass. Only rewriting it to
 * locate by CONTENT fixes that, and that remains the standing advice.
 */
export function resolvesInNativeBinary(binary: Buffer, text: string, name: string): boolean {
  if (binary.indexOf(name, 0, 'latin1') < 0) return false
  return resolvesInBundle(text, name)
}

/**
 * The header the baseline carries, and the SEED for a file that does not exist.
 *
 * Spelled here and in the shipped file both; a test pins the two together, because
 * {@link writeBaseline} deliberately does not re-emit it on every run and the two
 * copies would otherwise drift apart in a file nobody regenerates for months.
 */
export const BASELINE_HEADER: readonly string[] = [
  '# check-minified-citations baseline — cited names that do NOT resolve in the vendored',
  '# sdk.mjs today. Each one is a citation to REWRITE so it locates its subject by CONTENT',
  '# (a verbatim string the symbol contains) rather than by a name the minifier reassigns.',
  '# This list may only shrink. Regenerate: bun scripts/check-minified-citations.ts --update-baseline',
  '#',
  '# A regeneration PRESERVES this header, every other comment and blank line, and each',
  '# surviving entry with its inline reason VERBATIM. Entries that no longer read stale are',
  '# dropped; new ones are appended under a dated heading with the files that cite them.',
  '# The file list beside an entry is therefore a SNAPSHOT of when it was recorded — the',
  '# live one is printed by the report form of this script (no flag).',
]

/**
 * Rewrite the baseline WITHOUT deleting what a human wrote in it.
 *
 * P6.892, and the shape is W9-bb's repair of the sibling gate (`ae9ffa535`) rather
 * than a second invention. The previous writer composed the whole file from the
 * finding list, so the FIRST run of this script's own documented usage line would
 * have deleted every reason in the register — the one thing in a baseline that a
 * machine cannot re-derive. A register that a regeneration empties is a register
 * nobody can be asked to keep, and the reasons are this file's whole value.
 *
 * Comment and blank lines are kept verbatim, in place. A surviving entry keeps its
 * OWN line, including a reason a human wrote over the generated file list. An entry
 * that no longer reads stale is dropped, because the list may only shrink. New
 * entries are appended under a dated heading.
 */
export function writeBaseline(
  stale: readonly Citation[],
  repoRoot: string = REPO_ROOT,
): { added: number; dropped: number } {
  const file = join(repoRoot, BASELINE_FILE)
  const existing = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [...BASELINE_HEADER]
  const wanted = new Set(stale.map((citation) => citation.name))
  const kept: string[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const line of existing) {
    // The same split as `readBaseline`, so what the writer calls an entry and what
    // the gate calls an entry cannot diverge.
    const entry = line.split('#')[0]?.trim() ?? ''
    if (entry === '') {
      kept.push(line)
      continue
    }
    if (!wanted.has(entry)) {
      dropped += 1
      continue
    }
    kept.push(line)
    seen.add(entry)
  }
  // An EMPTY list must not leave a blank line at EOF — `git diff --check` treats
  // that as whitespace damage, and a gate that dirties the tree it guards is a gate
  // people stop running. Dropping the last entry under a dated heading would leave
  // that heading's separator behind, which is the same defect one line up.
  while (kept.length > 0 && (kept[kept.length - 1] as string).trim() === '') kept.pop()
  const added = stale.filter((citation) => !seen.has(citation.name))
  if (added.length > 0) {
    kept.push(
      '',
      `# recorded ${new Date().toISOString().slice(0, 10)}`,
      ...added.map((citation) => `${citation.name}  # ${citation.files.join(' ')}`),
    )
  }
  writeFileSync(file, `${kept.join('\n')}\n`, 'utf8')
  return { added: added.length, dropped }
}

export function readBaseline(repoRoot: string = REPO_ROOT): Set<string> {
  const path = join(repoRoot, BASELINE_FILE)
  if (!existsSync(path)) return new Set()
  return new Set(
    readFileSync(path, 'utf8').split('\n')
      .map((line) => line.split('#')[0]?.trim() ?? '')
      .filter(Boolean),
  )
}

export interface Report {
  readonly cited: number
  readonly resolved: number
  /** Names `sdk.mjs` does not carry and the native binary does — P3.309 pass 2. */
  readonly resolvedOnlyNatively: number
  /** Whether the binary was available to consult at all. */
  readonly nativeConsulted: boolean
  readonly stale: readonly Citation[]
  readonly newStale: readonly Citation[]
}

export function buildReport(
  bundle: string,
  citations: readonly Citation[],
  baseline: ReadonlySet<string>,
  /**
   * The second haystack. Only names that already failed against `sdk.mjs` reach
   * it, which is what keeps the 1.5 s-per-name regex off the common path. When
   * it is absent (a platform whose binary is not installed) the report says so
   * rather than calling a binary-only symbol stale.
   */
  resolvesNatively?: (name: string) => boolean,
): Report {
  const missedByBundle = citations.filter((citation) => !resolvesInBundle(bundle, citation.name))
  const stale = resolvesNatively === undefined
    ? missedByBundle
    : missedByBundle.filter((citation) => !resolvesNatively(citation.name))
  return {
    cited: citations.length,
    resolved: citations.length - stale.length,
    resolvedOnlyNatively: missedByBundle.length - stale.length,
    nativeConsulted: resolvesNatively !== undefined,
    stale,
    newStale: stale.filter((citation) => !baseline.has(citation.name)),
  }
}

function main(): number {
  const check = process.argv.includes('--check')
  const update = process.argv.includes('--update-baseline')
  const bundlePath = join(REPO_ROOT, BUNDLE)

  if (!existsSync(bundlePath)) {
    console.error(
      `check-minified-citations: REFUSING — ${BUNDLE} is not present, so every citation would read as\n` +
      '  stale and this check would be reporting on its own missing subject. Run `bun install` first.\n' +
      '  Exiting 0 because an uninstalled checkout is not a defect in the tree; it is a checkout.',
    )
    return 0
  }

  const bundle = readFileSync(bundlePath, 'utf8')
  const citations = collectCitations()

  const nativePath = nativeBinaryPath()
  let resolvesNatively: ((name: string) => boolean) | undefined
  if (nativePath !== null) {
    const binary = readFileSync(nativePath)
    const text = binary.toString('latin1')
    resolvesNatively = (name) => resolvesInNativeBinary(binary, text, name)
  }
  const report = buildReport(bundle, citations, readBaseline(), resolvesNatively)

  console.log(
    `check-minified-citations: ${report.cited} short backticked names in files that discuss ${BUNDLE}; ` +
    `${report.resolved} resolve, ${report.stale.length} do not.`,
  )
  if (report.nativeConsulted) {
    console.log(
      `  The native binary was consulted too, and ${report.resolvedOnlyNatively} name(s) resolve ONLY there.`,
    )
    if (report.resolvedOnlyNatively > 0) {
      console.log(
        '  Those are held back from the stale list rather than confirmed: a binary of this size contains most\n' +
        '  short byte sequences by accident (measured: 2-character nonsense resolves 5 of 5, 3-character\n' +
        '  2 of 10), so this can refuse an accusation and cannot support one. See this script\'s header.',
      )
    }
  } else {
    // Not a refusal: `sdk.mjs` is present, so most of this check is still valid.
    // But a symbol that lives ONLY in the binary would read as stale here, and a
    // reader must know that before believing a new entry.
    console.log(
      '  NOTE: no platform binary is installed, so only sdk.mjs was consulted. A citation that names\n' +
      '  a symbol living only in the native binary would read as stale on this machine.',
    )
  }

  // The positive control this checker owes itself, and the exact failure it
  // exists to catch one level down: if the matcher stopped matching, everything
  // reads as stale and the report looks like a catastrophic finding.
  if (report.cited > 0 && report.resolved * 2 < report.cited) {
    console.error(
      `\ncheck-minified-citations: REFUSING — only ${report.resolved} of ${report.cited} cited names resolve.\n` +
      '  A bundle this tree really uses cannot have lost most of its cited symbols at once, so the\n' +
      '  likely fault is in `resolvesInBundle` or in the bundle path, not in the citations. Fix the\n' +
      '  checker before believing its list.',
    )
    return 1
  }

  if (update) {
    const written = writeBaseline(report.stale)
    console.log(
      `check-minified-citations: ${BASELINE_FILE} now holds ${report.stale.length} entr(ies); ` +
      `${written.added} added, ${written.dropped} no longer stale. ` +
      'Existing comments and per-entry reasons were kept.',
    )
    return 0
  }

  if (!check) {
    for (const citation of report.stale) console.log(`  STALE  ${citation.name.padEnd(6)} ${citation.files.join(' ')}`)
    console.log(
      '\n(REPORT, not a gate: this form always exits 0. The gate is `--check`, which fails only on a\n' +
      `stale citation not already in ${BASELINE_FILE}.)`,
    )
    return 0
  }

  if (report.newStale.length === 0) {
    console.log(`  No NEW stale citation. ${report.stale.length} known one(s) remain in ${BASELINE_FILE}. PASS.`)
    return 0
  }

  console.error(`\n  ${report.newStale.length} NEW stale minified citation(s):`)
  for (const citation of report.newStale) console.error(`    ${citation.name.padEnd(6)} ${citation.files.join(' ')}`)
  console.error(
    '\n  Each names a symbol that is NOT in the shipped bundle, so the comment or the instrument\n' +
    '  around it points at nothing. If this followed an SDK bump, the minifier reassigned the name:\n' +
    '  rewrite the citation to locate its subject by CONTENT — a verbatim string the symbol contains —\n' +
    '  which survives the next bump. If the citation is prose about something else entirely, record it\n' +
    `  with --update-baseline and say so in the commit message.`,
  )
  return 1
}

if (import.meta.main) process.exit(main())
