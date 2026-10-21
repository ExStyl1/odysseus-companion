/**
 * UB14.47 (B3-17; upstream v0.15.0 "Windows") — Windows 10 and Windows 11 before 22H2 get an opaque
 * window: Mica only at build 22621+, no Acrylic, and the renderer is told which material (if any) sits
 * behind the window through a launch argument.
 *
 * Before this row `window-manager.ts` asked for Mica from build 22000 and Acrylic from 17763. Electron
 * applies `backgroundMaterial` only from Windows 11 22H2 (the `setBackgroundMaterial` note in
 * `electron.d.ts`), so on Windows 10 and 11 21H2 the request bought transparent web contents over no
 * material. The gate is the pure `windowsBackgroundMaterialForBuild` (`main/window-material.ts`);
 * the renderer half (ThemeContext `data-vibrancy`, base.css) is pinned in
 * `renderer/context/__tests__/theme-overrides.test.tsx`, the argument's parser in
 * `preload/window-vibrancy.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WINDOW_VIBRANCY_ARG,
  WINDOWS_BACKGROUND_MATERIAL_MIN_BUILD,
  windowsBackgroundMaterialForBuild,
  windowsBuildNumber,
  windowVibrancyArguments,
  windowVibrancyFor,
} from '../window-material'

/** The full main-process chain for one Windows build: material → renderer argument. */
function windowsChain(build: number) {
  const material = windowsBackgroundMaterialForBuild(build)
  const vibrancy = windowVibrancyFor('win32', material)
  return { material, vibrancy, args: windowVibrancyArguments(vibrancy) }
}

describe('UB14.47 — Mica from Windows 11 22H2 (positive)', () => {
  it('build 22621 gets Mica and tells the renderer, so the canvas may be translucent', () => {
    expect(WINDOWS_BACKGROUND_MATERIAL_MIN_BUILD).toBe(22621)
    expect(windowsChain(22621)).toEqual({
      material: 'mica',
      vibrancy: 'mica',
      args: ['--nessy-window-vibrancy=mica'],
    })
  })

  it('a later build (Windows 11 24H2, 26100) keeps Mica', () => {
    expect(windowsChain(26100).material).toBe('mica')
  })

  it('macOS keeps its under-window vibrancy whatever the build reads (ours, unchanged)', () => {
    expect(windowVibrancyFor('darwin', undefined)).toBe('under-window')
    expect(windowVibrancyArguments(windowVibrancyFor('darwin', undefined))).toEqual([
      `${WINDOW_VIBRANCY_ARG}under-window`,
    ])
  })

  it('reads the build from os.release()', () => {
    expect(windowsBuildNumber('10.0.22621')).toBe(22621)
    expect(windowsBuildNumber('10.0.19045')).toBe(19045)
  })
})

describe('UB14.47 — older Windows gets no material and an opaque canvas (negative / control)', () => {
  it.each([
    ['Windows 11 21H2', 22000],
    ['Windows 10 22H2', 19045],
    ['Windows 10 1809 (the old Acrylic floor)', 17763],
    ['the build just below the gate', 22620],
  ])('%s (build %d): no backgroundMaterial and no renderer argument', (_name, build) => {
    expect(windowsChain(build)).toEqual({ material: undefined, vibrancy: undefined, args: [] })
  })

  it('an unreadable release string reads as build 0, which gets no material', () => {
    expect(windowsBuildNumber('10.0')).toBe(0)
    expect(windowsBuildNumber('not-a-version')).toBe(0)
    expect(windowsChain(windowsBuildNumber('not-a-version')).material).toBeUndefined()
  })

  it('Linux has no material even if one were passed', () => {
    expect(windowVibrancyFor('linux', 'mica')).toBeUndefined()
  })
})

describe('UB14.47 — window-manager.ts wires the gate (source shape)', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'window-manager.ts'), 'utf-8')

  it('asks the gate for the material and hands the renderer its argument', () => {
    // Positive control on the same read: the BrowserWindow option this row feeds is still there.
    expect(source).toContain('backgroundMaterial: windowsBackgroundMaterial')
    expect(source).toContain('windowsBackgroundMaterialForBuild(buildNumber)')
    expect(source).toContain('windowVibrancyFor(process.platform, windowsBackgroundMaterial)')
    expect(source).toContain('additionalArguments: windowVibrancyArguments(windowVibrancy)')
  })

  it('no longer requests Acrylic or gates Mica at build 22000', () => {
    expect(source).not.toMatch(/['"]acrylic['"]/)
    expect(source).not.toMatch(/>=\s*22000\b/)
    expect(source).not.toMatch(/>=\s*17763\b/)
  })
})
