/**
 * F1.560 — the export twin of F1.544: a SELECTED source or skill slug must name a folder
 * DIRECTLY inside `<workspace>/sources` or `<workspace>/skills` before anything under it is read.
 *
 * `resources:export` takes its selection from the caller (any RPC client; the Send-to-workspace
 * dialog passes slugs chosen in the UI), and `exportSources` / `exportSkills` joined each one
 * unchecked. Measured on HEAD `c10caef38` (WJ-bj, `work/wjbj/probe-export.ts`, a throwaway
 * sandbox with HOME and NESSY_CONFIG_DIR exported inside it before bun started, every planted
 * file a marker string), with `{ sources: ['good'], skills: ['real'] }` as the control:
 *
 *  - `skills: ['../outside']` exported `<ws>/outside/SKILL.md` — the row's own control.
 *  - `skills: ['../../../outside-skill']` exported a folder in the APP config dir, every file.
 *  - `sources: ['../../..']` returned the APP config dir's `config.json` as the entry's
 *    `config` (only its runtime fields reset) and every non-hidden file under that dir as
 *    the entry's files: `credentials.enc` and every workspace's session transcripts.
 *  - `sources: ['..']` returned the workspace's own `config.json` and its whole tree.
 *  - `skills: [42]` threw from `join`, failing the whole export.
 *  - `skills: 'all'` enumerated a blank-named folder, and the import side (F1.544) then
 *    refused the WHOLE exported bundle for that one entry.
 *  - `skills: ['real', 'real']` exported two entries, and the import side refused the whole
 *    bundle for the repeat (`work/wjbj/probe-residue.ts`, on the fixed tree) — so a repeat is
 *    skipped with a warning too.
 *
 * The rule is the one F1.544 put on the import side: `classifySourceSlug` (a containment
 * test, not a spelling test), then `directChildPath` builds the folder. A refused slug is
 * skipped with a warning by position and reason, never by value.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { exportResources, validateResourceBundle } from '../resource-bundle'
import type { ExportResult } from '../types'

function put(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const SKILL_MD = (marker: string) => `---\nname: s\ndescription: s\n---\n${marker}`

/** Every string the bundle carries — configs and DECODED file contents — so a leak inside a file counts. */
function carried(result: ExportResult): string {
  const { sources = [], skills = [] } = result.bundle.resources
  return [
    ...sources.flatMap(e => [JSON.stringify(e.config), ...e.files.map(f => Buffer.from(f.contentBase64, 'base64').toString('utf-8'))]),
    ...skills.flatMap(e => e.files.map(f => Buffer.from(f.contentBase64, 'base64').toString('utf-8'))),
  ].join('\n')
}

