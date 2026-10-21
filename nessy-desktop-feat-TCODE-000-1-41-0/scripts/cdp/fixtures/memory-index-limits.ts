/**
 * Seed a config dir's `MEMORY.md` to a chosen distance from the auto-memory
 * index read limits, for `RS-79` (plan row `D1.65`).
 *
 * ## Why this is a FIXTURE and not part of the case
 *
 * `scripts/cdp/README.md`: *"A **case** never installs hooks, plugins or managed
 * policy … A FIXTURE may write into a config dir it owns — that is what a
 * fixture is — and it happens here, in one reviewable place, against a scratch
 * config dir, rather than inside a case where a later reader would not expect
 * it."* The row needs the index at three different sizes, and a size is a state
 * of the profile before the session starts, so it belongs here.
 *
 * ## The three states, and why they are separate RUNS
 *
 * `memoryIndexWriteNotice` (`packages/session-tools-core/src/memory-index.ts`)
 * measures the file the write LEFT BEHIND and returns one of three levels. The
 * levels are ordered and a write only ever grows the index, so one session
 * cannot walk `ok` → `near` → `over` and come back: each level is its own seed
 * plus its own case run.
 *
 *   over — the write leaves the index past 200 lines or past 25 KiB
 *   near — at or past 90 % of either limit and past neither
 *   ok   — comfortably under both, the level that must produce NO notice
 *
 * The numbers are the row's own (*"the 200-line / 25 KB limit"*) and the
 * product's (`MEMORY_LOAD_LINE_LIMIT`, `MEMORY_LOAD_BYTE_LIMIT`,
 * `MEMORY_INDEX_NEAR_LIMIT_RATIO = 0.9`). They are spelled here rather than
 * imported, deliberately: the artefact under test is a PACKAGED build from a
 * named commit, and importing today's source would let a source edit silently
 * redefine what the case measured on that build.
 *
 * ## What it writes
 *
 * `<configDir>/MEMORY.md`, REPLACED — this is the file under test, and a merge
 * would make the resulting size unpredictable, which is the one thing the row
 * needs to be exact. It refuses to run against a config dir it was not given
 * explicitly, so it can never touch an operator's live memory index by default.
 * Every line it writes is a marked fixture line, so the file is recognisable as
 * this fixture's and not a user's notes.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** `MEMORY_LOAD_LINE_LIMIT` — `how-claude-code-works.md:74`, quoted in the module. */
export const LINE_LIMIT = 200
/** `MEMORY_LOAD_BYTE_LIMIT` — 25 KiB, read as KiB by the module's own note. */
export const BYTE_LIMIT = 25 * 1024
/** `MEMORY_INDEX_NEAR_LIMIT_RATIO`. */
export const NEAR_RATIO = 0.9

export type MemoryIndexArm = 'over' | 'near' | 'ok'

/**
 * How many lines to seed for each arm, chosen so that ONE `remember` call —
 * which appends a heading line, a body line and a blank — lands on the level.
 *
 *  - `over`: 205 already exceeds 200 before the write, so the write leaves it
 *    further over. Seeding exactly 199 and relying on the append to cross would
 *    make the arm depend on how many lines one note happens to add.
 *  - `near`: 182 is over 180 (90 % of 200) and under 200 both before and after a
 *    three-line append, so the arm is stable either side of the write.
 *  - `ok`: 20 lines is under both limits with room for any plausible append.
 */
const SEED_LINES: Record<MemoryIndexArm, number> = { over: 205, near: 182, ok: 20 }

export interface SeedResult {
  arm: MemoryIndexArm
  path: string
  lines: number
  bytes: number
  /** The level the product's own rule implies for a file THIS size. */
  impliedLevel: MemoryIndexArm
}

/** The level `memoryIndexWriteNotice` returns for a file of this size. */
export function impliedLevel(lines: number, bytes: number): MemoryIndexArm {
  if (lines > LINE_LIMIT) return 'over'
  if (bytes > BYTE_LIMIT) return 'over'
  if (lines >= LINE_LIMIT * NEAR_RATIO || bytes >= BYTE_LIMIT * NEAR_RATIO) return 'near'
  return 'ok'
}

export function seedMemoryIndex(configDir: string, arm: MemoryIndexArm): SeedResult {
  const path = join(configDir, 'MEMORY.md')
  const wanted = SEED_LINES[arm]
  const body: string[] = ['# Memory index', '']
  for (let index = body.length; index < wanted; index += 1) {
    body.push(`- CDP fixture entry ${String(index).padStart(3, '0')} — a one-line memory entry, as the remedy asks for.`)
  }
  const text = `${body.join('\n')}\n`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  // Measured the way `measureMemoryIndex` measures: split on newlines, then the
  // byte length of the re-joined lines.
  const lines = text.split(/\r?\n/)
  const bytes = Buffer.byteLength(lines.join('\n'), 'utf-8')
  return { arm, path, lines: lines.length, bytes, impliedLevel: impliedLevel(lines.length, bytes) }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const configDir = args[args.indexOf('--config-dir') + 1]
  const arm = (args[args.indexOf('--arm') + 1] ?? 'ok') as MemoryIndexArm
  if (!configDir || args.indexOf('--config-dir') === -1) {
    console.error('usage: bun run scripts/cdp/fixtures/memory-index-limits.ts --config-dir <dir> --arm over|near|ok')
    console.error('It REPLACES <dir>/MEMORY.md, so it refuses to guess the directory.')
    process.exit(2)
  }
  if (!['over', 'near', 'ok'].includes(arm)) {
    console.error(`unknown --arm ${JSON.stringify(arm)}; use over, near or ok`)
    process.exit(2)
  }
  const result = seedMemoryIndex(configDir, arm)
  console.log(JSON.stringify(result, null, 2))
  console.log('')
  console.log(`Then: NESSY_CDP_MEMORY_ARM=${result.arm} bun run scripts/cdp/cases/rs-79.ts`)
}
