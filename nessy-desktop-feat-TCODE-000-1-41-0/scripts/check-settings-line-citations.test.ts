/**
 * Tests for `check-settings-line-citations.ts` — P6.746.
 *
 * Two things are worth pinning, and neither is "does a regex match a string".
 *
 * 1. **A planted citation moves the census and trips the ratchet.** The gate is
 *    only as good as the scan behind it, and the scan is a `git grep` — so the
 *    positive case plants a real citation in a real file and counts it the way
 *    the real run does, rather than asserting the pattern in isolation.
 * 2. **The script's number IS the AGENTS.md census command's number.** The row
 *    this script closes says the pin must be re-derivable by that command and
 *    never quoted in prose. If the two ever diverge, the pin stops meaning what
 *    the guide says it means — so the agreement is asserted, not assumed.
 *
 * Scratch files live under `node_modules/.cache/` (via `createGateScratchDir`)
 * and are counted with `--no-index`, because nothing untracked is visible to a
 * plain `git grep` — which is itself the reason a planted-file test needs saying.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  census,
  censusArgs,
  CENSUS_PATHSPEC,
  CITATION_PATTERN,
  corpusCensus,
  corpusPageNames,
  CORPUS_PATTERN,
  corpusRiseIsFatal,
  DOC_PAGES_FILE,
  PINNED_CENSUS,
  PINNED_CORPUS_CENSUS,
  REPO_ROOT,
  verdict,
} from './check-settings-line-citations'
import { createGateScratchDir } from './gate-safety'

/**
 * The budget belongs to the FILE, because the cost does.
 *
 * Every case here shells out to `git grep` over `packages` + `apps`, so each is
 * priced by how fast git can walk this tree rather than by anything it asserts.
 * On CI job 630555493 the census case TIMED OUT at 5 704 ms against the 5 000 ms
 * default -- a timeout with zero assertion failures, the signature AGENTS.md
 * records as a graph cost rather than a test defect -- while the D1.99 pin case
 * in the same run made the same kind of call and took 2 492 ms, i.e. it was one
 * busy moment from the same fate. A per-case budget would have moved the cliff
 * rather than removed it.
 *
 * Part of that cost is this lane's own, and is named rather than hidden: the
 * `test` job now fetches a FULL clone (`GIT_DEPTH: 0`, which the historical
 * controls elsewhere in `scripts/` need), so every `git` invocation in the suite
 * works against a much larger object store than a depth-20 fetch gave it.
 *
 * Sized against the loaded runner, never against this machine, where the whole
 * file runs in about 5 s.
 */
setDefaultTimeout(120_000)

const scratch = createGateScratchDir(REPO_ROOT, 'settings-line-citations-test')

afterAll(() => {
  rmSync(scratch.absolute, { recursive: true, force: true })
})

function fixture(name: string, contents: string): void {
  writeFileSync(join(scratch.absolute, name), contents)
}

