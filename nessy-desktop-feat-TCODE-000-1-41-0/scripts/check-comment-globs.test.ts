/**
 * Tests for `check-comment-globs.ts` — P2.492.
 *
 * The pair that matters is the first two: the gate must fire on the shape that
 * broke four files in one day, and must stay silent on the same character
 * sequence held deliberately in a constant. A check that cannot tell those apart
 * is the grep this row rejected.
 */

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closedByPathPattern, findInSource, loadSourceTexts, scannedFiles } from './check-comment-globs'
import { blockComments } from './ts-comment-scan'

// The F1.195 arm drives git in a temp repo and the enumeration arm lists this
// one; on this rig either is seconds, not the 5 ms of the in-memory arms, and
// bun's default is 5 s. The same budget `check-nul-bytes.test.ts` gives its
// git-backed arms.
setDefaultTimeout(120_000)

/** Assembled at runtime so this file never carries the sequence in its own prose. */
const STAR = '*'
const OPEN = `/${STAR}${STAR}`
const CLOSE = `${STAR}/`

describe('check-comment-globs', () => {
  test('the historical shape is caught: a workspace glob inside a docblock', () => {
    // `704b80f07` wrote exactly this into `check-exports-map.ts` and `82671b752`
    // took it out again; in between, the gate could not parse past line 9.
    const src = `${OPEN}\n * EVERY packages/${STAR}/package.json carries a map\n ${CLOSE}\nexport const a = 1\n`

    const findings = findInSource('x.ts', src)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe('closed-by-a-path-pattern')
    expect(findings[0]!.line).toBe(2)
  })

  test('the same sequence in a string constant is NOT reported', () => {
    // This is the reason the row refused a grep: `check-exports-map` holds these
    // patterns on purpose, and they are the only place they belong.
    const src = `const MANIFEST_GLOBS = ['packages/${STAR}/package.json', 'apps/${STAR}/package.json']\n`

    expect(findInSource('x.ts', src)).toEqual([])
  })

  test('a double-star segment closes a comment too', () => {
    const src = `/${STAR} include src/${STAR}${STAR}/index.ts ${CLOSE}\nconst a = 1\n`

    const findings = findInSource('x.ts', src)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe('closed-by-a-path-pattern')
  })

  test('an ordinary docblock is silent', () => {
    const src = `${OPEN}\n * A perfectly normal sentence.\n ${CLOSE}\nconst a = 1\n`

    expect(findInSource('x.ts', src)).toEqual([])
  })

  test('an empty block comment does not report itself', () => {
    // Its own opening delimiter is a slash followed by stars, so the naive form
    // of this rule flags every one of them.
    const src = `/${STAR}${CLOSE}\nconst a = 1\n`

    expect(findInSource('x.ts', src)).toEqual([])
    expect(closedByPathPattern(src, blockComments(src)[0]!)).toBe(false)
  })

  test('a block comment that never closes is the same mistake from the far end', () => {
    const src = `${OPEN}\n * a sentence with no closer\nconst a = 1\n`

    const findings = findInSource('x.ts', src)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe('never-closed')
  })

  test('the file enumeration is real, and the tree is clean (not vacuous)', () => {
    const files = scannedFiles()

    // Positive control: an empty enumeration would make the clean verdict below
    // true by knowing nothing, which is how a gate reports a green it never earned.
    expect(files.length).toBeGreaterThan(1000)
    expect(files).toContain('scripts/check-exports-map.ts')
    expect(files.some((f) => f.startsWith('.references/'))).toBe(false)
  })

  test('F1.195 — clean files are read as blobs, changed ones from disk, a pending deletion is named and skipped', async () => {
    // Built in a temp repo, never in the shared tree: the planted defects below
    // exist only there, and a gate is not tested by breaking this repo's files.
    const root = mkdtempSync(join(tmpdir(), 'comment-globs-blob-read-'))
    try {
      const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      git('init', '-q')
      git('config', 'user.email', 'lane@example.invalid')
      git('config', 'user.name', 'lane')
      const planted = `${OPEN}\n * EVERY packages/${STAR}/package.json carries a map\n ${CLOSE}\nexport const a = 1\n`
      const clean = `${OPEN}\n * an ordinary docblock\n ${CLOSE}\nexport const a = 1\n`
      // A multi-byte character ahead of the closer: the blob is sliced by BYTES
      // and decoded after, so the finding's line must still be the right one.
      writeFileSync(join(root, 'carrier.ts'), `// déjà vu — ✓\n${planted}`)
      writeFileSync(join(root, 'edited.js'), clean)
      writeFileSync(join(root, 'gone.ts'), clean)
      writeFileSync(join(root, 'moved-from.mts'), clean)
      git('add', '-A')
      git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')

      unlinkSync(join(root, 'gone.ts'))
      // A JavaScript file changed on disk whose BLOB is clean: only a dirty set
      // that covers every scanned extension reads the planted bytes.
      writeFileSync(join(root, 'edited.js'), planted)
      // A staged rename: `-z` porcelain carries the origin as a second field.
      git('mv', 'moved-from.mts', 'moved-to.mts')
      writeFileSync(join(root, 'moved-to.mts'), planted)

      const files = scannedFiles(root)
      expect([...files].sort()).toEqual(['carrier.ts', 'edited.js', 'gone.ts', 'moved-to.mts'])

      const loaded = await loadSourceTexts(files, root)
      expect(loaded.skipped).toEqual(['gone.ts'])
      expect([...loaded.texts.keys()].sort()).toEqual(['carrier.ts', 'edited.js', 'moved-to.mts'])

      const findings = [...loaded.texts].flatMap(([file, text]) => findInSource(file, text))
      expect(findings.map((finding) => `${finding.file}:${finding.line}:${finding.kind}`).sort()).toEqual([
        'carrier.ts:3:closed-by-a-path-pattern',
        'edited.js:2:closed-by-a-path-pattern',
        'moved-to.mts:2:closed-by-a-path-pattern',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
