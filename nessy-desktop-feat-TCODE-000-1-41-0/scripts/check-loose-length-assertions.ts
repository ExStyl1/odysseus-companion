#!/usr/bin/env bun
/**
 * P2.187 / P2.387 — the `toHaveLength` arm of the loose-assertion sweep, as a
 * SCRIPT rather than as a gate, and the difference is the whole point.
 *
 * `toHaveLength(3)` under a test name promising *which* three is an assertion
 * that cannot see what it claims: the array can hold the wrong three elements
 * and the case passes. That is the same shape as an `expect` nested inside its
 * own condition (`check-conditional-expect.ts`), except that length and
 * containment are FREQUENTLY the correct assertion — which is why this ships
 * with no gate attached.
 *
 * ## Why it is report-only, stated so nobody "finishes" it into a gate
 *
 * Measured precision on the identity-ranked candidates: **1 real defect per 6
 * read in full** (P2.187, z-w5), and this lane read five more at HEAD and found
 * five sound. A gate at that precision fires five false alarms per finding, and
 * a gate that cries wolf is a gate people switch off — this repo has already
 * retired one detector for exactly that (`.toContain`, 243 findings dominated by
 * source-text assertions where `toContain` is the right matcher; deleted rather
 * than tuned, and it is not to be rebuilt).
 *
 * ## What it exists for instead
 *
 * The row's numbers went stale by 3x while three documents repeated them (600
 * and 2 430 against a measured 2 026 and 6 116), and every lane that touched the
 * row re-derived the population from scratch. This makes the population a
 * command instead of a sentence. Run it, read the ranked list, hand-read the top
 * of it, and admit nothing as a finding without a surviving-mutant demonstration
 * — that discipline is what made `P2.167` trustworthy and no scanner replaces it.
 *
 * ## The mode NO regex reaches, and it is not a bug in this file
 *
 * Identity established by CONSTRUCTION upstream: when the `.filter()` predicate
 * that built the array IS the identity being asserted, the length is a tautology
 * no textual rule can see. Measured and left; a human decides those.
 *
 * Usage: bun scripts/check-loose-length-assertions.ts [--all] [--json]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')

/** A test name that promises an identity or a completeness the length cannot see. */
const IDENTITY_PROMISE =
  /\b(which|only|exactly|just|every|all|both|named|in order|no more|nothing else|and nothing|the two|the three|the four|the five|precisely)\b/i

const TEST_TITLE = /\b(?:it|test)(?:\.\w+)?\s*\(\s*[`'"](.+?)[`'"]/gs
const LENGTH_CALL = /expect\(\s*([^)]{0,120}?)\s*\)\s*\.toHaveLength\(\s*(\d+)\s*\)/g
/** Matchers that read CONTENT — their presence on the same subject settles identity. */
const CONTENT_MATCHER = /^(toEqual|toStrictEqual|toContain|toContainEqual|toMatchObject|toMatchInlineSnapshot|toMatchSnapshot|toBe)$/

export interface LengthCandidate {
  readonly file: string
  readonly line: number
  readonly length: number
  readonly subject: string
  readonly title: string
  /** The title promises an identity the length cannot check. */
  readonly identityRanked: boolean
}

export interface LengthCensus {
  /** Every `toHaveLength(n)` with n > 0 — the denominator. */
  readonly scanned: number
  /** Those with no content assertion on the same subject in the same block. */
  readonly candidates: readonly LengthCandidate[]
  /** The subset whose test name promises an identity — the only list worth reading. */
  readonly identityRanked: readonly LengthCandidate[]
}

export function testFiles(): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files'], { cwd: REPO, stdout: 'pipe' }).stdout.toString()
  return listed.split('\n').filter(path => /\.(test|spec)\.tsx?$/.test(path))
}

export function censusFile(file: string, source: string): LengthCandidate[] {
  const titles = [...source.matchAll(new RegExp(TEST_TITLE))].map(match => ({ at: match.index, title: match[1] ?? '' }))
  const found: LengthCandidate[] = []
  for (const call of source.matchAll(new RegExp(LENGTH_CALL))) {
    const length = Number(call[2])
    // Zero is an emptiness claim, not an identity one: there is nothing the
    // assertion could be failing to look at.
    if (length === 0) continue
    const at = call.index
    let title = ''
    let titleAt = 0
    for (const entry of titles) {
      if (entry.at < at) { title = entry.title; titleAt = entry.at } else break
    }
    if (title.length === 0) continue
    const nextTitle = titles.find(entry => entry.at > titleAt)?.at ?? Math.min(source.length, titleAt + 8000)
    const block = source.slice(titleAt, nextTitle)
    const subject = (call[1] ?? '').trim()
    const base = /^[A-Za-z_$][\w$]*/.exec(subject)?.[0] ?? subject
    // Read BACKWARDS from each content matcher to the nearest `expect(`, rather
    // than forwards through a `[^)]` subject class: the subject frequently
    // contains parentheses (`expect(sources.map(s => s.id)).toEqual(…)`), and a
    // forward class that cannot cross a `)` simply fails to match, which turns a
    // sound test into a candidate. Measured on the fixture in this file's reader.
    let contentAsserted = false
    for (const matcher of block.matchAll(/\)\s*\.\s*(\w+)\s*\(/g)) {
      if (!CONTENT_MATCHER.test(matcher[1] ?? '')) continue
      const before = block.slice(Math.max(0, matcher.index - 300), matcher.index)
      const expectAt = before.lastIndexOf('expect(')
      if (expectAt < 0) continue
      if (base.length > 0 && before.slice(expectAt).includes(base)) { contentAsserted = true; break }
    }
    if (contentAsserted) continue
    found.push({
      file,
      line: source.slice(0, at).split('\n').length,
      length,
      subject,
      title: title.replace(/\s+/g, ' ').slice(0, 120),
      identityRanked: IDENTITY_PROMISE.test(title),
    })
  }
  return found
}

export function census(files: readonly string[] = testFiles()): LengthCensus {
  let scanned = 0
  const candidates: LengthCandidate[] = []
  for (const file of files) {
    let source: string
    try { source = readFileSync(resolve(REPO, file), 'utf8') } catch { continue }
    for (const call of source.matchAll(new RegExp(LENGTH_CALL))) if (Number(call[2]) > 0) scanned += 1
    candidates.push(...censusFile(file, source))
  }
  return { scanned, candidates, identityRanked: candidates.filter(entry => entry.identityRanked) }
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const all = process.argv.includes('--all')
  const result = census()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(all ? result.candidates : result.identityRanked, null, 1))
  } else {
    for (const entry of (all ? result.candidates : result.identityRanked)) {
      console.log(`${entry.file}:${entry.line}  toHaveLength(${entry.length}) on ${entry.subject}`)
      console.log(`    ${entry.title}`)
    }
  }
  console.log(
    `\nloose length assertions: ${result.scanned} \`toHaveLength(n>0)\` call sites; `
    + `${result.candidates.length} with no content assertion on the same subject in the same block; `
    + `${result.identityRanked.length} of those under a name promising an identity. `
    + 'REPORT ONLY — measured precision is about 1 real defect per 6 read in full, so this is a '
    + 'reading list, not a verdict. Read the top of it, and admit nothing without a surviving mutant.',
  )
  // Deliberately 0: this is a census, and a census that can fail a build is a gate.
  process.exit(0)
}
