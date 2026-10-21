import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SAFE_MODE_CONFIG, type PermissionMode } from '../mode-types.ts'
import {
  describeProtectedPathWrite,
  findProtectedPathWrite,
  PROTECTED_DIRECTORIES,
  PROTECTED_FILES,
  protectedPathOutcome,
  type ProtectedPathOutcome,
} from './protected-paths.ts'

// Every path in this file hangs off a fixture root this test created. The floor
// itself touches no filesystem, but a protected-path suite that named the
// developer's real `~/.npmrc` or `~/.zshrc` would be one typo away from a test
// that edits the machine it runs on.
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'protected-paths-'))
afterAll(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }))

const at = (...parts: string[]) => join(FIXTURE_ROOT, ...parts)

describe('findProtectedPathWrite — fires', () => {
  test('every documented directory, at any depth', () => {
    for (const entry of PROTECTED_DIRECTORIES) {
      const hit = findProtectedPathWrite(at('project', ...entry.split('/'), 'settings.json'))
      expect(hit?.entry, entry).toBe(entry)
      expect(hit?.kind, entry).toBe('directory')
    }
  })

  test('every documented file, by basename', () => {
    for (const entry of PROTECTED_FILES) {
      const hit = findProtectedPathWrite(at('project', 'nested', entry))
      expect(hit?.entry, entry).toBe(entry)
      expect(hit?.kind, entry).toBe('file')
    }
  })

  test('a relative or ~-prefixed target, before the gate expands it', () => {
    expect(findProtectedPathWrite('.npmrc')?.entry).toBe('.npmrc')
    expect(findProtectedPathWrite('~/.zshrc')?.entry).toBe('.zshrc')
    expect(findProtectedPathWrite('./.git/config')?.entry).toBe('.git')
  })

  test('a windows-separated target', () => {
    expect(findProtectedPathWrite('C:\\repo\\.husky\\pre-commit')?.entry).toBe('.husky')
  })

  test('`.codex`, codex\'s own project config root, on every runtime', () => {
    expect(findProtectedPathWrite(at('.codex', 'rules', 'x.rules'))?.entry).toBe('.codex')
    expect(findProtectedPathWrite(at('.codex', 'config.toml'))?.entry).toBe('.codex')
    // No `worktrees` carve-out here — codex stores none under `.codex`.
    expect(findProtectedPathWrite(at('.codex', 'worktrees', 'a.ts'))?.entry).toBe('.codex')
  })

  test('`.config/git` needs both segments, in order', () => {
    expect(findProtectedPathWrite(at('.config', 'git', 'config'))?.entry).toBe('.config/git')
    // A bare `git/` directory is not the protected entry.
    expect(findProtectedPathWrite(at('vendor', 'git', 'config'))).toBeNull()
  })
})

describe('findProtectedPathWrite — does not fire', () => {
  test('the documented `.claude/worktrees` exception and our mirrors', () => {
    for (const dir of ['.claude', '.nessy-agent', '.agents']) {
      expect(findProtectedPathWrite(at(dir, 'worktrees', 'lease-1', 'src', 'a.ts')), dir).toBeNull()
    }
  })

  test('an ordinary sibling of a protected entry', () => {
    for (const target of [
      at('project', 'src', 'index.ts'),
      at('project', '.gitignore'),
      at('project', '.gitkeep'),
      at('project', 'npmrc'),
      at('project', '.vscode-extra', 'settings.json'),
      at('project', 'lefthook.toml'),
    ]) {
      expect(findProtectedPathWrite(target), target).toBeNull()
    }
  })

  test('an empty or missing target', () => {
    expect(findProtectedPathWrite(undefined)).toBeNull()
    expect(findProtectedPathWrite('')).toBeNull()
    expect(findProtectedPathWrite('   ')).toBeNull()
  })

  test('the exception does not leak to a directory that has none', () => {
    // Only `.claude` and our two mirrors carry a carve-out; `.git/worktrees` is
    // still git metadata.
    expect(findProtectedPathWrite(at('.git', 'worktrees', 'w', 'HEAD'))?.entry).toBe('.git')
  })
})

