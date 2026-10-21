/**
 * F1.254 (a) — only an `X.Y.Z.md` file is a release note.
 *
 * `loadBundledReleaseNotes` kept every `*.md` in the notes directory, and `parseVersion` only
 * strips the extension, so a `next.md` (upstream ships exactly such a pending-notes template)
 * would have loaded as version "next", been synced into the config dir, and reached the
 * semver sort as NaN — with `getLatestReleaseVersion` free to return it. No such file ships
 * here today, so this is latent. Upstream (craft-agents-oss v0.13.4,
 * `packages/shared/src/release-notes/index.ts`, Apache-2.0) filters with
 * `/^\d+\.\d+\.\d+\.md$/`; this takes the same filter and the same exported predicate.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isReleaseNoteFilename } from '../index.ts'

describe('release-note filenames (F1.254 a)', () => {
  it('accepts a versioned note', () => {
    expect(isReleaseNoteFilename('1.41.0.md')).toBe(true)
    expect(isReleaseNoteFilename('0.4.10.md')).toBe(true)
  })

  it('refuses every other markdown file', () => {
    for (const name of ['next.md', 'README.md', '1.41.md', '1.41.0.md.bak', 'v1.41.0.md', '1.41.0-rc.1.md']) {
      expect(isReleaseNoteFilename(name)).toBe(false)
    }
  })

  it('is the filter the loader applies', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    expect(source).toContain('readdirSync(dir).filter(isReleaseNoteFilename)')
    expect(source).not.toContain("f.endsWith('.md')")
  })
})
