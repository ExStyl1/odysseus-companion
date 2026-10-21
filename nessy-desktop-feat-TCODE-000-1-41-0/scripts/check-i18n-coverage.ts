#!/usr/bin/env bun
/**
 * check-i18n-coverage.ts — every literal `t('...')` key a product file asks for
 * exists in `en.json`.
 *
 * Copied and adapted from upstream craft-agents-oss `v0.13.4:scripts/check-i18n-coverage.ts`
 * (Apache-2.0) by UA1.11, 2026-10-02. Upstream's purpose, unchanged: catch the
 * failure the locale parity check cannot — a merge resolution that drops a key
 * from BOTH locales symmetrically, a manual `en.json` edit that misses a
 * referenced key, a renamed key with a straggler in source. Its two neighbours
 * keep their jobs: `lint:i18n:parity` (locales agree with `en.json`) and
 * `lint:i18n:sorted` (each locale is sorted); our `lint:i18n:reachable` is the
 * reverse direction of this one (a key no reader reaches).
 *
 * What is kept from upstream, as written there:
 *   - the three reference forms ({@link KEY_PATTERNS}): a bare `t('k')`,
 *     `i18n.t('k')` / `i18next.t('k')`, and the `<Trans i18nKey="k">` prop;
 *   - the exclusions: `__tests__`, `playground`, `registry` (plus
 *     `node_modules`, `dist`, `build`) as path segments, and `*.test.ts(x)`,
 *     `*.spec.ts(x)`, `*.d.ts` files;
 *   - the plural rule: a reference to `k` is satisfied by `k` itself or by BOTH
 *     `k_one` and `k_other` (i18next appends the suffix at call time);
 *   - dynamic keys (a template literal, a variable) are skipped silently —
 *     they surface as i18next's runtime missing-key warnings;
 *   - `--all` prints every missing key (the default truncates to 20).
 *
 * What is adapted, and why:
 *   - **Roots.** Ours are {@link SCAN_ROOTS}. The two dormant apps
 *     (`apps/viewer`, `apps/webui`) are kept because they DO carry literal
 *     `t(` calls (viewer: `App.tsx`, `components/Header.tsx`; webui: `App.tsx`,
 *     `main.tsx` — read 2026-10-02), and a dormant reader of a missing key
 *     is still a missing key the day it wakes.
 *   - **Enumeration and reads (waves.md O5).** Upstream walks the filesystem
 *     with `readdirSync`/`readFileSync`. On this rig a `lint:chain` gate that
 *     OPENS its corpus costs minutes (AGENTS.md, measured 2026-09-18), and on
 *     CI a filesystem walk meets the runner caches kept inside the checkout.
 *     So this enumerates with `git ls-files` (tracked files only, never a
 *     cache) and reads through `check-comment-globs.ts`'s `loadSourceTexts`:
 *     a CLEAN file as its index blob through one `git cat-file --batch`, only
 *     the files `git status` names from disk, a pending deletion skipped by
 *     name. `en.json` is the one file opened directly.
 *   - **Comments are not readers.** A key quoted in a docblock is prose, not a
 *     call; this tree quotes exact tokens verbatim as house style, and the first
 *     run over it (2026-10-02) reported `task-output.ts`'s docblock quoting a
 *     `t('chat.noOutputYet')` call that no longer exists as a missing key. A
 *     match inside a comment span (`ts-comment-scan.ts`, the scanner
 *     `lint:i18n:reachable` uses for the same reason) is skipped.
 *   - **A named baseline ({@link KNOWN_MISSING}).** The tree this landed on had
 *     ONE missing literal key; the gate lands green with it recorded, never red
 *     on arrival, and fails on drift in BOTH directions — a new missing key, and
 *     a recorded one that resolves or loses its reader (a stale record).
 *   - **Line numbers** come from a newline index instead of a slice per match.
 *   - **The remedy text** names our locale gates rather than upstream's skill.
 *
 * Exit 0 when every reference resolves; 1 with a diagnostic naming each
 * missing key's first `file:line`; 2 when the run would be vacuous (no files,
 * no `en.json` keys).
 *
 * Usage:
 *   bun scripts/check-i18n-coverage.ts          # check (the lint:chain step)
 *   bun scripts/check-i18n-coverage.ts --all    # print every missing key
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadSourceTexts } from './check-comment-globs'
import { GateSafetyRefusal } from './gate-safety'
import { scanSpans } from './ts-comment-scan'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const EN_PATH = 'packages/shared/src/i18n/locales/en.json'

/** The trees scanned for readers — upstream's five, which are also ours. */
export const SCAN_ROOTS: readonly string[] = [
  'apps/electron/src',
  'apps/viewer/src',
  'apps/webui/src',
  'packages/shared/src',
  'packages/ui/src',
]

