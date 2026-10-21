/**
 * F1.575 — a skill folder that is a LINK exports by one rule on both export paths: a link
 * that resolves inside the workspace exports, one that resolves outside it is skipped with a
 * warning (position and reason, never the name or the target).
 *
 * Measured on HEAD `4aa61fe40` (WJ-bn, `work/wjbn/probe-links.ts`, a throwaway sandbox with
 * HOME and NESSY_CONFIG_DIR exported inside it before bun started; WJ-bj's R2a/R2b arms,
 * `work/wjbj/probe-residue.ts`, extended), `skills: ['real']` the control:
 *
 *  - an explicit selection FOLLOWED every link, so `skills: ['out']` (absolute, outside) and
 *    `['relout']` (relative, outside) exported the target's files, and `['self']` (a link to
 *    the workspace root) exported the whole workspace, its `config.json` included;
 *  - `skills: 'all'` DROPPED every link silently (its listing kept `Dirent.isDirectory()`,
 *    false for a link), the inside ones too, while the skill loader (`isSkillDirEntry` in
 *    `skills/storage.ts`) follows a link to a folder on purpose;
 *  - a `skills/` folder that is itself a link out of the workspace exported through both;
 *  - an explicit selection naming a FILE under `skills/` threw ENOTDIR and failed the whole
 *    export (a residue of the same read, fixed with it).
 *
 * DECIDED by the controller (safety over symmetry for an EXPORT, which hands contents to a
 * caller); the loader is unchanged. Containment is taken on the folder's REAL path against
 * the workspace's real path, so a link anywhere on the way counts (the `skills/` case), and
 * the files are then read from that checked path. The temp root sits under `/var`, itself a
 * link on macOS, so the real-path comparison is exercised on both sides by every case here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { exportResources, validateResourceBundle } from '../resource-bundle'
import type { ExportResult } from '../types'

function put(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const SKILL_MD = (marker: string) => `---\nname: s\ndescription: s\n---\n${marker}`
const OUTSIDE = /^skills\[\d+\]: does not resolve inside the workspace, skipping$/

/** Every DECODED file the bundle's skills carry, so a leak inside a file counts. */
function carried(result: ExportResult): string {
  return (result.bundle.resources.skills ?? [])
    .flatMap(e => e.files.map(f => Buffer.from(f.contentBase64, 'base64').toString('utf-8')))
    .join('\n')
}

const slugs = (result: ExportResult) => (result.bundle.resources.skills ?? []).map(e => e.slug).sort()

