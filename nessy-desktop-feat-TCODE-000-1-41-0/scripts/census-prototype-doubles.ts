/**
 * census-prototype-doubles — the `Object.create(SessionManager.prototype)`
 * worklist, counted the way it has to be counted.
 *
 * D1.274.
 *
 * ## Why a script for a grep
 *
 * D1.109's worklist is a literal grep, and a comment saying what a conversion
 * REPLACED is counted by it as a site. So the number moved the WRONG WAY while
 * the population fell (WI-y, 2026-09-18, measured over one corpus three ways):
 *
 * | reading | total | CODE sites | files | comment mentions |
 * | --- | ---: | ---: | ---: | ---: |
 * | `b377320e6` | 50 | 46 | 36 | 4 |
 * | `20512b4d9`, after NINE conversions | **51** | **38** | 28 | 13 |
 * | after `309f72a29` rewrote the comments in words | 39 | 39 | 29 | 0 |
 *
 * A lane reading the naive census after those nine conversions would have
 * concluded the row went backwards. It is AGENTS.md's own rule about a
 * correction that spells the dead anchor, one corpus over.
 *
 * The comments are fixed and the two readings agree today, which is exactly why
 * this exists: the next conversion comment re-creates the divergence, and a
 * number quoted without its instrument cannot be re-derived. Run this and quote
 * what it prints, with the date.
 *
 * ## What it is NOT
 *
 * Not a ratchet. The population is meant to fall as D1.242 converts files, and a
 * pin here would go red on every conversion — the opposite of the point. It
 * prints; the reader decides.
 */
import { execFileSync } from 'node:child_process'

const NEEDLE = 'Object.create(SessionManager.prototype)'
/** Source only. A plan or a spec mentioning the phrase is prose, not a site. */
const PATHSPEC = ['packages', 'apps'] as const

export interface DoubleCensus {
  /** Every matching line, `path:line: text`. */
  lines: string[]
  /** Lines whose content begins a comment — the ones the naive census miscounts. */
  commentLines: string[]
  /** The number a worklist means: matches that are code. */
  codeSites: number
  /** Distinct files carrying at least one CODE site. */
  codeFiles: number
}

/** True when the matched line is a comment rather than a site. */
export function isCommentLine(text: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(text)
}

export function census(root?: string): DoubleCensus {
  let output = ''
  try {
    output = execFileSync('git', ['grep', '-nI', '-F', NEEDLE, '--', ...PATHSPEC], {
      cwd: root ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    // `git grep` exits 1 on no match, which is a reading and not an error.
    const status = (error as { status?: number }).status
    if (status !== 1) throw error
  }
  const lines = output.split('\n').filter(line => line.length > 0)
  const commentLines: string[] = []
  const codeFiles = new Set<string>()
  let codeSites = 0
  for (const line of lines) {
    const match = /^([^:]+):(\d+):(.*)$/.exec(line)
    if (!match) continue
    if (isCommentLine(match[3] as string)) {
      commentLines.push(line)
      continue
    }
    codeSites += 1
    codeFiles.add(match[1] as string)
  }
  return { lines, commentLines, codeSites, codeFiles: codeFiles.size }
}

if (import.meta.main) {
  const result = census()
  console.log(
    `census-prototype-doubles: ${result.lines.length} matching line(s); `
    + `${result.codeSites} CODE site(s) across ${result.codeFiles} file(s); `
    + `${result.commentLines.length} comment mention(s).`,
  )
  if (result.commentLines.length > 0) {
    console.log('  The comment mentions the naive census counts as sites:')
    for (const line of result.commentLines) console.log(`    ${line}`)
    console.log(
      '  Quote the CODE number, or rewrite the comment in words as `309f72a29` did.',
    )
  }
  if (result.lines.length === 0) {
    console.log('  Zero matches. Either the worklist is finished or the needle moved — check by hand.')
  }
}
