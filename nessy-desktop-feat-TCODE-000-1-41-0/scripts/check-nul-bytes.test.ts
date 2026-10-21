/**
 * Tests for `check-nul-bytes.ts` — P2.411.
 *
 * The thing worth pinning is not "does it find a NUL" but **does it find the one
 * every cheaper instrument misses**: a NUL past the prefix git inspects when it
 * decides a blob is binary. That is the case where `comm -23 <(git ls-files)
 * <(git grep -lI '')` returns a confident, short, wrong answer — 4 of this repo's
 * 14 files — and where plain `grep` returns nothing at all without saying so.
 *
 * Fixtures for the per-file arms live under `node_modules/.cache/` (via
 * `createGateScratchDir`) rather than in `os.tmpdir()`, because the scanner
 * refuses an absolute path by design.
 *
 * D1.320's two arms are different in kind and say so: one builds a whole TEMP
 * GIT REPO (in `os.tmpdir()`, reached through `SourceOptions.root`, never by
 * mutating this tree) to hold a pending DELETION, and the other reads this
 * repo's own history through `SourceOptions.rev`, where the numbers cannot drift
 * under a sibling lane.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GIT_BINARY_DETECTION_PREFIX_BYTES,
  loadSources,
  REPO_ROOT,
  scan,
  scanFile,
  trackedTypeScriptFiles,
} from './check-nul-bytes'
import { createGateScratchDir, GateSafetyRefusal } from './gate-safety'

// The two git-backed arms read this repo's history and a temp repo; on this rig
// that is seconds rather than the 5 ms of the in-memory ones, and bun's default
// is 5 s. Sized against the largest observed run (the `--rev` arm, ~2 s).
setDefaultTimeout(120_000)

const scratch = createGateScratchDir(REPO_ROOT, 'nul-bytes-test')

afterAll(() => {
  rmSync(scratch.absolute, { recursive: true, force: true })
})

/** Write `bytes` into the scratch dir and return its repo-relative path. */
function fixture(name: string, bytes: Buffer): string {
  writeFileSync(join(scratch.absolute, name), bytes)
  return `${scratch.fromRepoRoot}/${name}`
}

const NUL = Buffer.from([0])

