/**
 * F1.160 — the "What's new" panel lists EVERY bundled release note.
 *
 * Until 2026-09-20 `getReleaseNotesList` sliced the sorted list to the ten most
 * recent, so the panel — the only place the app shows its own history — stopped
 * at whatever ten versions happened to be newest (a user on 1.31.0 read back to
 * 1.22 and nothing earlier, with 65 notes bundled). The owner asked for all of
 * them. This pins the cap's absence against the directory the app ships, so a
 * reintroduced `.slice(0, N)` fails here the day it lands rather than the day a
 * user notices the history is short again.
 *
 * The assets root is pointed at `apps/electron` exactly the way the packaged app
 * does it (`setBundledAssetsRoot` at startup), because under `bun test` the cwd
 * is the repo root and neither dev candidate of `getBundledAssetsDir` exists.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setBundledAssetsRoot } from '../../utils/paths.ts'
import { getLatestReleaseVersion, getReleaseNotesList } from '../index.ts'

// F1.868, 2026-09-26 — the budget belongs to the FILE, sized against the largest
// observed run rather than a per-test guess (docs/agents/traps.md, the timer
// lottery). The listing case reads every bundled note synchronously, so under
// I/O load its body alone ran 5 434 ms and 8 899 ms against bun's 5 s default,
// with zero assertion failures, in a whole-file run of 65.43 s real against
// 0.67 s user; the same bytes took 3 124 ms under a 60 s budget, and 1 624 ms
// inside a 15.73 s file at load 12. A synchronous body cannot be cut short by a
// timer, so this budget never shortens a hang — it only decides whether slow
// I/O reads as red. 120 s covers the largest observed run total with margin.
setDefaultTimeout(120_000)

const ELECTRON_APP = join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron')
const NOTES_DIR = join(ELECTRON_APP, 'resources', 'release-notes')

describe('F1.160 — every bundled release note is listed, newest first', () => {
  setBundledAssetsRoot(ELECTRON_APP)
  afterAll(() => {
    setBundledAssetsRoot(undefined as unknown as string)
  })

  it('lists exactly as many notes as the bundled directory holds, and more than the old cap of ten', () => {
    const bundled = readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'))
    // The control that makes the count assertion mean something: the corpus is
    // larger than the cap this test exists to keep out.
    expect(bundled.length).toBeGreaterThan(10)
    const list = getReleaseNotesList()
    expect(list.length).toBe(bundled.length)
    expect(new Set(list.map(n => n.version)).size).toBe(bundled.length)
  })

  it('keeps the newest-first order the panel and getLatestReleaseVersion rely on', () => {
    const list = getReleaseNotesList()
    const asTuple = (v: string) => v.split('.').map(Number)
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [asTuple(list[i - 1]!.version), asTuple(list[i]!.version)]
      const cmp = (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!)
      expect(cmp).toBeGreaterThan(0)
    }
    expect(getLatestReleaseVersion()).toBe(list[0]!.version)
  })
})
