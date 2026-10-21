import { describe, expect, it } from 'bun:test'
import {
  parseWorktreeInclude,
  worktreeIncludeCandidateCommands,
  worktreeIncludePlan,
} from './worktree-include-plan'

const repoRoot = '/projects/app'
const worktreePath = '/projects/.nessy-worktrees/app/lease-1'

// The doc's own example file (worktrees.md:150-162), verbatim.
const DOC_EXAMPLE = [
  '# Local environment',
  '.env',
  '.env.local',
  '',
  '# API credentials',
  'config/secrets.json',
].join('\n')

describe('.worktreeinclude parsing (worktrees.md:150-162)', () => {
  it('parses the documented example: comments and blank lines ignored', () => {
    expect(parseWorktreeInclude(DOC_EXAMPLE)).toEqual([
      { body: '.env', negated: false, anchored: false, directoryOnly: false },
      { body: '.env.local', negated: false, anchored: false, directoryOnly: false },
      { body: 'config/secrets.json', negated: false, anchored: false, directoryOnly: false },
    ])
  })

  it('records negation, anchoring and directory-only markers', () => {
    expect(parseWorktreeInclude('!.env.production\n/anchored.json\nlogs/\n')).toEqual([
      { body: '.env.production', negated: true, anchored: false, directoryOnly: false },
      { body: 'anchored.json', negated: false, anchored: true, directoryOnly: false },
      { body: 'logs', negated: false, anchored: false, directoryOnly: true },
    ])
  })

  const refused = [
    { name: 'a leading `..` segment', text: '../outside/.env' },
    { name: 'a nested `..` segment', text: 'config/../../escape' },
    { name: 'a drive-absolute entry', text: 'C:/secrets/.env' },
    { name: 'an entry over 512 characters', text: 'a'.repeat(513) },
    { name: 'more than 128 entries', text: Array.from({ length: 129 }, (_, i) => `file-${i}.env`).join('\n') },
  ]
  for (const row of refused) {
    it(`refuses ${row.name} at parse`, () => {
      expect(() => parseWorktreeInclude(row.text)).toThrow()
    })
  }
})

describe('candidate commands: git is the ignore engine', () => {
  it('lists ignored files with collapsed directories, then probes wildcard-free patterns', () => {
    const patterns = parseWorktreeInclude(`${DOC_EXAMPLE}\n.env*\n!.env.keep\nlogs/\n`)
    expect(worktreeIncludeCandidateCommands(repoRoot, patterns)).toEqual([
      {
        operation: 'include-list',
        cwd: 'repo',
        args: ['-C', repoRoot, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'],
        allowFailure: true,
      },
      // Wildcard-free, non-negated, non-directory patterns only: `.env*`
      // carries a wildcard, `!.env.keep` excludes, `logs/` names a directory.
      { operation: 'include-check-ignore', cwd: 'repo', args: ['-C', repoRoot, 'check-ignore', '-q', '--', '.env'], allowFailure: true, probePath: '.env' },
      { operation: 'include-check-ignore', cwd: 'repo', args: ['-C', repoRoot, 'check-ignore', '-q', '--', '.env.local'], allowFailure: true, probePath: '.env.local' },
      { operation: 'include-check-ignore', cwd: 'repo', args: ['-C', repoRoot, 'check-ignore', '-q', '--', 'config/secrets.json'], allowFailure: true, probePath: 'config/secrets.json' },
    ])
  })
})

describe('.worktreeinclude copy plan', () => {
  it('the documented example copies exactly its three files, nothing else', () => {
    const plan = worktreeIncludePlan({
      repoRoot,
      worktreePath,
      patterns: parseWorktreeInclude(DOC_EXAMPLE),
      ignoredEntries: [
        '.env',
        '.env.local',
        'config/secrets.json',
        // Extras a real ignored set carries; none may be planned.
        'node_modules/',
        'dist/',
        'coverage/lcov.info',
        '.DS_Store',
      ],
    })
    expect(plan).toEqual([
      { source: `${repoRoot}/.env`, destination: `${worktreePath}/.env` },
      { source: `${repoRoot}/.env.local`, destination: `${worktreePath}/.env.local` },
      { source: `${repoRoot}/config/secrets.json`, destination: `${worktreePath}/config/secrets.json` },
    ])
  })

  it('negation: the LAST matching pattern wins', () => {
    const plan = worktreeIncludePlan({
      repoRoot,
      worktreePath,
      patterns: parseWorktreeInclude('.env*\n!.env.production'),
      ignoredEntries: ['.env', '.env.local', '.env.production'],
    })
    expect(plan.map(copy => copy.source)).toEqual([
      `${repoRoot}/.env`,
      `${repoRoot}/.env.local`,
    ])
  })

  it('a matching path ABSENT from the ignored set is not planned: tracked files are never duplicated', () => {
    const plan = worktreeIncludePlan({
      repoRoot,
      worktreePath,
      patterns: parseWorktreeInclude('.env\nconfig/secrets.json'),
      // `config/secrets.json` matches a pattern but git says it is tracked
      // (not in the ignored output), so it must not be copied.
      ignoredEntries: ['.env'],
    })
    expect(plan).toEqual([
      { source: `${repoRoot}/.env`, destination: `${worktreePath}/.env` },
    ])
  })

  it('a pattern matching a collapsed ignored directory does not expand into it', () => {
    const plan = worktreeIncludePlan({
      repoRoot,
      worktreePath,
      patterns: parseWorktreeInclude('node_modules\nnode_modules/'),
      ignoredEntries: ['node_modules/'],
    })
    expect(plan).toEqual([])
  })

  it('every planned copy stays inside the checkout and the worktree', () => {
    const plan = worktreeIncludePlan({
      repoRoot,
      worktreePath,
      patterns: parseWorktreeInclude('.env*\nconfig/secrets.json'),
      // Hostile entries: candidate paths come from git output, but a copy
      // plan for secrets must not be steerable outside either root.
      ignoredEntries: ['.env', 'config/../../../etc/.env.local', '/etc/.env'],
    })
    for (const copy of plan) {
      expect(copy.source.startsWith(`${repoRoot}/`)).toBe(true)
      expect(copy.destination.startsWith(`${worktreePath}/`)).toBe(true)
    }
    expect(plan).toEqual([
      { source: `${repoRoot}/.env`, destination: `${worktreePath}/.env` },
    ])
  })
})