describe('check-nul-bytes', () => {
  test('finds a NUL in the first few bytes', () => {
    const path = fixture('early.ts', Buffer.concat([Buffer.from("const k = 'a"), NUL, Buffer.from("b'\n")]))

    const finding = scanFile(path)
    expect(finding).not.toBeNull()
    expect(finding!.firstOffset).toBe(12)
    expect(finding!.count).toBe(1)
    expect(finding!.lines).toEqual([1])
  })

  test('finds a NUL PAST the prefix git inspects — the case the shortcut misses', () => {
    const pad = Buffer.from(`// ${'x'.repeat(GIT_BINARY_DETECTION_PREFIX_BYTES + 1000)}\n`)
    const path = fixture('late.ts', Buffer.concat([pad, Buffer.from("const k = 'a"), NUL, Buffer.from("b'\n")]))

    const finding = scanFile(path)
    expect(finding).not.toBeNull()
    // The whole point: this offset is past the prefix, so git does not call the
    // file binary and `git grep -lI` never lists it. Measured in an isolated
    // scratch repo with exactly these two fixtures, git reported only the early
    // one. Reading the whole file is what separates the two answers.
    expect(finding!.firstOffset).toBeGreaterThan(GIT_BINARY_DETECTION_PREFIX_BYTES)
    expect(finding!.count).toBe(1)
    expect(finding!.lines).toEqual([2])
  })

  test('returns null for a file with no NUL, including an empty one', () => {
    expect(scanFile(fixture('clean.ts', Buffer.from("const k = 'ab'\n")))).toBeNull()
    // An empty file is the git shortcut's OTHER error: `git grep -lI ''` matches
    // lines, an empty file has none, so `comm` reports it as binary. It is not.
    expect(scanFile(fixture('empty.ts', Buffer.alloc(0)))).toBeNull()
  })

  test('counts every NUL and every line carrying one', () => {
    const path = fixture(
      'many.ts',
      Buffer.concat([
        Buffer.from('a'), NUL, Buffer.from('b'), NUL, Buffer.from('\n'),
        Buffer.from('c\n'),
        Buffer.from('d'), NUL, Buffer.from('\n'),
      ]),
    )

    const finding = scanFile(path)
    expect(finding!.count).toBe(3)
    expect(finding!.lines).toEqual([1, 3])
  })

  test('scan() reports only the carriers, ordered by first offset', () => {
    const late = fixture('order-late.ts', Buffer.concat([Buffer.alloc(500, 0x20), NUL]))
    const early = fixture('order-early.ts', Buffer.concat([Buffer.alloc(10, 0x20), NUL]))
    const clean = fixture('order-clean.ts', Buffer.from('ok\n'))

    expect(scan([late, early, clean]).map((f) => f.firstOffset)).toEqual([10, 500])
  })

  test('refuses a path that escapes the repository', () => {
    expect(() => scanFile('../..')).toThrow(GateSafetyRefusal)
  })

  test('refuses a path naming a home directory or the filesystem root', () => {
    // Matcher-only strings: never executed, only handed to the guard.
    expect(() => scanFile('~/secrets.ts')).toThrow(GateSafetyRefusal)
    expect(() => scanFile('/etc/hosts')).toThrow(GateSafetyRefusal)
  })

  test('D1.320 — a PENDING DELETION is skipped by name, not a crash', async () => {
    // Built in a temp repo, never in the shared tree: a gate is not tested by
    // deleting one of this repo's files and hoping the restore is exact.
    const root = mkdtempSync(join(tmpdir(), 'nul-bytes-pending-deletion-'))
    try {
      const run = (...args: string[]): void => {
        execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      }
      run('init', '-q')
      run('config', 'user.email', 'lane@example.invalid')
      run('config', 'user.name', 'lane')
      writeFileSync(join(root, 'carrier.ts'), Buffer.concat([Buffer.from('a'), NUL, Buffer.from('b\n')]))
      writeFileSync(join(root, 'gone.ts'), Buffer.from('export const x = 1\n'))
      writeFileSync(join(root, 'edited.ts'), Buffer.from('export const y = 1\n'))
      run('add', '-A')
      run('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')

      // The pending deletion: in the INDEX, gone from the DISK. This is the
      // state that killed `lint:chain` at its second step on 2026-09-18.
      unlinkSync(join(root, 'gone.ts'))
      // And a dirty file whose WORKING TREE bytes differ from its blob — the
      // fidelity arm, because reading clean files as blobs is only sound if the
      // changed ones are still read from disk.
      writeFileSync(join(root, 'edited.ts'), Buffer.concat([Buffer.from('y'), NUL, Buffer.from('\n')]))

      const files = trackedTypeScriptFiles({ root })
      expect(files.sort()).toEqual(['carrier.ts', 'edited.ts', 'gone.ts'])

      const loaded = await loadSources(files, { root })
      expect(loaded.skipped).toEqual(['gone.ts'])
      expect(loaded.bytes.has('gone.ts')).toBe(false)

      // Not a crash, and both NULs found: the clean one through the blob batch,
      // the dirty one from disk where the blob has none.
      const findings = scan(files, true, loaded.bytes)
      expect(findings.map((finding) => finding.file).sort()).toEqual(['carrier.ts', 'edited.ts'])
      expect(findings.every((finding) => finding.count === 1)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('F1.271 — a dirty file whose name git QUOTES (a space, a non-ASCII name, a double quote, a backslash) is read from disk', async () => {
    // `git status --porcelain` without `-z` prints such a path C-quoted
    // (` M "with space.ts"`, the Cyrillic one as octal escapes), so a parser
    // that slices the line kept the quotes, matched no enumerated file, and read
    // the STALE index blob — a NUL added in the working tree went unreported.
    // Measured in a temp repo before the fix: both names printed quoted.
    const root = mkdtempSync(join(tmpdir(), 'nul-bytes-quoted-path-'))
    try {
      const run = (...args: string[]): void => {
        execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      }
      run('init', '-q')
      run('config', 'user.email', 'lane@example.invalid')
      run('config', 'user.name', 'lane')
      writeFileSync(join(root, 'with space.ts'), Buffer.from('export const a = 1\n'))
      writeFileSync(join(root, 'тест.ts'), Buffer.from('export const b = 1\n'))
      // F1.455: the row's third named input, and the other character git escapes.
      writeFileSync(join(root, 'q"uote.ts'), Buffer.from('export const d = 1\n'))
      writeFileSync(join(root, 'back\\slash.ts'), Buffer.from('export const e = 1\n'))
      writeFileSync(join(root, 'plain.ts'), Buffer.from('export const c = 1\n'))
      run('add', '-A')
      run('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')

      // The NULs exist ONLY in the working tree: the index blobs are clean.
      writeFileSync(join(root, 'with space.ts'), Buffer.concat([Buffer.from('a'), NUL, Buffer.from('\n')]))
      writeFileSync(join(root, 'тест.ts'), Buffer.concat([Buffer.from('b'), NUL, Buffer.from('\n')]))
      writeFileSync(join(root, 'q"uote.ts'), Buffer.concat([Buffer.from('d'), NUL, Buffer.from('\n')]))
      writeFileSync(join(root, 'back\\slash.ts'), Buffer.concat([Buffer.from('e'), NUL, Buffer.from('\n')]))
      // CONTROL on the same instrument: a plain-named dirty file, which the old
      // parser already read from disk.
      writeFileSync(join(root, 'plain.ts'), Buffer.concat([Buffer.from('c'), NUL, Buffer.from('\n')]))

      const files = trackedTypeScriptFiles({ root })
      const names = ['plain.ts', 'with space.ts', 'тест.ts', 'q"uote.ts', 'back\\slash.ts'].sort()
      expect(files.sort()).toEqual(names)
      const findings = scan(files, true, (await loadSources(files, { root })).bytes)
      expect(findings.map((finding) => finding.file).sort()).toEqual(names)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('F1.453 — `--rev` lists every name git QUOTES, so a historical reading scans all of them', async () => {
    // `ls-tree -r --name-only` without `-z` prints a name carrying a double
    // quote, a backslash or a non-ASCII byte C-quoted; the closing quote fails the
    // `.ts` filter and the file silently leaves the historical control. WJ-ii's
    // verifier measured 2 of these 5 enumerated at the parent (`ls-tree` does not
    // quote a space), against 5 of 5 through the index.
    const root = mkdtempSync(join(tmpdir(), 'nul-bytes-quoted-rev-'))
    try {
      const run = (...args: string[]): void => {
        execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      }
      run('init', '-q')
      run('config', 'user.email', 'lane@example.invalid')
      run('config', 'user.name', 'lane')
      const names = ['plain.ts', 'with space.ts', 'тест.ts', 'q"uote.ts', 'back\\slash.ts'].sort()
      for (const name of names) writeFileSync(join(root, name), Buffer.concat([Buffer.from('a'), NUL, Buffer.from('\n')]))
      run('add', '-A')
      run('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')

      const files = trackedTypeScriptFiles({ root, rev: 'HEAD' })
      expect([...files].sort()).toEqual(names)
      const findings = scan(files, true, (await loadSources(files, { root, rev: 'HEAD' })).bytes)
      expect(findings.map((finding) => finding.file).sort()).toEqual(names)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('D1.320 — the historical control: the two NUL bytes `de52b1fac` shipped', async () => {
    // `--rev` over this repo's own history. `de52b1fac` is the commit that
    // briefly shipped a raw NUL in `scripts/check-shape-pointer-reasons.ts` (a
    // null-codepoint escape decoded by the tool that wrote the file), and
    // `e74f4486c` is the one that replaced it with `::`. History is immutable, so
    // this pin cannot drift under a sibling lane.
    const before = trackedTypeScriptFiles({ rev: 'de52b1fac' })
    const found = scan(before, true, (await loadSources(before, { rev: 'de52b1fac' })).bytes)

    expect(found).toHaveLength(1)
    expect(found[0]?.file).toBe('scripts/check-shape-pointer-reasons.ts')
    expect(found[0]?.count).toBe(2)
    // Past the prefix git inspects — so `git grep -lI` would have missed it too,
    // which is this gate's whole reason for reading every byte.
    expect(found[0]?.firstOffset).toBeGreaterThan(GIT_BINARY_DETECTION_PREFIX_BYTES)

    // The negative arm on the same instrument, one commit later.
    const after = trackedTypeScriptFiles({ rev: 'e74f4486c' })
    expect(scan(after, true, (await loadSources(after, { rev: 'e74f4486c' })).bytes)).toHaveLength(0)
  })
})
