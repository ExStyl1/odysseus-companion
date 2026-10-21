/**
 * UB14.47 — the preload's `getWindowVibrancy` reads the native material from the launch argument the
 * main process sets (`main/window-material.ts`). A known material reads back as itself; anything else,
 * including a missing argument, is null, so the renderer paints an opaque canvas.
 */
import { describe, expect, it } from 'bun:test'
import { windowVibrancyArguments } from '../main/window-material'
import { readWindowVibrancy } from './window-vibrancy'

const BASE_ARGV = ['/Applications/Nessy Desktop.app/Contents/MacOS/Nessy Desktop', '--type=renderer']

describe('UB14.47 — readWindowVibrancy (positive)', () => {
  it('--nessy-window-vibrancy=mica reads as mica', () => {
    expect(readWindowVibrancy([...BASE_ARGV, '--nessy-window-vibrancy=mica'])).toBe('mica')
  })

  it('--nessy-window-vibrancy=under-window reads as under-window', () => {
    expect(readWindowVibrancy([...BASE_ARGV, '--nessy-window-vibrancy=under-window'])).toBe('under-window')
  })

  it('reads back exactly what the main process writes', () => {
    expect(readWindowVibrancy([...BASE_ARGV, ...windowVibrancyArguments('mica')])).toBe('mica')
    expect(readWindowVibrancy([...BASE_ARGV, ...windowVibrancyArguments('under-window')])).toBe('under-window')
  })
})

describe('UB14.47 — readWindowVibrancy (negative / control)', () => {
  it('a missing argument (Windows before 22H2, Linux, an opaque window) is null', () => {
    expect(readWindowVibrancy(BASE_ARGV)).toBeNull()
    expect(readWindowVibrancy([...BASE_ARGV, ...windowVibrancyArguments(undefined)])).toBeNull()
  })

  it('an unknown value is null, Acrylic included', () => {
    expect(readWindowVibrancy([...BASE_ARGV, '--nessy-window-vibrancy=acrylic'])).toBeNull()
    expect(readWindowVibrancy([...BASE_ARGV, '--nessy-window-vibrancy='])).toBeNull()
  })

  it("upstream's unrebranded argument is not ours", () => {
    expect(readWindowVibrancy([...BASE_ARGV, '--craft-window-vibrancy=mica'])).toBeNull()
  })
})