describe('check-settings-line-citations', () => {
  test('POSITIVE — a planted citation raises the census and the ratchet fails', () => {
    fixture(
      'planted.ts',
      [
        '// see settings.md:1234 for the shape',
        "const k = 'unrelated'",
        '// and server-managed-settings.md:99-101 for the managed twin',
        '',
      ].join('\n'),
    )

    const planted = census(scratch.absolute, ['.'], { noIndex: true })
    expect(planted.occurrences).toBe(2)
    expect(planted.citations).toEqual(['settings.md:1234', 'server-managed-settings.md:99-101'])

    // The ratchet reads a census taken when the pin was one lower as a RISE.
    expect(verdict(planted.occurrences, planted.occurrences - 1)).toBe('rose')
  })

  test('NEGATIVE — a file with no line-numbered citation leaves the census alone', () => {
    rmSync(join(scratch.absolute, 'planted.ts'), { force: true })
    // A LIVE section anchor, which is what a converted citation looks like, plus a
    // bare page mention: neither is a line-numbered anchor and neither may count.
    fixture(
      'converted.ts',
      [
        '// settings-reference.md#permissions-defaultmode — "..." (the converted form)',
        '// settings.md is the scope/precedence page since the 2026-08-25 split',
        '',
      ].join('\n'),
    )

    const clean = census(scratch.absolute, ['.'], { noIndex: true })
    expect(clean.occurrences).toBe(0)
    expect(verdict(clean.occurrences, 0)).toBe('unchanged')
  })

  test('a FALL is not a failure — it asks for the pin to be lowered', () => {
    expect(verdict(PINNED_CENSUS - 1)).toBe('fell')
    expect(verdict(PINNED_CENSUS)).toBe('unchanged')
    expect(verdict(PINNED_CENSUS + 1)).toBe('rose')
  })

  test('both halves of the report read the SAME tree (P6.936)', () => {
    // The count honoured `--cached` and the file list did not, so a `--cached`
    // run printed an index count above a working-tree list of files with nothing
    // saying so. One builder now serves both halves; the flag must reach both.
    expect(censusArgs('occurrences', { cached: true })).toContain('--cached')
    expect(censusArgs('files', { cached: true })).toContain('--cached')

    // And the default reaches neither — the working tree stays the default here,
    // because this gate's subject includes the runner's own uncommitted edit.
    expect(censusArgs('occurrences')).not.toContain('--cached')
    expect(censusArgs('files')).not.toContain('--cached')

    // The halves differ in ONE flag: occurrences per match, `path:count` per file.
    expect(censusArgs('occurrences')).toContain('-ahoI')
    expect(censusArgs('files')).toContain('-acI')
  })

  test('the count IS the AGENTS.md census command, not a second opinion', () => {
    // `git grep` exits 1 when it matches nothing, and this row ran the raw
    // command UNGUARDED — so the day the census reached ZERO the comparison
    // threw instead of agreeing, and the gate's own test went red on the commit
    // that finished the conversion it was written to watch (P6.656, measured
    // 2026-09-11). `census()` has always read status 1 as "no citations"; this
    // half now reads it the same way, so the two agree at zero as well as above
    // it — which is the only interesting state left.
    let raw: string
    try {
      raw = execFileSync(
        'git',
        ['grep', '-ahoI', '-E', CITATION_PATTERN, '--', ...CENSUS_PATHSPEC],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      )
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status !== 1) throw error
      raw = ''
    }
    const documented = raw.split('\n').filter((line) => line !== '').length

    expect(census().occurrences).toBe(documented)
  })

describe('the wide corpus census (D1.99)', () => {
  const pages = corpusPageNames()

  test('the denominator is the snapshot, and it is not empty', () => {
    // The refusal above this is the interesting half: a denominator that
    // silently became empty would print `0 in-corpus citations` and read as a
    // fully converted tree. This is the positive control that it is populated.
    expect(pages.size).toBeGreaterThan(150)
    expect(pages.has('settings-reference.md')).toBe(true)
    expect(pages.has('hooks.md')).toBe(true)
    // And the BASENAME conflation the header states, measured rather than
    // assumed: `agent-sdk/hooks` and `hooks` are two slugs with one filename.
    expect(pages.has('agent-sdk/hooks.md')).toBe(false)
  })

  test('it counts a corpus page and ignores a page that is not in the index', () => {
    fixture('wide-hit.ts', '// hooks.md:184 says so\n')
    // The negative control on the same instrument and in the same scratch dir:
    // this repo cites codex pages and its own docs the same way, and neither is
    // Claude corpus rot.
    fixture('wide-miss.ts', '// submission-errors.md:12 and 2026-08-22-codex-coverage-map.md:9\n')
    const wide = corpusCensus(scratch.absolute, ['.'], { noIndex: true }, pages)
    expect(wide.citations).toEqual(['hooks.md:184'])
    expect(wide.occurrences).toBe(1)
    rmSync(join(scratch.absolute, 'wide-hit.ts'), { force: true })
    rmSync(join(scratch.absolute, 'wide-miss.ts'), { force: true })
    expect(corpusCensus(scratch.absolute, ['.'], { noIndex: true }, pages).occurrences).toBe(0)
  })

  test('the wide pattern is a SUPERSET of the settings one, which is the row\'s whole claim', () => {
    fixture('wide-both.ts', '// settings.md:12 and hooks.md:12\n')
    const narrow = census(scratch.absolute, ['.'], { noIndex: true })
    const wide = corpusCensus(scratch.absolute, ['.'], { noIndex: true }, pages)
    expect(narrow.citations).toEqual(['settings.md:12'])
    expect(wide.citations).toEqual(['settings.md:12', 'hooks.md:12'])
    rmSync(join(scratch.absolute, 'wide-both.ts'), { force: true })
  })

  test('the pin is never below the tree, and the posture is NON-fatal', () => {
    // "Pin at the measured count, never lower than the tree": a pin under the
    // live count manufactures a permanent rise, which teaches the next reader to
    // ignore the line. This is the arm that would go red if someone lowered it
    // without converting anything.
    const live = corpusCensus(REPO_ROOT, CENSUS_PATHSPEC, {}, pages).occurrences
    expect(PINNED_CORPUS_CENSUS).toBeGreaterThanOrEqual(live)
    expect(verdict(live, PINNED_CORPUS_CENSUS)).not.toBe('rose')
    // The posture, pinned so a flip is a deliberate, reviewed change rather than
    // a drive-by: these pages have NOT split, so a new anchor is decayed, not
    // dead, and the gate says so without failing.
    expect(corpusRiseIsFatal).toBe(false)
  })

  test('the two patterns and the snapshot path are the ones the header describes', () => {
    expect(CORPUS_PATTERN).toContain('.md:[0-9]+')
    expect(CITATION_PATTERN).toContain('settings')
    expect(CORPUS_PATTERN).not.toContain('settings')
    expect(DOC_PAGES_FILE).toBe('scripts/claude-doc-pages.tsv')
    expect(censusArgs('occurrences', {}, CORPUS_PATTERN)).toContain(CORPUS_PATTERN)
  })
})
})
