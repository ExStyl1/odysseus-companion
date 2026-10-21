/**
 * Tests for `git-status-z.ts` — F1.454.
 *
 * The parser decides which files three gates read from DISK rather than as
 * their index blob, so an entry it loses is a file those gates read stale. The
 * table arms pin the field rule; the real-git arm pins that the shape they
 * describe is the one git actually prints, in a throwaway repo, never this tree.
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parsePorcelainZ } from './git-status-z'
import { loadSources } from './check-nul-bytes'

const parsed = (raw: string): string[] => [...parsePorcelainZ(raw)].sort()

describe('parsePorcelainZ', () => {
  test('an ORIGIN is skipped in either status column, so it never swallows the next entry (F1.454)', () => {
    // WJ-ii's verifier's ARM4, verbatim: a work-tree rename whose origin begins
    // with R. Testing only the index column parsed `Rold.ts` as an entry
    // (`d.ts`) and skipped ` M b.ts` as if it were that entry's origin.
    // F1.488 (2): the ORIGIN of a WORK-TREE rename is named dirty — it is gone
    // from the disk and still in the index, exactly a ` D` — and still never
    // parsed as an entry, so ` M b.ts` survives.
    expect(parsed(' R a-new.ts\0Rold.ts\0 M b.ts\0')).toEqual(['Rold.ts', 'a-new.ts', 'b.ts'])
    // The index column — the case the parser always handled — as the control.
    expect(parsed('R  a-new.ts\0Rold.ts\0 M b.ts\0')).toEqual(['a-new.ts', 'b.ts'])
    // A copy carries an origin too, in either column (`status.renames=copies`).
    expect(parsed('C  c-new.ts\0Cold.ts\0 M b.ts\0')).toEqual(['b.ts', 'c-new.ts'])
    expect(parsed(' C c-new.ts\0Cold.ts\0 M b.ts\0')).toEqual(['b.ts', 'c-new.ts'])
    // Entries that carry no origin keep every neighbour.
    expect(parsed(' M a.ts\0 D b.ts\0?? c.ts\0')).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  test('against real git: a work-tree rename of an intent-to-add file names the NEXT dirty file too (F1.454)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-status-z-worktree-rename-'))
    try {
      const run = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      run('init', '-q')
      run('config', 'user.email', 'lane@example.invalid')
      run('config', 'user.name', 'lane')
      const body = 'export const same = "a body long enough for rename detection to pair the two names"\n'
      writeFileSync(join(root, 'Rold.ts'), body)
      writeFileSync(join(root, 'b.ts'), 'export const b = 1\n')
      run('add', '-A')
      run('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')

      // The origin deleted, its bytes re-created under a new name and
      // intent-to-added — git pairs the two as ` R`, a rename in the WORK TREE.
      unlinkSync(join(root, 'Rold.ts'))
      writeFileSync(join(root, 'a-new.ts'), body)
      run('add', '-N', 'a-new.ts')
      writeFileSync(join(root, 'b.ts'), 'export const b = 2\n')

      const raw = run('status', '--porcelain', '-z')
      // The shape this row is about, asserted, so a git that stopped pairing
      // them could not make the parse below pass vacuously.
      expect(raw.split('\0')).toEqual([' R a-new.ts', 'Rold.ts', ' M b.ts', ''])
      expect(parsed(raw)).toEqual(['Rold.ts', 'a-new.ts', 'b.ts'])
      // F1.488 (2) — what a caller does with it: the origin is a pending
      // deletion, so it is SKIPPED, never read as its stale index blob; the
      // other two are read from disk (the positive control: the loader reads).
      const loaded = await loadSources(['Rold.ts', 'a-new.ts', 'b.ts'], { root })
      expect(loaded.skipped).toEqual(['Rold.ts'])
      expect([...loaded.bytes.keys()].sort()).toEqual(['a-new.ts', 'b.ts'])
      expect(loaded.bytes.get('b.ts')!.toString('utf8')).toBe('export const b = 2\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
