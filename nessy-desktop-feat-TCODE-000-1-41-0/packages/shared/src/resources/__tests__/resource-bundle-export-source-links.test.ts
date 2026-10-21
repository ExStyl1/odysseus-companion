/**
 * F1.576 — F1.575's rule for SOURCES: a source folder that is a LINK exports by where it
 * resolves. One that resolves inside the workspace exports; one that resolves outside it is
 * skipped with a warning (position and reason, never the name or the target).
 *
 * Measured on HEAD `9d276adec` (WJ-bo, `work/wjbo/probe-source-links.ts`, which extends WJ-bn's
 * S1/S2 arms in `work/wjbn/probe-links.ts`; a throwaway sandbox with HOME and NESSY_CONFIG_DIR
 * exported inside it before bun started), `sources: ['real']` the control:
 *
 *  - an explicit selection FOLLOWED every link: `sources: ['srcout']` (absolute, outside) and
 *    `['relout']` (relative, outside) exported the target's `config.json` and files;
 *  - `['self']` (a link to the workspace root) exported the workspace's own `config.json` as
 *    the entry's config and every file under the workspace as its files, session transcripts
 *    included, in a bundle that validated;
 *  - a `sources/` folder that is itself a link out of the workspace exported through the
 *    explicit selection AND through `'all'`;
 *  - `'all'` lists real folders only, as the source loader's own listing
 *    (`loadWorkspaceSources`) does, so a link is never listed there.
 *
 * DECIDED by the controller: the same real-path containment F1.575 applied to skills. The
 * folder's REAL path must lie strictly below the workspace's real path, so a link anywhere on
 * the way counts (the `sources/` case) and the root itself is not inside. The `'all'` listing
 * is unchanged, because it already mirrors the loader. The temp root sits under `/var`, itself
 * a link on macOS, so every case here exercises the real-path comparison on both sides.
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

/** A minimal valid api source config whose display name carries a marker. */
const SOURCE = (slug: string, marker: string) => JSON.stringify({
  id: `${slug}_1`, name: marker, slug, enabled: true, provider: 'x', type: 'api',
  api: { baseUrl: 'https://x.test', authType: 'none' },
})

/** Every config and DECODED file the bundle's sources carry, so a leak anywhere counts. */
function carried(result: ExportResult): string {
  return (result.bundle.resources.sources ?? [])
    .flatMap(e => [JSON.stringify(e.config), ...e.files.map(f => Buffer.from(f.contentBase64, 'base64').toString('utf-8'))])
    .join('\n')
}

const slugs = (result: ExportResult) => (result.bundle.resources.sources ?? []).map(e => e.slug).sort()

