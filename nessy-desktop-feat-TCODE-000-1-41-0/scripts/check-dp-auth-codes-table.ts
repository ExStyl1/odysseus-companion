#!/usr/bin/env bun
/**
 * check-dp-auth-codes-table — the sign-in-codes table (DA1.18) and
 * `DpAuthError` cannot drift apart without this saying so.
 *
 * DA1.20, born 2026-09-13 from WA-e (DA1.18).
 *
 * ## The defect it exists for
 *
 * Both locale copies of `docs-site/content/…/reference/config/credentials.md`
 * carry a table with one row per member of the `DpAuthError` enum, and both say
 * so in their own prose: *"There is one row here for every member of
 * `DpAuthError` in `packages/shared/src/auth/dp/errors.ts`, which is where the
 * codes are defined — if you meet a code that is not in this table, the table is
 * the thing that is out of date."* That promise had nothing behind it. A member
 * added to the enum leaves the user meeting a code the page swears is
 * impossible, in two languages, and nothing fails.
 *
 * ## How it finds the table — by the page's OWN anchor, not by a heading
 *
 * The section heading is translated (`Sign-in failure codes` / `Коды ошибок
 * входа`) and a heading is exactly the kind of thing an editor rewrites. The
 * SOURCE PATH in the paragraph above the table is not: it is the same string in
 * both languages, it is the page's own statement of where the codes come from,
 * and a page that stops naming its source has broken the contract this gate
 * checks anyway. So the anchor is {@link SOURCE_ANCHOR}, and a page that does
 * not contain it is a REFUSAL rather than a pass.
 *
 * ## A code cell is a BACKTICKED identifier, and the backticks are load-bearing
 *
 * The obvious rule — "a cell that looks like an identifier is a code" — reads the
 * ENGLISH page's own header cell, which is the word `Code`, as a code named
 * `Code`, and then reports it as an invented one. (The Russian header says `Код`
 * and would be skipped by accident, so the bug would have presented as one
 * finding in one language: the shape that reads as a translation problem.)
 * Measured 2026-09-17 on the draft of this script. Both pages write every real
 * code inside backticks and neither writes its header that way, so requiring the
 * backticks skips the header BY THE SHAPE OF WHAT IT HOLDS — never by its
 * position, which is what a page that gains a column would break.
 *
 * ## What it checks, stated so nobody assumes more
 *
 *  1. **Every enum member has a row**, in BOTH locale copies.
 *  2. **Every row names an enum member** — a code the page invents, or one left
 *     behind by a rename, is the same defect seen from the other side.
 *  3. **No member has two rows** in one page.
 *
 * It does NOT check the message text, the translation, or that the row says
 * anything true. It reads the CODE cell and nothing else, deliberately: a gate
 * that graded prose would be a gate nobody could keep green.
 *
 * Usage:
 *   bun scripts/check-dp-auth-codes-table.ts            # report, always exit 0
 *   bun scripts/check-dp-auth-codes-table.ts --check    # the gate: exit 1 on any finding
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The enum this gate reads its truth from. */
export const ERRORS_MODULE = 'packages/shared/src/auth/dp/errors.ts'

/** Both locale copies of the page that promises one row per member. */
export const CODE_PAGES: readonly string[] = [
  'docs-site/content/reference/config/credentials.md',
  'docs-site/content/ru/reference/config/credentials.md',
]

/**
 * The page's own anchor for the table — the module path it cites, which is the
 * one part of the paragraph that is not translated and not rewritable without
 * breaking the promise this gate checks.
 */
export const SOURCE_ANCHOR = ERRORS_MODULE

/** The cell separator, spelled as every other table gate in this tree spells it. */
export const SPLIT_CELLS = /(?<!\\)\|/

/** The Code column, by index into the split (`['', message, code, meaning, '']`). */
export const CODE_COLUMN = 2

/** A code cell: a backticked identifier and nothing else. See the docblock. */
export const CODE_CELL = /^`([A-Za-z_][A-Za-z0-9_]*)`$/

/**
 * Every member NAME of `enum DpAuthError`, in declaration order.
 *
 * The body ends at the first `}` that OPENS A LINE, and comments are stripped
 * before members are read. Measured 2026-09-19: the first version ended the
 * body at the first `}` anywhere, and a member docblock carrying `{@link X}`
 * (DA1.78, `ffe7c3176`) closed it early — the reader then saw 6 of 10 members
 * and reported the three documented codes after the docblock as "invented",
 * which is the one finding this gate exists to make and it was pointed at the
 * correct page. A reader a comment can silence is pinned against in
 * `check-dp-auth-codes-table.test.ts`.
 */
