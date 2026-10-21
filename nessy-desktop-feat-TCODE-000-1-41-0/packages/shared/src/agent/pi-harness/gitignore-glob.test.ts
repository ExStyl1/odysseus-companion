import { describe, expect, test } from 'bun:test'
import { matchGitignoreGlob } from './gitignore-glob.ts'

describe('matchGitignoreGlob', () => {
  // Plan table (R1 Task 3) — documented examples and stated boundaries.
  const cases: Array<[pattern: string, relPath: string, opts: { anyDepth: boolean }, want: boolean]> = [
    ['src/**',      'src/a.ts',            { anyDepth: false }, true],
    ['src/**',      'lib/src/a.ts',        { anyDepth: false }, false],
    ['secrets/**',  'a/b/secrets/key.pem', { anyDepth: true  }, true],
    ['.env',        'deep/nested/.env',    { anyDepth: true  }, true],   // bare filename ≡ **/.env
    ['.env',        '.env',                { anyDepth: false }, true],
    ['*.ts',        'a.ts',                { anyDepth: false }, true],
    ['*.ts',        'src/a.ts',            { anyDepth: false }, false],  // * is single-segment
    ['src/*/gen',   'src/x/gen',           { anyDepth: false }, true],
    ['src/*/gen',   'src/x/y/gen',         { anyDepth: false }, false],
  ]

  test.each(cases)('%s vs %s (%o) -> %p', (pattern, relPath, opts, want) => {
    expect(matchGitignoreGlob(pattern, relPath, opts)).toBe(want)
  })

  const extraCases: Array<[pattern: string, relPath: string, opts: { anyDepth: boolean }, want: boolean]> = [
    // A literal bare filename floats in EVERY rule type (permissions.md:
    // "Read(.env) and Read(**/.env) are equivalent").
    ['.env',        'deep/nested/.env',    { anyDepth: false }, true],
    // Trailing /** also matches the named directory itself.
    ['src/**',      'src',                 { anyDepth: false }, true],
    ['src/**',      'srcx',                { anyDepth: false }, false],
    // Explicit ** patterns match at any depth in every rule type.
    ['**/src/**',   'vendor/pkg/src/lib.js', { anyDepth: false }, true],
    ['**/.env',     'deep/.env',           { anyDepth: false }, true],
    // ? matches exactly one character within a segment.
    ['a?.ts',       'ab.ts',               { anyDepth: false }, true],
    ['a?.ts',       'a/b.ts',              { anyDepth: false }, false],
    // anyDepth floats wildcard patterns too.
    ['*.pem',       'a/b/key.pem',         { anyDepth: true  }, true],
    ['*.pem',       'a/b/key.pem',         { anyDepth: false }, false],
    // ** spans zero segments.
    ['src/**/gen',  'src/gen',             { anyDepth: false }, true],
    ['src/**/gen',  'src/a/b/gen',         { anyDepth: false }, true],
    // Character classes are NOT documented glob syntax: [ is literal.
    ['a[1].ts',     'a[1].ts',             { anyDepth: false }, true],
    ['a[1].ts',     'a1.ts',               { anyDepth: false }, false],
  ]

  test.each(extraCases)('extra: %s vs %s (%o) -> %p', (pattern, relPath, opts, want) => {
    expect(matchGitignoreGlob(pattern, relPath, opts)).toBe(want)
  })
})
