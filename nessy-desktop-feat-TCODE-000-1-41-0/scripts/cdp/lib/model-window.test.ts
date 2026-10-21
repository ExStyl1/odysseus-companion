/**
 * P3.159 — the harness must not carry its own copy of a number the product owns.
 *
 * Two live cases compared a stored `contextWindow` against a hand-copied `4096`
 * after `e3959bac5` had already unified both catalogue paths onto `1024`, so a
 * credible 2048-token window would have been reported as incredible. These tests
 * pin the reader, and the last one pins the agreement itself: if the product's
 * floor moves again, the assertion here fails in `bun test` rather than three
 * commits later in front of an operator running a live pass.
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BlockedError } from './report.ts'
import { FLOOR_SOURCE, minPlausibleContextWindow, parseMinPlausibleContextWindow } from './model-window.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('parseMinPlausibleContextWindow', () => {
  it('reads the declaration and strips the numeric separators', () => {
    expect(parseMinPlausibleContextWindow('export const MIN_PLAUSIBLE_CONTEXT_WINDOW = 1024;')).toBe(1024)
    expect(parseMinPlausibleContextWindow('export const MIN_PLAUSIBLE_CONTEXT_WINDOW = 262_144;')).toBe(262_144)
  })

  it('answers undefined rather than a guess when the constant is renamed or gone', () => {
    // The arm the reader itself cannot reach, and the one that matters: a
    // rename must stop the case, not silently fall back to some default.
    expect(parseMinPlausibleContextWindow('export const MIN_CREDIBLE_CONTEXT_WINDOW = 4096;')).toBeUndefined()
    expect(parseMinPlausibleContextWindow('')).toBeUndefined()
    expect(parseMinPlausibleContextWindow('// MIN_PLAUSIBLE_CONTEXT_WINDOW is documented here but not declared'))
      .toBeUndefined()
  })

  it('is not fooled by a prose mention of a different number', () => {
    const source = [
      ' * The BYO fetcher used to keep a private MIN_CREDIBLE_CONTEXT_WINDOW = 4096.',
      'export const MIN_PLAUSIBLE_CONTEXT_WINDOW = 1024;',
    ].join('\n')
    expect(parseMinPlausibleContextWindow(source)).toBe(1024)
  })
})

describe('minPlausibleContextWindow', () => {
  it('agrees with the floor the product actually applies', () => {
    // Read twice by two routes on purpose. This side re-derives the number from
    // the source; the reader resolves the same file through `repoRoot()`. If
    // those ever disagree the case is measuring a file nobody ships.
    const declared = parseMinPlausibleContextWindow(readFileSync(join(REPO_ROOT, FLOOR_SOURCE), 'utf8'))
    expect(declared).toBeDefined()
    expect(minPlausibleContextWindow()).toBe(declared!)
  })

  it('is the unified floor of 1024, not the 4096 the harness used to restate', () => {
    // A positive control for the test above, which would pass on any two equal
    // numbers — including the stale one. This is the assertion that fails if the
    // floor moves, and failing here is the whole point: the alternative is a
    // live case flagging correct behaviour in front of an operator.
    expect(minPlausibleContextWindow()).toBe(1024)
  })

  it('BLOCKS rather than guessing when the file is not there', () => {
    // BLOCKED, never FAIL: an unrunnable harness is not a product defect, and
    // scoring the two the same way is how a run's verdict stops meaning anything.
    const empty = mkdtempSync(join(tmpdir(), 'p3159-empty-'))
    try {
      expect(() => minPlausibleContextWindow(empty)).toThrow(BlockedError)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('BLOCKS rather than guessing when the constant has been renamed', () => {
    const root = mkdtempSync(join(tmpdir(), 'p3159-renamed-'))
    try {
      const file = join(root, FLOOR_SOURCE)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'export const MIN_CREDIBLE_CONTEXT_WINDOW = 4096;\n')
      expect(() => minPlausibleContextWindow(root)).toThrow(BlockedError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
