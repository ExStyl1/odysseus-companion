/**
 * UA6.6 — the Craft share-service guard. It forbids Craft's SERVICE, never
 * sharing as such.
 *
 * Upstream v0.13.4 publishes a Page by an anonymous POST to Craft's Cloudflare
 * pages-share Worker (`v0.13.4:packages/shared/src/pages/publisher.ts` lines
 * 1–435): a default base URL on Craft's host, overridable by an env knob, and the
 * Share UI behind a second env knob in `feature-flags.ts`. All of it is dropped
 * under reason (a), a Craft external service (plan manifest E; spec §3 and threat
 * S23). Page publishing itself is DEFERRED to the owner's internal artifact
 * service (UA6.7), so this guard names no share channel, key or field — only
 * Craft's host, the upstream default share-API URL and constant, and the two
 * knobs plus their `NESSY_` rebrands.
 *
 * Every needle is ASSEMBLED AT RUNTIME, so this file never matches itself.
 *
 * Instrument: `git grep -a -l -F` (tracked files, binary-as-text), over
 * `packages apps`. The positive control runs the SAME instrument with
 * `--no-index` over a temporary directory carrying the upstream default; an
 * in-scope control proves the real scan reads the tree it claims to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST = ['thecraft', 'agents'].join('')
const DEFAULT_SHARE_API_URL = ['https:/', `${HOST}.com`, 'p', 'api'].join('/')
const DEFAULT_SHARE_API_CONST = ['DEFAULT', 'PAGES', 'SHARE', 'API', 'BASE', 'URL'].join('_')
const KNOBS = ['CRAFT', 'NESSY'].flatMap(prefix => [
  [prefix, 'PAGES', 'SHARE', 'API', 'URL'].join('_'),
  [prefix, 'FEATURE', 'PAGES', 'SHARING'].join('_'),
])
const NEEDLES = [HOST, DEFAULT_SHARE_API_URL, DEFAULT_SHARE_API_CONST, ...KNOBS]

const REPO_ROOT = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: import.meta.dir, encoding: 'utf8' }).stdout.trim()

/** needle → the files `git grep -a -l -F` reports for it. Throws on an instrument error (exit ≥ 2). */
function scan(cwd: string, pathspecs: string[], options: { noIndex?: boolean } = {}): Record<string, string[]> {
  const hits: Record<string, string[]> = {}
  for (const needle of NEEDLES) {
    const args = ['grep', ...(options.noIndex ? ['--no-index'] : []), '-a', '-l', '-F', '-e', needle, '--', ...pathspecs]
    const out = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (out.status !== 0 && out.status !== 1) throw new Error(`git grep failed (${out.status}): ${out.stderr}`)
    hits[needle] = out.stdout.split('\n').filter(Boolean)
  }
  return hits
}

describe('Craft share-service guard (UA6.6)', () => {
  let planted: string

  beforeAll(() => {
    planted = mkdtempSync(join(tmpdir(), 'nessy-sharing-cut-'))
    writeFileSync(
      join(planted, 'publisher.ts'),
      [
        `export const ${DEFAULT_SHARE_API_CONST} = '${DEFAULT_SHARE_API_URL}';`,
        ...KNOBS.map(knob => `const ${knob.toLowerCase()} = process.env.${knob};`),
      ].join('\n'),
    )
    writeFileSync(join(planted, 'unrelated.ts'), "export const shareUrl = 'https://example.com/share';\n")
  })

  afterAll(() => {
    rmSync(planted, { recursive: true, force: true })
  })

  it('needles are assembled and distinct (the host, the default URL and constant, four knobs)', () => {
    expect(new Set(NEEDLES).size).toBe(7)
    expect(DEFAULT_SHARE_API_URL.startsWith('https://')).toBe(true)
    expect(DEFAULT_SHARE_API_URL.includes(HOST)).toBe(true)
  })

  it('positive control: the same scan over a planted file reports every needle, and only that file', () => {
    const hits = scan(planted, ['.'], { noIndex: true })
    for (const needle of NEEDLES) expect(hits[needle]).toEqual(['publisher.ts'])
  })

  it('in-scope control: the real scan reads packages and apps', () => {
    // Same instrument and scope as the absence below; `deletePageLocal` is the
    // ported local half of upstream's publisher (UA6.1), so a scan that read
    // nothing would fail here instead of passing the absence.
    const out = spawnSync('git', ['grep', '-a', '-l', '-F', '-e', 'deletePageLocal', '--', 'packages', 'apps'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('packages/shared/src/pages/storage.ts')
  })

  it('negative: no tracked file under packages or apps names Craft’s host, share-API default, or share-service knobs', () => {
    const hits = scan(REPO_ROOT, ['packages', 'apps'])
    const found = Object.entries(hits).filter(([, files]) => files.length > 0)
    expect(found).toEqual([])
  })
})
