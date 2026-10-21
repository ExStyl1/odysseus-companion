/**
 * UB13.17 — the boundary arm over `ensurePresetThemes` (storage.ts, the copy-if-absent sync):
 * through the REAL function against a scratch `NESSY_CONFIG_DIR`, one launch decides all four
 * ways — a bundled preset the install lacks (paper.json) is COPIED in, a user-EDITED VALID
 * preset is KEPT, a corrupt one is auto-healed from the bundle, and the RETIRED files
 * (`default.json`; RETIRED_BUNDLED_THEME_FILES is unchanged — no `craft.json` ever ships) are
 * removed.
 *
 * `NESSY_CONFIG_DIR` must be exported BEFORE bun starts (the isolate-preload trap): the lock
 * invocation for this file carries it. `setBundledAssetsRoot` points the resolver at this
 * checkout's apps/electron so the bundle is the real one. `presetsInitialized` means the FIRST
 * `ensurePresetThemes()` call in the process is the launch under test — every arm is arranged
 * BEFORE that call, at module top level.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setBundledAssetsRoot } from '../../utils/paths.ts'
import { ensurePresetThemes, getAppThemesDir } from '../storage.ts'
import { isValidThemeFile } from '../validators.ts'

const REPO_ROOT = resolve(import.meta.dir, '../../../../..')
const BUNDLE = join(REPO_ROOT, 'apps/electron')

// The scratch install under test: paper.json absent (fresh-install arm), github.json
// user-edited and valid (kept arm), nord.json corrupt (auto-heal arm), default.json a retired
// leftover (removal arm).
const themesDir = getAppThemesDir()
mkdirSync(themesDir, { recursive: true })
rmSync(join(themesDir, 'paper.json'), { force: true })
const userEdited = {
  name: 'GitHub',
  description: 'locally tuned by the workspace owner',
  background: '#0d1117',
  foreground: '#e6edf3',
  accent: '#2f81f7',
}
writeFileSync(join(themesDir, 'github.json'), JSON.stringify(userEdited, null, 2), 'utf-8')
writeFileSync(join(themesDir, 'nord.json'), '{ not json at all', 'utf-8')
writeFileSync(join(themesDir, 'default.json'), '{"name":"Default"}', 'utf-8')

setBundledAssetsRoot(BUNDLE) // -> <repo>/apps/electron, so resources/themes resolves
ensurePresetThemes() // the one launch this process gets

describe('ensurePresetThemes (UB13.17 boundary, one launch)', () => {
  it('positive: an install without paper.json gains it on next launch, byte-equal to the bundle', () => {
    const dest = join(themesDir, 'paper.json')
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe(readFileSync(join(BUNDLE, 'resources/themes/paper.json'), 'utf-8'))
  })

  it('positive: a user-edited VALID preset is kept verbatim', () => {
    const dest = join(themesDir, 'github.json')
    expect(JSON.parse(readFileSync(dest, 'utf-8'))).toEqual(userEdited)
  })

  it('boundary: a corrupt preset is auto-healed from the bundle', () => {
    const dest = join(themesDir, 'nord.json')
    expect(isValidThemeFile(dest)).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe(readFileSync(join(BUNDLE, 'resources/themes/nord.json'), 'utf-8'))
  })

  it('negative (control): the retired default.json (and never a craft.json) is gone after the launch', () => {
    expect(existsSync(join(themesDir, 'default.json'))).toBe(false)
    expect(existsSync(join(BUNDLE, 'resources/themes/craft.json'))).toBe(false)
    expect(existsSync(join(BUNDLE, 'resources/themes/default.json'))).toBe(false)
  })
})
