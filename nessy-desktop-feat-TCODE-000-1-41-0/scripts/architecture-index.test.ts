/**
 * UB10.3 — the architecture index keeps its own promise.
 *
 * `docs/README.md` says "All <N> files under `architecture/` are listed here. If
 * you add one, add it here too — an unlisted architecture record is one nobody
 * finds." Until this file that sentence was prose: a record added without its
 * README line, or a count left at the old number, stayed green. Two arms make it
 * a test:
 *
 *   * every `docs/architecture/*.md` is named in the README's `## Architecture`
 *     section as `` `architecture/<name>.md` ``, and the spelled count matches;
 *   * the decision-layer record (UB10.3's own) cites only repo paths that exist,
 *     so a moved module turns the record red instead of quietly wrong.
 *
 * Each arm runs its function once over the real tree (positive) and once over a
 * mutated copy of the text (negative), so neither can pass vacuously. Read from
 * disk on purpose, like `docs-integrity.test.ts`: the promise is about the files a
 * reader finds next to the README.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const README = readFileSync(join(REPO, 'docs/README.md'), 'utf8')
const ARCH_DIR = join(REPO, 'docs/architecture')
const RECORD_PATH = 'docs/architecture/decision-layer.md'

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23,
  'twenty-four': 24, 'twenty-five': 25,
}

/** The README's `## Architecture` section, up to the next `## ` heading. */
function architectureSection(readme: string): string {
  const start = readme.indexOf('\n## Architecture\n')
  if (start < 0) throw new Error('docs/README.md has no "## Architecture" section')
  const next = readme.indexOf('\n## ', start + 1)
  return readme.slice(start, next < 0 ? undefined : next)
}

/** Records the section does not name as `` `architecture/<name>` ``. */
function unlistedRecords(section: string, names: readonly string[]): string[] {
  return names.filter(name => !section.includes(`\`architecture/${name}\``))
}

/** The number the section spells in "All <N> files under `architecture/`", or null. */
function spelledCount(section: string): number | null {
  const match = section.replace(/\s+/g, ' ').match(/All ([a-z-]+|\d+) files under `architecture\/`/i)
  if (!match) return null
  const word = match[1]!.toLowerCase()
  return /^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word] ?? null)
}

/**
 * Repo paths a record cites in backticks that do not exist. A full path is read from
 * the repo root; a bare `<name>.md` is read as a sibling record in `docs/architecture/`.
 */
function missingCitations(record: string): { checked: number; missing: string[] } {
  const tokens = [...record.matchAll(/`([^`\s]+)`/g)].map(m => m[1]!)
  const paths = tokens.filter(token =>
    /^(?:packages|apps|scripts|docs)\/[\w./-]+\.(?:ts|tsx|md|json)$/.test(token) || /^[\w-]+\.md$/.test(token))
  const unique = [...new Set(paths)]
  const missing = unique.filter(path => !existsSync(path.includes('/') ? join(REPO, path) : join(ARCH_DIR, path)))
  return { checked: unique.length, missing }
}

const records = readdirSync(ARCH_DIR).filter(name => name.endsWith('.md')).sort()
const section = architectureSection(README)

describe('docs/README.md lists every architecture record', () => {
  it('finds architecture records to check at all', () => {
    // Positive control: an empty directory read would make the next arm vacuous.
    expect(records.length).toBeGreaterThan(10)
    expect(records).toContain('decision-layer.md')
  })

  it('positive: names every record and spells their number', () => {
    expect(unlistedRecords(section, records)).toEqual([])
    expect(spelledCount(section)).toBe(records.length)
  })

  it('negative (control): a record whose line is removed is reported, and an old count is caught', () => {
    const withoutEntry = section.replace('`architecture/decision-layer.md`', '`architecture/(removed).md`')
    expect(unlistedRecords(withoutEntry, records)).toEqual(['decision-layer.md'])
    const oldCount = section.replace(/All [a-z-]+ files under/i, 'All thirteen files under')
    expect(spelledCount(oldCount)).toBe(13)
    expect(spelledCount(oldCount)).not.toBe(records.length)
  })
})

describe('the decision-layer record cites only paths that exist', () => {
  const record = readFileSync(join(REPO, RECORD_PATH), 'utf8')

  it('positive: every cited repo path resolves', () => {
    const { checked, missing } = missingCitations(record)
    // The record cites dozens of files; a regex that matched nothing would pass vacuously.
    expect(checked).toBeGreaterThan(20)
    expect(missing).toEqual([])
  })

  it('negative (control): a moved module is reported by name', () => {
    const moved = record.replace(
      '`packages/server-core/src/decisions/decision-point.ts`',
      '`packages/server-core/src/decisions/decision-point-moved.ts`',
    )
    expect(moved).not.toBe(record)
    expect(missingCitations(moved).missing).toEqual(['packages/server-core/src/decisions/decision-point-moved.ts'])
  })
})
