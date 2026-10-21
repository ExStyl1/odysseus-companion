/**
 * F1.544 — a resource bundle's slug can only ever name a folder DIRECTLY inside
 * `<workspace>/sources` or `<workspace>/skills`, and nothing is written before that holds.
 *
 * Measured on HEAD `38cd65923` (WJ-bc, `work/wjbc/probe-traversal.ts`, a throwaway
 * sandbox with HOME and NESSY_CONFIG_DIR exported inside it before bun started):
 *
 *  - SOURCES: an entry `{ slug: 'a/../../../escaped-parent/child', config: <no slug> }`
 *    passed `validateResourceBundle` (it compares `config.slug` to the entry's only when
 *    `config.slug` is a string), and `importSources` built its staging folder from the raw
 *    slug — `join(sourcesDir, '.tmp-<slug>-<uuid>')` — OUTSIDE the workspace, wrote
 *    config.json and the bundle's files there (fs.watch saw
 *    `escaped-parent/child-<uuid>/payload.md`), then failed `validateSourceConfig` and
 *    removed only the leaf. The `escaped-parent/` folder that `mkdirSync({ recursive })`
 *    created on the way stayed behind.
 *  - SKILLS (a sibling, worse, fixed in the same place): `importSkills` validates nothing
 *    about the slug, so `a/../../../skill-escape` IMPORTED — a SKILL.md written outside
 *    the workspace for good — and in `overwrite` mode `a/../../../decoy` ran
 *    `rmSync(<outside folder>, { recursive: true })` first: a pre-existing folder outside
 *    the workspace and its file were DELETED and replaced by the bundle's content.
 *
 * The rule is `classifySourceSlug` (`protocol/source-slugs.ts`) — a containment test, not
 * a spelling test, so every folder name the exporter can read still round-trips — checked
 * in `validateResourceBundle`, which runs before `importResources` writes anything; the
 * write sites then refuse any target or staging path that does not RESOLVE to a direct
 * child (`directChildPath`), a second fence that nothing in-tree can reach today.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { importResources, validateResourceBundle, directChildPath } from '../resource-bundle'
import type { ResourceBundle } from '../types'

const noopDeps = { clearSourceCredentials: async () => {} }

function bundleFile(path: string, content: string) {
  const buf = Buffer.from(content)
  return { relativePath: path, contentBase64: buf.toString('base64'), size: buf.length }
}

const SKILL_MD = '---\nname: s\ndescription: s\n---\nInstructions.'

function validSourceConfig(slug: string) {
  return {
    id: `${slug}_1`, name: slug, slug, enabled: true, provider: 'x', type: 'api',
    api: { baseUrl: 'https://api.example.test', authType: 'none' },
  }
}

function bundle(resources: Record<string, unknown>): ResourceBundle {
  return { version: 1, exportedAt: Date.now(), resources } as unknown as ResourceBundle
}

/** Every path under `dir`, folders with a trailing slash — the whole tree, so a leftover folder counts. */
function tree(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    out.push(e.isDirectory() ? `${rel}/` : rel)
    if (e.isDirectory()) out.push(...tree(join(dir, e.name), rel))
  }
  return out.sort()
}

