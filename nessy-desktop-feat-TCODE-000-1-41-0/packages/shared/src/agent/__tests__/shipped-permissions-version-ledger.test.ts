/**
 * F1.291 (origin WJ-dd's F1.258 verifier, F1.258-rec; carries F1.290's "guard"
 * clause) — nothing stopped the next P2.207.
 *
 * ## The hole
 *
 * `ensureDefaultPermissions` (`permissions-config.ts`) merges a bundled
 * `default.json` into an installed one only when the bundle's `version` is newer,
 * and the merge APPENDS: a shipped allow string that a later bundle tightens stays
 * in the installed copy unless `RETIRED_SHIPPED_PATTERNS` names it, and the
 * allow-list is a union, so the loose one wins. Two ways to reopen that hole, each
 * with every gate green before this file:
 *
 * - change the file's lists (or the retirement table) and leave `version` alone —
 *   P2.207 (`64c6a8391`) anchored nineteen bash strings under the unchanged
 *   `2026-07-06`, and `e6296c0f7` added two `deniedPaths` under the unchanged
 *   `2026-09-06`, so an install already at that version never received them (no
 *   release carried the gap: 1.34.0 shipped 2026-09-04, 1.35.0 2026-09-10);
 * - remove or tighten an allow string with no retirement entry, or key the entry
 *   to a bundle that had already shipped without it — `a72dc2456` keyed the 39
 *   bash retirements to `2026-09-23`, which `f4a545cca` had shipped twelve minutes
 *   earlier (F1.290).
 *
 * ## The guard
 *
 * `LEDGER` is every bundle version the file shipped, in order, with the
 * retirement entries that bundle carried (`<field>@<version>`); only the last one
 * carries a content hash, because only the current file can be re-hashed. Four
 * rules, each the refusal of one of the shapes above:
 *
 * 1. the last entry is the current `version`, and the hash of what the migration
 *    reads (every list's strings and the retirement table) equals its pinned
 *    hash — a content change with no `version` bump is red here;
 * 2. versions strictly increase under the migration's own comparison (plain
 *    string `<`: `2026-09-23.10` would sort BEFORE `2026-09-23.9`, and this rule
 *    says so the day it happens);
 * 3. the retirement table is exactly the last entry's list;
 * 4. a retirement that first appears at version V is keyed to V — a retirement
 *    keyed to a bundle that had already shipped without it is red (F1.290).
 *
 * And the ever-shipped set (`fixtures/shipped-allow-strings-ever.json`): every
 * allow string any bundle ever shipped is either still shipped or retired, and
 * every shipped string is recorded there — so a removal with no retirement is
 * red, and an addition has to be written down.
 *
 * ## How to change the shipped file after this row
 *
 * Bump `version` (a string that sorts after the last one), append a `LEDGER`
 * entry with the new hash this test prints, key any new retirement to that new
 * version, and add any new allow string to the fixture.
 */
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RETIRED_SHIPPED_PATTERNS } from '../permissions-config.ts'

type Entry = string | { pattern: string }
interface ShippedFile {
  version: string
  allowedBashPatterns?: Entry[]
  allowedMcpPatterns?: Entry[]
  deniedPaths?: Entry[]
  deniedToolPatterns?: Entry[]
  blockedCommandHints?: Array<{ command: string; whenNotMatching?: string; reason: string }>
}
type Retirement = (typeof RETIRED_SHIPPED_PATTERNS)[number]
type AllowField = 'allowedBashPatterns' | 'allowedMcpPatterns'
interface LedgerEntry { version: string; retirements: readonly string[]; contentHash?: string }

const SHIPPED_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
)
const SHIPPED = JSON.parse(SHIPPED_TEXT) as ShippedFile
const EVER = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'shipped-allow-strings-ever.json'), 'utf-8')) as Record<AllowField, string[]>
const ALLOW_FIELDS: readonly AllowField[] = ['allowedBashPatterns', 'allowedMcpPatterns']

/**
 * Every bundle version the shipped file carried, oldest first, read from the
 * file at every commit that touched it (2026-09-23); the commits are named for
 * the reader and are not load-bearing. `retirements` is
 * `<field>@<version>:<content>` for each `RETIRED_SHIPPED_PATTERNS` entry that
 * bundle's build carried — `<content>` a short hash of the entry's patterns, so an
 * entry whose patterns change after its bundle shipped reads as a NEW entry and
 * meets rule 4 (F1.292 found the first form, `<field>@<version>` alone, blind to
 * exactly that). Only the LAST entry pins a content hash: it is the only one the
 * current file can be re-hashed against, so an entry drops its hash when a newer
 * one is appended.
 */