describe('F1.560 — a selected export slug is contained before anything is read', () => {
  let root: string
  let ws: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wjbj-f1560-'))
    // <root> stands in for the app config dir: a config.json and a credentials file OUTSIDE every workspace.
    put(join(root, 'config.json'), JSON.stringify({ name: 'APP-CONFIG-MARKER' }))
    put(join(root, 'credentials.enc'), 'CREDENTIALS-MARKER')
    put(join(root, 'outside-skill', 'SKILL.md'), SKILL_MD('OUTSIDE-SKILL-MARKER'))

    ws = join(root, 'workspaces', 'my-ws')
    put(join(ws, 'config.json'), JSON.stringify({ name: 'WS-CONFIG-MARKER' }))
    put(join(ws, 'sessions', 's1', 'session.jsonl'), 'SESSION-MARKER')
    put(join(ws, 'sources', 'good', 'config.json'), JSON.stringify({
      id: 'good_1', name: 'Good', slug: 'good', enabled: true, provider: 'x', type: 'api',
      api: { baseUrl: 'https://api.example.test', authType: 'none' },
    }))
    put(join(ws, 'sources', 'good', 'guide.md'), '# good')
    put(join(ws, 'skills', 'real', 'SKILL.md'), SKILL_MD('REAL-SKILL'))
    // The row's control: a SKILL.md beside `skills/`, which `../outside` names.
    put(join(ws, 'outside', 'SKILL.md'), SKILL_MD('WS-OUTSIDE-MARKER'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('control — a selection of real slugs exports as before, with no warning', () => {
    const result = exportResources(ws, { sources: ['good'], skills: ['real'] })
    expect(result.bundle.resources.sources?.map(e => e.slug)).toEqual(['good'])
    expect(result.bundle.resources.sources?.[0]?.files.map(f => f.relativePath)).toEqual(['guide.md'])
    expect(result.bundle.resources.skills?.map(e => e.slug)).toEqual(['real'])
    expect(result.warnings).toEqual([])
    expect(validateResourceBundle(result.bundle)).toEqual({ valid: true, errors: [] })
  })

  it("the row's control — skills ['../outside'] with outside/SKILL.md present exports no entry and warns", () => {
    const result = exportResources(ws, { skills: ['../outside'] })
    expect(result.bundle.resources.skills).toEqual([])
    expect(carried(result)).not.toContain('WS-OUTSIDE-MARKER')
    expect(result.warnings).toEqual(['skills[0]: slug is not a single folder name (not-contained), skipping'])
  })

  it('a skill slug naming a folder outside the workspace reads nothing from it', () => {
    const result = exportResources(ws, { skills: ['../../../outside-skill'] })
    expect(result.bundle.resources.skills).toEqual([])
    expect(carried(result)).not.toContain('OUTSIDE-SKILL-MARKER')
  })

  it("sources ['../../..'] cannot return the enclosing config dir's config.json or its files", () => {
    const result = exportResources(ws, { sources: ['../../..'] })
    expect(result.bundle.resources.sources).toEqual([])
    const text = carried(result)
    expect(text).not.toContain('APP-CONFIG-MARKER')
    expect(text).not.toContain('CREDENTIALS-MARKER')
    expect(text).not.toContain('SESSION-MARKER')
    expect(result.warnings).toEqual(['sources[0]: slug is not a single folder name (not-contained), skipping'])
  })

  it("sources ['..'] cannot return the workspace's own config or tree", () => {
    const result = exportResources(ws, { sources: ['..'] })
    expect(result.bundle.resources.sources).toEqual([])
    expect(carried(result)).not.toContain('WS-CONFIG-MARKER')
    expect(carried(result)).not.toContain('SESSION-MARKER')
  })

  it('a refused slug beside a good one skips only itself, and the warning names its position, never its value', () => {
    const result = exportResources(ws, { skills: ['real', '../outside'], sources: ['good', '..'] })
    expect(result.bundle.resources.skills?.map(e => e.slug)).toEqual(['real'])
    expect(result.bundle.resources.sources?.map(e => e.slug)).toEqual(['good'])
    expect(result.warnings).toEqual([
      'sources[1]: slug is not a single folder name (not-contained), skipping',
      'skills[1]: slug is not a single folder name (not-contained), skipping',
    ])
    expect(result.warnings.join('\n')).not.toContain('outside')
    expect(validateResourceBundle(result.bundle)).toEqual({ valid: true, errors: [] })
  })

  it('a non-string selection entry is skipped with a warning instead of failing the whole export', () => {
    const result = exportResources(ws, { skills: [42 as unknown as string, 'real'] })
    expect(result.bundle.resources.skills?.map(e => e.slug)).toEqual(['real'])
    expect(result.warnings).toEqual(['skills[0]: slug is not a single folder name (not-a-string), skipping'])
  })

  it('a slug selected twice exports once, so the import side does not refuse the whole bundle for the repeat', () => {
    const result = exportResources(ws, { skills: ['real', 'real'], sources: ['good', 'good'] })
    expect(result.bundle.resources.skills?.map(e => e.slug)).toEqual(['real'])
    expect(result.bundle.resources.sources?.map(e => e.slug)).toEqual(['good'])
    expect(result.warnings).toEqual([
      'sources[1]: repeats an earlier entry, skipping',
      'skills[1]: repeats an earlier entry, skipping',
    ])
    expect(validateResourceBundle(result.bundle)).toEqual({ valid: true, errors: [] })
  })

  it("'all' skips a folder whose name the import side refuses, so the rest of the bundle stays importable", () => {
    put(join(ws, 'skills', '   ', 'SKILL.md'), SKILL_MD('BLANK'))
    const result = exportResources(ws, { skills: 'all' })
    expect(result.bundle.resources.skills?.map(e => e.slug)).toEqual(['real'])
    // The index is the folder's position in the directory listing, whose order the host decides.
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/^skills\[[01]\]: slug is not a single folder name \(blank\), skipping$/)
    expect(validateResourceBundle(result.bundle)).toEqual({ valid: true, errors: [] })
  })
})