describe('F1.576 — a source-folder link exports by where it resolves, on both export paths', () => {
  let root: string
  let ws: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wjbo-f1576-'))
    // <root> stands in for the app config dir: a source-shaped folder OUTSIDE every workspace.
    put(join(root, 'outside-source', 'config.json'), SOURCE('srcout', 'OUTSIDE-CONFIG'))
    put(join(root, 'outside-source', 'guide.md'), 'OUTSIDE-SOURCE-MARKER')

    ws = join(root, 'workspaces', 'my-ws')
    put(join(ws, 'config.json'), JSON.stringify({ name: 'WS-CONFIG-MARKER' }))
    put(join(ws, 'sessions', 's1', 'session.jsonl'), 'WS-SESSION-MARKER')
    put(join(ws, 'sources', 'real', 'config.json'), SOURCE('real', 'REAL-CONFIG'))
    put(join(ws, 'sources', 'real', 'guide.md'), 'REAL-MARKER')
    put(join(ws, 'library', 'inner', 'config.json'), SOURCE('in', 'INSIDE-CONFIG'))
    put(join(ws, 'library', 'inner', 'guide.md'), 'INSIDE-LINK-MARKER')
    symlinkSync(join(ws, 'library', 'inner'), join(ws, 'sources', 'in'))
    symlinkSync(join(root, 'outside-source'), join(ws, 'sources', 'srcout'))
    symlinkSync(join('..', '..', '..', 'outside-source'), join(ws, 'sources', 'relout'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('control — a real source folder exports as before, with no warning', () => {
    const result = exportResources(ws, { sources: ['real'] })
    expect(result.warnings).toEqual([])
    expect(slugs(result)).toEqual(['real'])
    const text = carried(result)
    expect(text).toContain('REAL-CONFIG')
    expect(text).toContain('REAL-MARKER')
    expect(validateResourceBundle(result.bundle)).toEqual({ valid: true, errors: [] })
  })

  it('an explicit selection of a link resolving OUTSIDE (absolute or relative) is skipped with a warning by position', () => {
    const result = exportResources(ws, { sources: ['real', 'srcout', 'relout'] })
    expect(slugs(result)).toEqual(['real'])
    const text = carried(result)
    expect(text).not.toContain('OUTSIDE-CONFIG')
    expect(text).not.toContain('OUTSIDE-SOURCE-MARKER')
    expect(result.warnings).toEqual([
      'sources[1]: does not resolve inside the workspace, skipping',
      'sources[2]: does not resolve inside the workspace, skipping',
    ])
    // Never the name, never the target: the caller learns the position and the reason only.
    expect(result.warnings.join('\n')).not.toMatch(/srcout|relout|outside-source/)
    expect(validateResourceBundle(result.bundle)).toEqual({ valid: true, errors: [] })
  })

  it('an explicit selection of a link resolving INSIDE the workspace exports its folder', () => {
    const result = exportResources(ws, { sources: ['in'] })
    expect(result.warnings).toEqual([])
    expect(slugs(result)).toEqual(['in'])
    expect(carried(result)).toContain('INSIDE-LINK-MARKER')
  })

  it('a link to the workspace root itself is not inside it — skipped, the workspace config and transcripts are not read out', () => {
    symlinkSync('..', join(ws, 'sources', 'self'))
    const result = exportResources(ws, { sources: ['self'] })
    expect(slugs(result)).toEqual([])
    const text = carried(result)
    expect(text).not.toContain('WS-CONFIG-MARKER')
    expect(text).not.toContain('WS-SESSION-MARKER')
    expect(result.warnings).toEqual(['sources[0]: does not resolve inside the workspace, skipping'])
  })

  it('a sources/ folder that is itself a link out of the workspace is refused on both paths', () => {
    put(join(root, 'shared-sources', 'shared', 'config.json'), SOURCE('shared', 'SHARED-CONFIG'))
    put(join(root, 'shared-sources', 'shared', 'guide.md'), 'SHARED-SOURCES-DIR-MARKER')
    const wsB = join(root, 'workspaces', 'ws-b')
    mkdirSync(wsB, { recursive: true })
    symlinkSync(join(root, 'shared-sources'), join(wsB, 'sources'))
    const selections: (string[] | 'all')[] = [['shared'], 'all']
    for (const selection of selections) {
      const result = exportResources(wsB, { sources: selection })
      expect(slugs(result)).toEqual([])
      const text = carried(result)
      expect(text).not.toContain('SHARED-CONFIG')
      expect(text).not.toContain('SHARED-SOURCES-DIR-MARKER')
      expect(result.warnings).toEqual(['sources[0]: does not resolve inside the workspace, skipping'])
    }
  })

  it('an explicit selection naming a FILE under sources/ is skipped as not a folder', () => {
    put(join(ws, 'sources', 'plain.txt'), 'PLAIN-FILE')
    const result = exportResources(ws, { sources: ['plain.txt', 'real'] })
    expect(slugs(result)).toEqual(['real'])
    expect(result.warnings).toEqual(["Source 'plain.txt' is not a folder, skipping"])
  })

  it("unchanged: 'all' lists real folders only, as the source loader does; a dangling link is \"not found\"; links INSIDE a source folder are not followed", () => {
    symlinkSync(join(root, 'nowhere'), join(ws, 'sources', 'dangling'))
    symlinkSync(join(root, 'outside-source', 'guide.md'), join(ws, 'sources', 'real', 'f.md'))

    const all = exportResources(ws, { sources: 'all' })
    expect(slugs(all)).toEqual(['real'])
    expect(all.warnings).toEqual([])
    expect(carried(all)).not.toContain('OUTSIDE-SOURCE-MARKER')
    expect(all.bundle.resources.sources?.[0]?.files.map(f => f.relativePath)).toEqual(['guide.md'])

    const explicit = exportResources(ws, { sources: ['dangling', 'real'] })
    expect(explicit.warnings).toEqual(["Source 'dangling' not found, skipping"])
    expect(slugs(explicit)).toEqual(['real'])
  })
})