const LEDGER: readonly LedgerEntry[] = [
  { version: '2026-03-07', retirements: [] }, // the seed (aadf3a052, c569902ab, 845cf0a41)
  { version: '2026-07-06', retirements: [] }, // 63c508ace … 64c6a8391 (P2.207 changed the list under it)
  { version: '2026-08-28', retirements: [] }, // feea4b1b9
  { version: '2026-09-06', retirements: [] }, // 7b7582387, e6296c0f7 (two deniedPaths added under it), 04e335f1e
  { version: '2026-09-23', retirements: ['allowedMcpPatterns@2026-09-23:ffa28260'] }, // f4a545cca (F1.258)
  { version: '2026-09-23.2', retirements: ['allowedMcpPatterns@2026-09-23:ffa28260', 'allowedBashPatterns@2026-09-23.2:fe1e0013'] }, // F1.290
  { version: '2026-09-23.3', retirements: ['allowedMcpPatterns@2026-09-23:ffa28260', 'allowedBashPatterns@2026-09-23.2:fe1e0013'] }, // F1.288
  { version: '2026-09-23.4', retirements: ['allowedMcpPatterns@2026-09-23:ffa28260', 'allowedBashPatterns@2026-09-23.2:fe1e0013', 'allowedBashPatterns@2026-09-23.4:f7d8bf6f'] }, // F1.292
  {
    version: '2026-09-29', // F1.1170 (the hints stop naming Explore; the seed's four retire from installed copies)
    retirements: ['allowedMcpPatterns@2026-09-23:ffa28260', 'allowedBashPatterns@2026-09-23.2:fe1e0013', 'allowedBashPatterns@2026-09-23.4:f7d8bf6f', 'blockedCommandHints@2026-09-29:7815422b'],
  },
  {
    version: '2026-10-02', // UA1.16 (bff2d1a00: the t-artifacts registry deniedPath **/workspaces/*/artifacts/registry.json)
    retirements: ['allowedMcpPatterns@2026-09-23:ffa28260', 'allowedBashPatterns@2026-09-23.2:fe1e0013', 'allowedBashPatterns@2026-09-23.4:f7d8bf6f', 'blockedCommandHints@2026-09-29:7815422b'],
  },
  {
    version: '2026-10-09', // UA12.88 (upstream v0.14.0's two gh api entries again; the anchored one retires)
    retirements: ['allowedMcpPatterns@2026-09-23:ffa28260', 'allowedBashPatterns@2026-09-23.2:fe1e0013', 'allowedBashPatterns@2026-09-23.4:f7d8bf6f', 'blockedCommandHints@2026-09-29:7815422b', 'allowedBashPatterns@2026-10-09:0c597055'],
  },
  {
    // UA12.184 (the anchored gh api entry again; upstream's two retire; the 2026-10-09 retirement of the anchored string is removed)
    version: '2026-10-09.2',
    retirements: ['allowedMcpPatterns@2026-09-23:ffa28260', 'allowedBashPatterns@2026-09-23.2:fe1e0013', 'allowedBashPatterns@2026-09-23.4:f7d8bf6f', 'blockedCommandHints@2026-09-29:7815422b', 'allowedBashPatterns@2026-10-09.2:ca9ea36b'],
    contentHash: '818784c67ebf7814',
  },
]

const strings = (entries: Entry[] | undefined) => (entries ?? []).map(entry => (typeof entry === 'string' ? entry : entry.pattern))
const sorted = (values: readonly string[]) => [...values].sort()
const shortHash = (value: unknown, length: number) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)
const retirementKey = (retirement: Retirement) => `${retirement.field}@${retirement.version}:${shortHash(sorted(retirement.patterns), 8)}`