const EXCLUDE_DIR_NAMES = new Set(['node_modules', 'dist', 'build', '__tests__', 'playground', 'registry'])
const EXCLUDE_FILE_PATTERNS = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /\.d\.ts$/]
const SOURCE_EXT = /\.(?:ts|tsx)$/

/**
 * Missing keys recorded on the day the gate landed (UA1.11, 2026-10-02), each
 * with the reader that asks for it and why it is not fixed here. Every entry
 * must still be missing AND still be read, or the run fails as stale.
 *
 * Empty since UA12.10 (2026-10-04): the single recorded entry, `common.select`
 * (ServerDirectoryBrowser's confirm button), resolved when the key landed in
 * en+ru, and a stale-entry run went red on it before the entry dropped.
 */
export const KNOWN_MISSING: ReadonlyMap<string, string> = new Map([])

export interface Reference {
  readonly file: string
  readonly line: number
  readonly key: string
}

/** Upstream's three reference forms, verbatim. */
const KEY_PATTERNS: readonly RegExp[] = [
  // t('key') / t("key") — bare call. The lookbehind skips `.t(` (handled
  // below) and identifiers ending in t (`cat(`).
  /(?<![A-Za-z0-9_$.])t\(\s*(['"])([^'"`\\\n]+)\1/g,
  // i18n.t('key') / i18next.t('key')
  /\bi18n(?:ext)?\.t\(\s*(['"])([^'"`\\\n]+)\1/g,
  // <Trans i18nKey="key" /> — JSX prop
  /\bi18nKey\s*=\s*(['"])([^'"`\\\n]+)\1/g,
]

/** Is this repo-relative path one the gate reads? Upstream's exclusions, applied to path segments. */
export function isScannedPath(path: string): boolean {
  if (!SCAN_ROOTS.some((root) => path.startsWith(`${root}/`))) return false
  const segments = path.split('/')
  const name = segments[segments.length - 1]!
  if (segments.slice(0, -1).some((segment) => EXCLUDE_DIR_NAMES.has(segment))) return false
  if (!SOURCE_EXT.test(name)) return false
  return !EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

/** Every literal key reference in one file's text, with its 1-based line. */
export function extractRefs(file: string, content: string): Reference[] {
  const lineStarts = [0]
  for (let i = content.indexOf('\n'); i >= 0; i = content.indexOf('\n', i + 1)) lineStarts.push(i + 1)
  const lineOf = (offset: number): number => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  let comments: Array<{ start: number; end: number }> | undefined
  const inComment = (offset: number): boolean => {
    comments ??= scanSpans(content).filter((span) => span.kind === 'line-comment' || span.kind === 'block-comment')
    return comments.some((span) => span.start <= offset && offset < span.end)
  }
  const refs: Reference[] = []
  for (const pattern of KEY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      const key = match[2]
      if (key && !inComment(match.index)) refs.push({ file, line: lineOf(match.index), key })
    }
  }
  return refs
}

/** Upstream's plural-aware resolution: the key itself, or both `_one` and `_other`. */
export function isResolved(key: string, enKeys: ReadonlySet<string>): boolean {
  if (enKeys.has(key)) return true
  return enKeys.has(`${key}_one`) && enKeys.has(`${key}_other`)
}

export interface CoverageResult {
  readonly totalRefs: number
  /** The FIRST reference of each missing key, in scan order — baseline entries included. */
  readonly missing: readonly Reference[]
}

export interface BaselineVerdict {
  /** Missing and not recorded: the gate's red. */
  readonly fresh: readonly Reference[]
  /** Recorded, and no longer a missing key any reader asks for: a stale record, also red. */
  readonly stale: readonly string[]
}

/** Split a run's missing keys against the recorded baseline. */
export function compareToBaseline(
  missing: readonly Reference[],
  baseline: ReadonlyMap<string, string> = KNOWN_MISSING,
): BaselineVerdict {
  const missingKeys = new Set(missing.map((ref) => ref.key))
  return {
    fresh: missing.filter((ref) => !baseline.has(ref.key)),
    stale: [...baseline.keys()].filter((key) => !missingKeys.has(key)),
  }
}

/** The whole check over already-loaded texts — pure, so the test drives it without git. */
export function findMissing(texts: ReadonlyMap<string, string>, enKeys: ReadonlySet<string>): CoverageResult {
  const firstByKey = new Map<string, Reference>()
  let totalRefs = 0
  for (const [file, content] of texts) {
    const refs = extractRefs(file, content)
    totalRefs += refs.length
    for (const ref of refs) {
      if (!isResolved(ref.key, enKeys) && !firstByKey.has(ref.key)) firstByKey.set(ref.key, ref)
    }
  }
  return { totalRefs, missing: [...firstByKey.values()] }
}

/** The diagnostic lines for a failed run: `file:line` then the key, one block per missing key. */
export function formatMissing(missing: readonly Reference[], showAll: boolean, stale: readonly string[] = []): string[] {
  const limit = showAll ? missing.length : Math.min(20, missing.length)
  const lines = [`i18n coverage check failed: ${missing.length} missing key(s), ${stale.length} stale baseline entr(ies)`, '']
  for (const ref of missing.slice(0, limit)) lines.push(`${ref.file}:${ref.line}`, `  → ${ref.key}`, '')
  if (missing.length > limit) lines.push(`… (truncated to the first ${limit}; run with --all to see all)`, '')
  for (const key of stale) {
    lines.push(`stale KNOWN_MISSING entry: ${key} — it resolves now, or nothing reads it; delete the entry`, '')
  }
  lines.push(
    `Fix: add the missing keys to ${EN_PATH} and every other locale (flat, sorted,`,
    '     written as characters), then run `bun run lint:i18n:parity` and `bun run lint:i18n:sorted`.',
  )
  return lines
}

/** The tracked files under {@link SCAN_ROOTS} the gate reads. */
export function scannedFiles(root: string = REPO_ROOT): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_ROOTS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter((path) => path !== '' && isScannedPath(path))
}

async function main(argv: readonly string[]): Promise<number> {
  const enKeys = new Set(Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, EN_PATH), 'utf-8')) as Record<string, string>))
  const files = scannedFiles()
  if (files.length === 0 || enKeys.size === 0) {
    throw new GateSafetyRefusal(
      `REFUSED: ${files.length} source file(s) and ${enKeys.size} en key(s) — the run would be vacuous.`,
    )
  }
  const loaded = await loadSourceTexts(files)
  for (const file of loaded.skipped) {
    console.log(`  skipped (deleted in the working tree, still in the index): ${file}`)
  }
  const { totalRefs, missing } = findMissing(loaded.texts, enKeys)
  const { fresh, stale } = compareToBaseline(missing)
  if (fresh.length === 0 && stale.length === 0) {
    const recorded = missing.map((ref) => `${ref.key} at ${ref.file}:${ref.line}`).join(', ') || 'none'
    console.log(
      `i18n coverage OK (${totalRefs} references across ${loaded.texts.size} files, ${enKeys.size} en keys; ` +
        `${missing.length} recorded in KNOWN_MISSING: ${recorded})`,
    )
    return 0
  }
  for (const line of formatMissing(fresh, argv.includes('--all'), stale)) console.error(line)
  return 1
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
