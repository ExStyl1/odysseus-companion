/**
 * P6.689 — the `@` picker stops being a codex feature.
 *
 * `codex-agent.ts` was the only implementer of `fuzzyFileSearch`, so a Pi or
 * claude session's `@` menu listed MCP resources and no files, and a runtime
 * switch lost file mentions with nothing saying so.
 *
 * What this suite pins is the host search itself: that it asks GIT for the
 * ignore rules rather than re-implementing them, that it ranks the obvious
 * answer first, that it is bounded, and that its memo really is a memo.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { clearHostFileSearchCache, hostFuzzyFileSearch } from '../host-file-search.ts'

let repo: string
let plain: string

function write(root: string, path: string, content = 'x'): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

beforeAll(() => {
  // A REAL repository, because the whole ignore story is "ask git" — a
  // fabricated directory would have tested the fallback arm while claiming to
  // test the primary one.
  repo = mkdtempSync(join(tmpdir(), 'nessy-w7s1-filesearch-repo-'))
  spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf8' })
  write(repo, '.gitignore', 'ignored/\n*.log\n')
  write(repo, 'src/app-shell.ts')
  write(repo, 'src/deep/nested/app-shell-helper.ts')
  write(repo, 'ignored/app-shell-artifact.ts')
  write(repo, 'noise.log')

  plain = mkdtempSync(join(tmpdir(), 'nessy-w7s1-filesearch-plain-'))
  write(plain, 'src/widget.ts')
  write(plain, 'node_modules/pkg/widget.ts')
})

afterEach(() => { clearHostFileSearchCache() })

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})

describe('the ignore rules come from git, not from a matcher of our own', () => {
  it('lists tracked and new files, and neither ignored path', () => {
    const paths = hostFuzzyFileSearch(repo, 'appshell').map(hit => hit.path)
    // `--others --exclude-standard`: nothing here is committed yet, so a search
    // that only listed the index would return nothing at all.
    expect(paths).toContain('src/app-shell.ts')
    expect(paths).toContain('src/deep/nested/app-shell-helper.ts')
    // The two the `.gitignore` excludes — the arm a hand-written matcher gets
    // subtly wrong.
    expect(paths).not.toContain('ignored/app-shell-artifact.ts')
    expect(hostFuzzyFileSearch(repo, 'noise').map(hit => hit.path)).not.toContain('noise.log')
  })

  it('ranks the shorter, file-name match first', () => {
    const hits = hostFuzzyFileSearch(repo, 'appshell')
    expect(hits[0]!.path).toBe('src/app-shell.ts')
    expect(hits[0]!.file_name).toBe('app-shell.ts')
    expect(hits[0]!.root).toBe(repo)
    expect(hits[0]!.match_type).toBe('file')
  })

  it('reports the matched positions, so a surface can highlight them', () => {
    const [hit] = hostFuzzyFileSearch(repo, 'app')
    expect(hit!.indices).toHaveLength(3)
    // Subsequence, in order, and inside the real path.
    expect(hit!.indices!.every((index, i) => i === 0 || index > hit!.indices![i - 1]!)).toBe(true)
  })
})

describe('the boundaries', () => {
  it('answers nothing for an empty query rather than the whole repository', () => {
    expect(hostFuzzyFileSearch(repo, '   ')).toEqual([])
    expect(hostFuzzyFileSearch('', 'app')).toEqual([])
  })

  it('answers nothing when no path matches, instead of a best effort', () => {
    expect(hostFuzzyFileSearch(repo, 'zzqqnotarealname')).toEqual([])
  })

  /**
   * The non-repository arm, and the difference it carries: it walks with a fixed
   * skip list and does NOT read ignore files. `node_modules` is the case that
   * would otherwise dominate both the time and the results.
   */
  it('still finds files outside a repository, without descending into node_modules', () => {
    const paths = hostFuzzyFileSearch(plain, 'widget').map(hit => hit.path)
    expect(paths).toContain('src/widget.ts')
    expect(paths.some(path => path.includes('node_modules'))).toBe(false)
  })

  it('memoises the listing, so a burst of keystrokes costs one listing', () => {
    const first = hostFuzzyFileSearch(repo, 'appshell', 1_000)
    write(repo, 'src/app-shell-late.ts')
    // Same clock reading: inside the TTL, so the new file is not seen yet.
    expect(hostFuzzyFileSearch(repo, 'appshell', 1_000)).toHaveLength(first.length)
    // Past the TTL, it is.
    const later = hostFuzzyFileSearch(repo, 'appshell', 1_000 + 10_000).map(hit => hit.path)
    expect(later).toContain('src/app-shell-late.ts')
  })
})