/** What the migration reads: every merged list's strings, the hint keys it dedups by, and the retirement table. */
function contentHash(file: ShippedFile, retired: readonly Retirement[]): string {
  const canonical = {
    allowedBashPatterns: sorted(strings(file.allowedBashPatterns)),
    allowedMcpPatterns: sorted(strings(file.allowedMcpPatterns)),
    deniedPaths: sorted(strings(file.deniedPaths)),
    deniedToolPatterns: sorted(strings(file.deniedToolPatterns)),
    blockedCommandHints: sorted((file.blockedCommandHints ?? []).map(h => `${h.command}::${h.whenNotMatching ?? ''}::${h.reason}`)),
    retirements: retired.map(r => ({ key: retirementKey(r), patterns: sorted(r.patterns) })),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

/** The guard: every finding, as a sentence naming what to do. Empty means the shipped file is consistent. */
function ledgerFindings(
  file: ShippedFile,
  retired: readonly Retirement[],
  ledger: readonly LedgerEntry[],
  ever: Record<AllowField, readonly string[]>,
): string[] {
  const findings: string[] = []
  const last = ledger[ledger.length - 1]!
  const hash = contentHash(file, retired)
  if (last.version !== file.version) {
    findings.push(`version ${file.version} has no LEDGER entry: append { version: '${file.version}', retirements: [...], contentHash: '${hash}' }`)
  } else if (last.contentHash !== hash) {
    findings.push(`the shipped lists or the retirement table changed while version stayed ${file.version} (hash ${hash}, pinned ${last.contentHash}): bump version and append a LEDGER entry`)
  }
  for (let i = 1; i < ledger.length; i++) {
    const [previous, next] = [ledger[i - 1]!, ledger[i]!]
    if (!(previous.version < next.version)) {
      findings.push(`LEDGER versions must increase under the migration's string comparison: '${previous.version}' then '${next.version}'`)
    }
    for (const key of next.retirements) {
      if (!previous.retirements.includes(key) && !key.includes(`@${next.version}:`)) {
        findings.push(`retirement ${key} first appears in bundle ${next.version} (a new entry, or an old one whose patterns changed), so it must be keyed to ${next.version}: a profile already at its version would never cross it (F1.290)`)
      }
    }
  }
  const table = sorted(retired.map(retirementKey))
  if (JSON.stringify(table) !== JSON.stringify(sorted(last.retirements))) {
    findings.push(`the retirement table (${table.join(', ')}) is not the last LEDGER entry's list (${sorted(last.retirements).join(', ')})`)
  }
  for (const retirement of retired) {
    if (retirement.version > file.version) findings.push(`retirement ${retirementKey(retirement)} is keyed past the bundle ${file.version}: no migration would cross it`)
  }
  for (const field of ALLOW_FIELDS) {
    const shipped = new Set(strings(file[field]))
    const retiredHere = new Set(retired.filter(r => r.field === field).flatMap(r => r.patterns))
    for (const value of ever[field]) {
      if (!shipped.has(value) && !retiredHere.has(value)) {
        findings.push(`${field} "${value}" was shipped and is gone with no retirement entry: an installed copy keeps it (the P2.207 hole)`)
      }
    }
    const recorded = new Set(ever[field])
    for (const value of shipped) {
      if (!recorded.has(value)) findings.push(`${field} "${value}" is shipped and not recorded in fixtures/shipped-allow-strings-ever.json`)
    }
  }
  return findings
}

describe('F1.291 · the shipped default.json cannot change behind its version, or drop a string with no retirement', () => {
  it('HEAD is consistent: the ledger, the pinned hash, the retirement table and the ever-shipped set agree', () => {
    expect(ledgerFindings(SHIPPED, RETIRED_SHIPPED_PATTERNS, LEDGER, EVER)).toEqual([])
  })

  it('CONTROL (the row\'s mutant): dropping one current bash pattern with no retirement is red — twice over', () => {
    const [dropped, ...rest] = SHIPPED.allowedBashPatterns ?? []
    const findings = ledgerFindings({ ...SHIPPED, allowedBashPatterns: rest }, RETIRED_SHIPPED_PATTERNS, LEDGER, EVER)
    expect(findings.some(f => f.startsWith('the shipped lists or the retirement table changed while version stayed'))).toBe(true)
    expect(findings).toContain(`allowedBashPatterns "${strings([dropped!])[0]}" was shipped and is gone with no retirement entry: an installed copy keeps it (the P2.207 hole)`)
  })

  it('a bumped version with the same drop is still red; a retirement entry for it makes it green', () => {
    const [dropped, ...rest] = SHIPPED.allowedBashPatterns ?? []
    const droppedString = strings([dropped!])[0]!
    const next = `${SHIPPED.version}-next`
    const file = { ...SHIPPED, version: next, allowedBashPatterns: rest }
    const retirement: Retirement = { version: next, field: 'allowedBashPatterns', label: 'bash pattern', patterns: [droppedString] }
    const withoutEntry = [...LEDGER, { version: next, retirements: LEDGER[LEDGER.length - 1]!.retirements, contentHash: contentHash(file, RETIRED_SHIPPED_PATTERNS) }]
    expect(ledgerFindings(file, RETIRED_SHIPPED_PATTERNS, withoutEntry, EVER)).toEqual([
      `allowedBashPatterns "${droppedString}" was shipped and is gone with no retirement entry: an installed copy keeps it (the P2.207 hole)`,
    ])
    const retired = [...RETIRED_SHIPPED_PATTERNS, retirement]
    const withEntry = [...LEDGER, { version: next, retirements: [...LEDGER[LEDGER.length - 1]!.retirements, retirementKey(retirement)], contentHash: contentHash(file, retired) }]
    expect(ledgerFindings(file, retired, withEntry, EVER)).toEqual([])
  })

  it('F1.290\'s shape is red: a new retirement keyed to a bundle that had already shipped without it', () => {
    const [dropped, ...rest] = SHIPPED.allowedBashPatterns ?? []
    const droppedString = strings([dropped!])[0]!
    const next = `${SHIPPED.version}-next`
    const file = { ...SHIPPED, version: next, allowedBashPatterns: rest }
    const stale: Retirement = { version: SHIPPED.version, field: 'allowedBashPatterns', label: 'bash pattern', patterns: [droppedString] }
    const retired = [...RETIRED_SHIPPED_PATTERNS, stale]
    const ledger = [...LEDGER, { version: next, retirements: [...LEDGER[LEDGER.length - 1]!.retirements, retirementKey(stale)], contentHash: contentHash(file, retired) }]
    expect(ledgerFindings(file, retired, ledger, EVER)).toEqual([
      `retirement ${retirementKey(stale)} first appears in bundle ${next} (a new entry, or an old one whose patterns changed), so it must be keyed to ${next}: a profile already at its version would never cross it (F1.290)`,
    ])
  })

  it('the same shape through an EXISTING entry is red: patterns appended to a retirement after its bundle shipped', () => {
    // F1.292 found this hole in the guard's first form, whose keys were `<field>@<version>`
    // alone: appending to the newest bash entry kept its key, and rule 4 saw nothing new.
    const [dropped, ...rest] = SHIPPED.allowedBashPatterns ?? []
    const droppedString = strings([dropped!])[0]!
    const next = `${SHIPPED.version}-next`
    const file = { ...SHIPPED, version: next, allowedBashPatterns: rest }
    // The newest BASH entry (F1.1170 appended a `blockedCommandHints` one after it, which a bash string cannot grow).
    const newest = RETIRED_SHIPPED_PATTERNS.filter(retirement => retirement.field === 'allowedBashPatterns').at(-1)!
    const grown: Retirement = { ...newest, patterns: [...newest.patterns, droppedString] }
    const retired = RETIRED_SHIPPED_PATTERNS.map(retirement => (retirement === newest ? grown : retirement))
    const retirements = LEDGER[LEDGER.length - 1]!.retirements.map(key => (key === retirementKey(newest) ? retirementKey(grown) : key))
    const ledger = [...LEDGER, { version: next, retirements, contentHash: contentHash(file, retired) }]
    expect(ledgerFindings(file, retired, ledger, EVER)).toEqual([
      `retirement ${retirementKey(grown)} first appears in bundle ${next} (a new entry, or an old one whose patterns changed), so it must be keyed to ${next}: a profile already at its version would never cross it (F1.290)`,
    ])
  })

  it('a new shipped string must be recorded; `2026-09-23.10` after `.9` is refused by the comparison the migration uses', () => {
    const next = `${SHIPPED.version}-next`
    const file = { ...SHIPPED, version: next, allowedBashPatterns: [...(SHIPPED.allowedBashPatterns ?? []), '^brand-new\\b'] }
    const ledger = [...LEDGER, { version: next, retirements: LEDGER[LEDGER.length - 1]!.retirements, contentHash: contentHash(file, RETIRED_SHIPPED_PATTERNS) }]
    expect(ledgerFindings(file, RETIRED_SHIPPED_PATTERNS, ledger, EVER)).toEqual([
      'allowedBashPatterns "^brand-new\\b" is shipped and not recorded in fixtures/shipped-allow-strings-ever.json',
    ])
    const ten = [{ version: '2026-09-23.9', retirements: [] }, { version: '2026-09-23.10', retirements: [] }]
    expect(ledgerFindings({ ...SHIPPED, version: '2026-09-23.10' }, [], ten, { allowedBashPatterns: [], allowedMcpPatterns: [] })
      .filter(f => f.startsWith('LEDGER versions'))).toEqual([
      "LEDGER versions must increase under the migration's string comparison: '2026-09-23.9' then '2026-09-23.10'",
    ])
  })
})
