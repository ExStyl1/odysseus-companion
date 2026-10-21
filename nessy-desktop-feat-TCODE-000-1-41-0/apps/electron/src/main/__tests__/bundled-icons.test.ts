/**
 * F1.252 — the three icons that ship, and the docs that describe them.
 *
 * The rebrand (a0afaf7c9) deleted `Assets.car`, `icon.icon/`, `icon.svg`,
 * `generate-icons.sh`, `source.png` and `dmg-background.*`; `resources/` has
 * held `icon.icns`, `icon.ico` and `icon.png` alone since. `resources/AGENTS.md`
 * and the Electron README kept describing the deleted files — four of the five
 * rows of the "Other Files (Not Synced)" table named files that did not exist —
 * so the positive arm below reads that table and requires every file it names
 * to be a TRACKED file under `resources/` (the git-ignored build-staged servers
 * are named in prose beside the table, not in it).
 *
 * `icon.png` read 1478x1444. It is the Linux app and window icon and the macOS
 * dock icon and badge base (`app.dock.setIcon` / `initBadgeIcon`, packaged
 * builds included), so it was padded to a square with transparent pixels — the
 * artwork itself untouched. The negative arm reads the PNG header (IHDR width
 * and height, bytes 16–23) rather than trusting a tool's summary.
 */

import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const RESOURCES = fileURLToPath(new URL('../../../resources/', import.meta.url))
const README = fileURLToPath(new URL('../../../README.md', import.meta.url))
const MAIN_INDEX = fileURLToPath(new URL('../index.ts', import.meta.url))

function trackedResources(): Set<string> {
  const out = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: RESOURCES, encoding: 'utf-8' })
  return new Set(out.split('\0').filter(Boolean))
}

/**
 * The backticked names in the first column of the table under `heading`, and
 * how many DATA rows that table has — F1.447: a row the name pattern cannot read
 * (no backticks, or an annotation after the name) used to vanish from the
 * extraction instead of failing it, so every caller compares the two.
 */
function firstColumn(doc: string, heading: string): { names: string[]; dataRows: number } {
  const section = doc.slice(doc.indexOf(heading))
  const table = section.slice(0, section.indexOf('\n## ', 1))
  const rows = table.split('\n').filter(line => line.startsWith('|'))
  // The header row and the `|---|` separator are not data.
  const dataRows = rows.filter(line => !/^\|[\s|:-]+$/.test(line)).length - 1
  return { names: [...table.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1] as string), dataRows }
}

/** The first-column names of the resources/AGENTS.md table under `heading`, every data row accounted for. */
function tableNames(heading: string): string[] {
  const { names, dataRows } = firstColumn(readFileSync(`${RESOURCES}AGENTS.md`, 'utf-8'), heading)
  expect(names.length, `every data row of ${heading} names exactly one backticked entry`).toBe(dataRows)
  return names
}

/** The backticked file names in the first column of the "Other Files (Not Synced)" table. */
function notSyncedTableFiles(): string[] {
  return tableNames('## Other Files (Not Synced)')
}

/** A name ending in `/` is a directory: tracked when any tracked path lies under it. */
function isTracked(tracked: Set<string>, entry: string): boolean {
  return entry.endsWith('/') ? [...tracked].some(path => path.startsWith(entry)) : tracked.has(entry)
}