describe('F1.544 — bundle slugs are contained before anything is written', () => {
  let root: string
  let ws: string
  let decoy: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wjbc-f1544-'))
    ws = join(root, 'ws')
    mkdirSync(join(ws, 'sources'), { recursive: true })
    mkdirSync(join(ws, 'skills'), { recursive: true })
    // A folder OUTSIDE the workspace, with content, that a traversal could name.
    decoy = join(root, 'decoy')
    mkdirSync(decoy)
    writeFileSync(join(decoy, 'precious.txt'), 'must survive')
  })

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true })
  })

  /** Everything under `root` that is not inside the workspace. */
  function outsideWorkspace(): string[] {
    return tree(root).filter(p => p !== 'ws/' && !p.startsWith('ws/'))
  }

  it('a source slug with dot segments leaves nothing outside the workspace, not even a folder', async () => {
    const before = outsideWorkspace()
    const result = await importResources(ws, bundle({
      sources: [{
        slug: 'a/../../../escaped-parent/child',
        config: { ...validSourceConfig('x'), slug: undefined },
        files: [bundleFile('payload.md', 'must not land outside sources/')],
      }],
    }), 'skip', noopDeps)

    expect(outsideWorkspace()).toEqual(before)
    expect(result.sources.imported).toEqual([])
    expect(result.sources.failed).toHaveLength(1)
    expect(tree(join(ws, 'sources'))).toEqual([])
  })

  it('a skill slug with dot segments is refused, not imported outside the workspace', async () => {
    const before = outsideWorkspace()
    const result = await importResources(ws, bundle({
      skills: [{ slug: 'a/../../../skill-escape', files: [bundleFile('SKILL.md', SKILL_MD)] }],
    }), 'skip', noopDeps)

    expect(result.skills.imported).toEqual([])
    expect(result.skills.failed).toHaveLength(1)
    expect(outsideWorkspace()).toEqual(before)
    expect(existsSync(join(root, 'skill-escape'))).toBe(false)
  })

  it('overwrite mode cannot delete a folder outside the workspace through a skill slug', async () => {
    const result = await importResources(ws, bundle({
      skills: [{ slug: 'a/../../../decoy', files: [bundleFile('SKILL.md', SKILL_MD)] }],
    }), 'overwrite', noopDeps)

    expect(result.skills.imported).toEqual([])
    expect(readFileSync(join(decoy, 'precious.txt'), 'utf-8')).toBe('must survive')
    expect(existsSync(join(decoy, 'SKILL.md'))).toBe(false)
  })

  it('control, same rig: a clean bundle still imports a source and a skill as before', async () => {
    const result = await importResources(ws, bundle({
      sources: [{ slug: 'good', config: validSourceConfig('good'), files: [bundleFile('guide.md', '# good')] }],
      skills: [{ slug: 'good-skill', files: [bundleFile('SKILL.md', SKILL_MD)] }],
    }), 'skip', noopDeps)

    expect(result.sources.imported).toEqual(['good'])
    expect(result.skills.imported).toEqual(['good-skill'])
    expect(readFileSync(join(ws, 'sources', 'good', 'guide.md'), 'utf-8')).toBe('# good')
    expect(existsSync(join(ws, 'skills', 'good-skill', 'SKILL.md'))).toBe(true)
    expect(outsideWorkspace()).toEqual(['decoy/', 'decoy/precious.txt'])
  })
})

describe('F1.544 — validateResourceBundle: one folder name per slug, reported by position and reason', () => {
  const REFUSED = ['..', '.', 'a/b', 'a\\b', 'a/../../x', ' ', 'tab\there']

  for (const slug of REFUSED) {
    it(`refuses the source slug ${JSON.stringify(slug)} and the skill slug alike`, () => {
      const { valid, errors } = validateResourceBundle(bundle({
        sources: [{ slug, config: validSourceConfig('x'), files: [] }],
        skills: [{ slug, files: [bundleFile('SKILL.md', SKILL_MD)] }],
      }))
      expect(valid).toBe(false)
      expect(errors.some(e => e.startsWith('sources[0]: slug is not a single folder name'))).toBe(true)
      expect(errors.some(e => e.startsWith('skills[0]: slug is not a single folder name'))).toBe(true)
    })
  }

  it('the refusal carries the position and the reason, never the slug itself', () => {
    const { errors } = validateResourceBundle(bundle({
      skills: [{ slug: 'a/../../secret-place', files: [bundleFile('SKILL.md', SKILL_MD)] }],
    }))
    expect(errors).toEqual(['skills[0]: slug is not a single folder name (not-contained)'])
  })

  it('a containment rule, not a spelling rule: a folder name with dots or capitals still passes', () => {
    for (const slug of ['my.source', 'Notion Export', '.hidden-but-a-child', '..double-dot-prefix']) {
      const { valid, errors } = validateResourceBundle(bundle({
        sources: [{ slug, config: { ...validSourceConfig('x'), slug: undefined }, files: [] }],
        skills: [{ slug, files: [bundleFile('SKILL.md', SKILL_MD)] }],
      }))
      expect({ slug, valid, errors }).toEqual({ slug, valid: true, errors: [] })
    }
  })
})

describe('F1.544 — directChildPath, the fence at the write sites', () => {
  const dir = join(tmpdir(), 'wjbc-parent')

  it('returns the joined path for a direct child', () => {
    expect(directChildPath(dir, 'child')).toBe(join(dir, 'child'))
    expect(directChildPath(dir, '.tmp-child-1234abcd')).toBe(join(dir, '.tmp-child-1234abcd'))
  })

  it('throws for anything that resolves elsewhere — a parent, the folder itself, a grandchild', () => {
    for (const name of ['..', '.', '', 'a/b', 'a/../../x', '.tmp-a/../../../x-1234abcd']) {
      expect(() => directChildPath(dir, name)).toThrow('is not a folder directly inside')
    }
  })
})