export function enumMembers(source: string): string[] {
  const body = /export enum DpAuthError\s*\{([\s\S]*?)^\}/m.exec(source)?.[1]
  if (body === undefined) return []
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  return [...code.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(match => match[1] as string)
}

/** The codes a page's table lists, in order, backticks stripped. */
export function tableCodes(page: string): string[] {
  const lines = page.split('\n')
  const anchor = lines.findIndex(line => line.includes(SOURCE_ANCHOR))
  if (anchor < 0) return []
  const codes: string[] = []
  let inTable = false
  for (let index = anchor; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (!line.startsWith('|')) {
      if (inTable) break
      continue
    }
    inTable = true
    const cells = line.split(SPLIT_CELLS).map(cell => cell.trim())
    const cell = cells[CODE_COLUMN]
    if (cell === undefined) continue
    const code = CODE_CELL.exec(cell)?.[1]
    if (code === undefined) continue
    codes.push(code)
  }
  return codes
}

export interface CodeFinding {
  readonly page: string
  readonly kind: 'missing' | 'unknown' | 'duplicate'
  readonly code: string
}

export function auditPage(page: string, text: string, members: readonly string[]): CodeFinding[] {
  const codes = tableCodes(text)
  const findings: CodeFinding[] = []
  const seen = new Set<string>()
  for (const code of codes) {
    if (!members.includes(code)) findings.push({ page, kind: 'unknown', code })
    else if (seen.has(code)) findings.push({ page, kind: 'duplicate', code })
    seen.add(code)
  }
  for (const member of members) {
    if (!seen.has(member)) findings.push({ page, kind: 'missing', code: member })
  }
  return findings
}

const EXPLANATION: Record<CodeFinding['kind'], string> = {
  missing: 'is a member of `DpAuthError` with no row in this table — a user can meet this code, and the page says they cannot',
  duplicate: 'has two rows in this table — one code, one row, or a reader cannot tell which row is the live one',
  unknown: 'is a row in this table naming no member of `DpAuthError` — an invented code, or one a rename left behind',
}

export function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const errorsFile = join(REPO_ROOT, ERRORS_MODULE)
  if (!existsSync(errorsFile)) {
    throw new GateSafetyRefusal(`REFUSED: ${ERRORS_MODULE} is missing — a pass here would mean nothing was read.`)
  }
  const members = enumMembers(readFileSync(errorsFile, 'utf-8'))
  if (members.length === 0) {
    throw new GateSafetyRefusal(
      `REFUSED: no members parsed out of \`DpAuthError\` in ${ERRORS_MODULE} — the matcher is broken, not the enum, `
      + 'and a green run here would report that nothing is wrong with a list nothing was read from.',
    )
  }

  const findings: CodeFinding[] = []
  for (const page of CODE_PAGES) {
    const file = join(REPO_ROOT, page)
    if (!existsSync(file)) {
      throw new GateSafetyRefusal(`REFUSED: ${page} is missing — this gate checks BOTH locale copies or neither.`)
    }
    const text = readFileSync(file, 'utf-8')
    if (!text.includes(SOURCE_ANCHOR)) {
      throw new GateSafetyRefusal(
        `REFUSED: ${page} does not cite ${SOURCE_ANCHOR}, which is the anchor this gate finds the table by. `
        + 'The page also stops promising one row per member when it stops citing its source, so this is a finding '
        + 'about the page and not about the gate — restore the citation, or move this anchor deliberately.',
      )
    }
    if (tableCodes(text).length === 0) {
      throw new GateSafetyRefusal(
        `REFUSED: ${page} yielded no code rows after ${SOURCE_ANCHOR} — the table moved, or the matcher is broken.`,
      )
    }
    findings.push(...auditPage(page, text, members))
  }

  for (const finding of findings) {
    console.log(`${finding.page}  \`${finding.code}\` ${EXPLANATION[finding.kind]}.`)
  }
  console.log(
    `check-dp-auth-codes-table: ${findings.length} finding(s) over ${members.length} \`DpAuthError\` member(s) `
    + `and ${CODE_PAGES.length} locale copies of the sign-in-codes table.`,
  )
  return check && findings.length > 0 ? 1 : 0
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