/** The Sync Behavior cell of the "Asset Types" row whose first column is `entry`. */
function syncBehavior(entry: string): string {
  const doc = readFileSync(`${RESOURCES}AGENTS.md`, 'utf-8')
  const row = doc.split('\n').find(line => line.startsWith(`| \`${entry}\` |`))
  expect(row, entry).toBeDefined()
  return (row ?? '').split('|')[3]?.trim() ?? ''
}

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  // Signature (8) + IHDR length (4) + 'IHDR' (4), then width and height, big-endian.
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('F1.252 — the icons that ship, and the docs that name them', () => {
  it('every file the resources/AGENTS.md "Other Files" table names is tracked under resources/', () => {
    const named = notSyncedTableFiles()
    expect(named).toEqual(['icon.icns', 'icon.ico', 'icon.png', 'bin/', 'scripts/', 'certs/', 'release-notes/', 'AGENTS.md'])
    const tracked = trackedResources()
    for (const entry of named) expect(isTracked(tracked, entry), entry).toBe(true)
  })

  it('F1.444 — every tracked top-level entry under resources/ is named in one of the two tables', () => {
    // Line 3 used to say the whole folder syncs, while five tracked entries —
    // bin/, certs/, release-notes/, scripts/ and skills/ — appeared in neither
    // table (WJ-ii's verifier on F1.252, 2026-09-23). `git ls-files` is the
    // denominator, so a new top-level entry must be placed in one table or the
    // other before it ships.
    const tracked = trackedResources()
    const synced = tableNames('## Asset Types')
    const named = new Set([...synced, ...notSyncedTableFiles()])
    const topLevel = new Set([...tracked].map(path => (path.includes('/') ? `${path.split('/')[0]}/` : path)))
    expect([...topLevel].filter(entry => !named.has(entry)).sort()).toEqual([])
    for (const entry of synced) expect(isTracked(tracked, entry), entry).toBe(true)
  })

  it('F1.444 — only docs/ and config-defaults.json are overwritten on launch; every other synced entry keeps the user\'s copy', () => {
    // The table said "Always overwrite on launch" for themes/, permissions/ and
    // tool-icons/ as well. At HEAD the theme sync keeps a valid file, the
    // tool-icons sync copies only a missing one, permissions merges by version,
    // and the skill seed leaves an edited copy alone.
    for (const entry of ['docs/', 'config-defaults.json']) expect(syncBehavior(entry), entry).toMatch(/overwrit/i)
    for (const entry of ['themes/', 'permissions/', 'tool-icons/', 'skills/']) {
      expect(syncBehavior(entry), entry).not.toMatch(/overwrit/i)
    }
  })

  it('the README Icons section names only the three shipped icons, and no deleted asset', () => {
    const readme = readFileSync(README, 'utf-8')
    const icons = readme.slice(readme.indexOf('## Icons'))
    for (const file of ['icon.icns', 'icon.ico', 'icon.png']) expect(icons).toContain(`resources/${file}`)
    for (const gone of ['Assets.car', 'icon.icon', 'actool', 'generate-icons', 'dmg-background', 'source.png']) {
      expect(icons).not.toContain(gone)
    }
  })

  it('F1.445 — neither doc credits icon.icns with a window icon macOS never shows', () => {
    // Electron 39.8.10 marks BrowserWindow `setIcon` `@platform win32,linux`; on
    // darwin `getIconPath` only existence-checks the .icns and hands it to an
    // option nothing on macOS renders (WJ-ii's verifier on F1.252, 2026-09-23).
    const readmeRows = readFileSync(README, 'utf-8').split('\n')
    const agentsRows = readFileSync(`${RESOURCES}AGENTS.md`, 'utf-8').split('\n')
    const icns = [
      readmeRows.find(line => line.startsWith('| `resources/icon.icns` |')),
      agentsRows.find(line => line.startsWith('| `icon.icns` |')),
    ]
    for (const row of icns) {
      expect(row).toBeDefined()
      expect(row).not.toContain('window icon')
    }
    // The control on the same instrument: the Windows row names a real window icon.
    expect(readmeRows.find(line => line.startsWith('| `resources/icon.ico` |'))).toContain('window icon')
  })

  it('F1.446 — the dock-icon comment says what the block does: packaged builds set the dock icon too', () => {
    // It read "(required for dev mode, bundled apps use Info.plist)" above a block
    // with no isPackaged guard, so a packaged build also calls app.dock.setIcon
    // and initBadgeIcon — which the README says ("in dev AND packaged builds").
    const lines = readFileSync(MAIN_INDEX, 'utf-8').split('\n')
    const opens = lines.findIndex(line => line.includes("if (process.platform === 'darwin' && app.dock) {"))
    const badge = lines.findIndex((line, index) => index > opens && line.includes('initBadgeIcon(dockIconPath)'))
    expect(opens).toBeGreaterThan(0)
    expect(badge).toBeGreaterThan(opens)
    const comment = lines[opens - 1] ?? ''
    const block = lines.slice(opens, badge + 1).join('\n')
    expect(block).toContain('app.dock.setIcon(')
    expect(block).not.toContain('isPackaged')
    // The needle is spellable in this file, so its absence above is a reading.
    expect(lines.join('\n')).toContain('app.isPackaged')
    expect(comment.trim().startsWith('//')).toBe(true)
    expect(comment).not.toContain('bundled apps use Info.plist')
    expect(comment).toContain('packaged')
  })

  it('F1.447 — a row the extractor cannot read fails the table instead of vanishing from it', () => {
    // WJ-ii's verifier's mutant: a stale row written without backticks and one
    // with an annotation after the name. The name pattern reads neither, so a
    // list comparison alone stayed green on it.
    const mutant = [
      '## Other Files (Not Synced)',
      '',
      '| File | Purpose |',
      '|------|---------|',
      '| `icon.icns` | macOS app and DMG icon |',
      '| dmg-background.png | a stale row, no backticks |',
      '| `source.png` (legacy) | a stale row, annotated |',
      '',
      '## Next',
      '',
    ].join('\n')
    const { names, dataRows } = firstColumn(mutant, '## Other Files (Not Synced)')
    expect(names).toEqual(['icon.icns'])
    expect(dataRows).toBe(3)
  })

  it('icon.png is square (read from its IHDR header)', () => {
    const { width, height } = pngDimensions(`${RESOURCES}icon.png`)
    expect(width).toBeGreaterThan(0)
    expect(width).toBe(height)
  })
})