// OUR per-mode outcomes, not a transcription of the page's table — two rows
// deviate from it deliberately and `protectedPathOutcome`'s docstring carries the
// argument: `plan` prompts where the page allows/classifies, and `auto`'s prompt
// reaches the human rather than the classifier. Both deviations are toward the
// strict side, and asserting them HERE is the point: a test that merely echoed
// the page would go red the next time the page moves, and a test that echoed the
// code would assert nothing.
//
// The page's own table is `permission-modes.md:519`-`:525` — header row
// "| Mode | Protected-path writes |" on `:519`, closing row
// "| `bypassPermissions` | Allowed |" on `:525` — on the 2026-08-25 fetch (598
// lines, md5 44fa3a908750c261d5d5282377350a88). Two earlier numbers for the same
// table are recorded because both decayed: `:435`-`:441` (2026-07-30) and
// `:533`-`:539` (2026-08-23), the latter now spanning the protected-FILES list.
//
// The five documented rows are not interchangeable — the whole reason to
// table-drive this is that `dontAsk` denies where `bypassPermissions` allows, and
// collapsing them is the documented trap. Ours has six rows rather than five
// for a reason that is not a deviation: the page pairs `default` and
// `acceptEdits` in one row (F1.1050 removed the retired `explore` row).
describe('protectedPathOutcome — the per-mode table', () => {
  const expected: Array<[PermissionMode, ProtectedPathOutcome]> = [
    ['default', 'prompt'],
    ['acceptEdits', 'prompt'],
    ['plan', 'prompt'],
    ['auto', 'prompt'],
    ['dontAsk', 'deny'],
    ['bypassPermissions', 'allow'],
  ]

  for (const [mode, outcome] of expected) {
    test(`${mode} -> ${outcome}`, () => {
      expect(protectedPathOutcome(mode)).toBe(outcome)
    })
  }

  test('dontAsk and allow-all are opposite answers', () => {
    expect(protectedPathOutcome('dontAsk')).not.toBe(protectedPathOutcome('bypassPermissions'))
  })
})

describe('describeProtectedPathWrite', () => {
  test('names the entry and says why a permission rule does not skip it', () => {
    const hit = findProtectedPathWrite(at('project', '.claude', 'settings.json'))
    if (!hit) throw new Error('expected a hit')
    const description = describeProtectedPathWrite(hit)
    expect(description).toContain('.claude')
    expect(description).toContain('does not skip this prompt')
    expect(description).toContain('before those rules are read')
  })
})

/**
 * D1.261 — EXACTLY ONE of the protected FILES is also on the credential deny
 * floor, and it is the one name a live drive happened to choose.
 *
 * RS-55 (measure sitting 3, packaged 1.39.0) drove a codex turn writing
 * `<workspace>/.npmrc` and measured NO approval card and NO file on disk: codex
 * refused the write, and its own account named the rule — a permission denial
 * for `.npmrc` GLOBS in the workspace. That is this floor's neighbour, not this
 * floor: a double-star glob over the `.npmrc` basename is an entry of the
 * credential deny list (`SAFE_MODE_CONFIG.deniedPaths`, shipped as
 * `apps/electron/resources/permissions/default.json`), which `CodexAgent` mirrors
 * into codex's own `deniedReadPatterns` and which codex enforces through the OS.
 * `PROTECTED_FILES` itself never travels — `codexProtectedWorkspaceSubpaths`
 * projects `PROTECTED_DIRECTORIES` and says in its own docblock that the files
 * are deliberately left behind.
 *
 * So the subject of that drive was the ONE protected file whose codex refusal
 * has another cause, and a reading taken on it does not generalise to the other
 * thirty-six: `bunfig.toml`, `pyrightconfig.json`, `.mcp.json`, every shell rc.
 * This test is that number, derived at test time from both lists rather than
 * transcribed, so the next lane reading the sitting does not widen one file's
 * verdict into a capability claim — and so the next drive picks a subject this
 * list does NOT cover.
 */
describe('the protected FILES against the credential deny floor (D1.261)', () => {
  test('exactly one protected FILE is also denied by the credential floor', () => {
    const floor = new Set(SAFE_MODE_CONFIG.deniedPaths ?? [])
    // Non-vacuity first: an empty floor would make the intersection empty and
    // the assertion below would read as "none overlap" rather than "nothing was
    // read".
    expect(floor.size).toBeGreaterThan(0)
    expect(PROTECTED_FILES.length).toBeGreaterThan(30)
    const covered = PROTECTED_FILES.filter(name => floor.has(`**/${name}`))
    expect(covered).toEqual(['.npmrc'])
    // The negative control, by name, because it is also the recommendation: a
    // protected file the credential floor does NOT carry is what a re-drive of
    // the codex arm has to use.
    expect(floor.has('**/bunfig.toml')).toBe(false)
    expect(floor.has('**/pyrightconfig.json')).toBe(false)
  })

  test('the shipped floor and the in-package floor are the same list', () => {
    // The guard above is only about what a PACKAGED build does while these two
    // agree — the resource is what a packaged session actually loads.
    const shipped: string[] = JSON.parse(readFileSync(
      new URL('../../../../../apps/electron/resources/permissions/default.json', import.meta.url),
      'utf8',
    )).deniedPaths
    expect(shipped).toEqual([...(SAFE_MODE_CONFIG.deniedPaths ?? [])])
  })
})