describe('F1.575 — a skill-folder link exports by where it resolves, on both export paths', () => {
  let root: string
  let ws: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wjbn-f1575-'))
    // <root> stands in for the app config dir: a skill-shaped folder OUTSIDE every workspace.
    put(join(root, 'outside-target', 'SKILL.md'), SKILL_MD('OUTSIDE-LINK-MARKER'))

    ws = join(root, 'workspaces', 'my-ws')
    put(join(ws, 'config.json'), JSON.stringify({ name: 'WS-CONFIG-MARKER' }))
    put(join(ws, 'skills', 'real', 'SKILL.md'), SKILL_MD('REAL-MARKER'))
    put(join(ws, 'library', 'inner', 'SKILL.md'), SKILL_MD('INSIDE-LINK-MARKER'))
    symlinkSync(join(ws, 'library', 'inner'), join(ws, 'skills', 'in'))
    symlinkSync(join(root, 'outside-target'), join(ws, 'skills', 'out'))
    symlinkSync(join('..', '..', '..', 'outside-target'), join(ws, 'skills', 'relout'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('control — a real skill folder exports as before, with no warning', () => {
    const result = exportResources(ws, { skills: ['real'] })
    expect(result.warnings).toEqual([])
    expect(slugs(result)).toEqual(['real'])
    expect(carried(result)).toContain('REAL-MARKER')
  })

  it('an explicit selection of a link resolving INSIDE the workspace exports its folder', () => {
    const result = exportResources(ws, { skills: ['in'] })
    expect(result.warnings).toEqual([])
    expect(slugs(result)).toEqual(['in'])
    expect(carried(result)).toContain('INSIDE-LINK-MARKER')
  })

  it('an explicit selection of a link resolving OUTSIDE (absolute or relative) is skipped with a warning by position', () => {
    const result = exportResources(ws, { skills: ['real', 'out', 'relout'] })
    expect(slugs(result)).toEqual(['real'])
    expect(carried(result)).not.toContain('OUTSIDE-LINK-MARKER')
    expect(result.warnings).toEqual([
      'skills[1]: does not resolve inside the workspace, skipping',
      'skills[2]: does not resolve inside the workspace, skipping',
    ])
    // Never the name, never the target: the caller learns the position and the reason only.
    expect(result.warnings.join('\n')).not.toMatch(/out'|relout|outside-target/)
    expect(validateResourceBundle(result.bundle)).toEqual({ valid: true, errors: [] })
  })

  it("'all' exports a link resolving inside and skips one resolving outside with a warning — the same rule", () => {
    const result = exportResources(ws, { skills: 'all' })
    expect(slugs(result)).toEqual(['in', 'real'])
    const text = carried(result)
    expect(text).toContain('INSIDE-LINK-MARKER')
    expect(text).not.toContain('OUTSIDE-LINK-MARKER')
    expect(result.warnings).toHaveLength(2)
    for (const warning of result.warnings) expect(warning).toMatch(OUTSIDE)
    expect(validateResourceBundle(result.bundle)).toEqual({ valid: true, errors: [] })
  })

  it('a link to the workspace root itself is not inside it — skipped, the workspace config is not read out', () => {
    put(join(ws, 'SKILL.md'), SKILL_MD('WS-ROOT-SKILLMD-MARKER'))
    symlinkSync('..', join(ws, 'skills', 'self'))
    const selections: (string[] | 'all')[] = [['self'], 'all']
    for (const selection of selections) {
      const result = exportResources(ws, { skills: selection })
      expect(slugs(result)).not.toContain('self')
      expect(carried(result)).not.toContain('WS-CONFIG-MARKER')
      expect(carried(result)).not.toContain('WS-ROOT-SKILLMD-MARKER')
    }
  })

  it('a skills/ folder that is itself a link out of the workspace is refused on both paths', () => {
    put(join(root, 'shared-skills', 'shared', 'SKILL.md'), SKILL_MD('SHARED-SKILLS-DIR-MARKER'))
    const wsB = join(root, 'workspaces', 'ws-b')
    mkdirSync(wsB, { recursive: true })
    symlinkSync(join(root, 'shared-skills'), join(wsB, 'skills'))
    const selections: (string[] | 'all')[] = [['shared'], 'all']
    for (const selection of selections) {
      const result = exportResources(wsB, { skills: selection })
      expect(slugs(result)).toEqual([])
      expect(carried(result)).not.toContain('SHARED-SKILLS-DIR-MARKER')
      expect(result.warnings).toEqual(['skills[0]: does not resolve inside the workspace, skipping'])
    }
  })

  it('an explicit selection naming a FILE under skills/ is skipped with a warning instead of failing the export', () => {
    put(join(ws, 'skills', 'plain.txt'), 'PLAIN-FILE')
    const result = exportResources(ws, { skills: ['plain.txt', 'real'] })
    expect(slugs(result)).toEqual(['real'])
    expect(result.warnings).toEqual(["Skill 'plain.txt' is not a folder, skipping"])
  })

  it('unchanged: a dangling link is dropped from the listing and "not found" when selected; links INSIDE a skill folder are not followed', () => {
    symlinkSync(join(root, 'nowhere'), join(ws, 'skills', 'dangling'))
    symlinkSync(join(root, 'outside-target'), join(ws, 'skills', 'real', 'sub'))
    symlinkSync(join(root, 'outside-target', 'SKILL.md'), join(ws, 'skills', 'real', 'f.md'))

    const explicit = exportResources(ws, { skills: ['dangling', 'real'] })
    expect(explicit.warnings).toEqual(["Skill 'dangling' not found, skipping"])
    expect(slugs(explicit)).toEqual(['real'])
    expect(carried(explicit)).not.toContain('OUTSIDE-LINK-MARKER')

    const all = exportResources(ws, { skills: 'all' })
    expect(slugs(all)).not.toContain('dangling')
    expect(all.warnings.some(w => w.includes('dangling'))).toBe(false)
  })
})
