import { describe, it, expect } from 'bun:test'
import {
  WORKING_DIR_FILTER_THRESHOLD,
  deriveSelectionFlags,
  deriveSortedRecent,
} from '../use-working-directory-state'
import type { RecentProjectSummary } from '@nessy-agent/shared/protocol'

const recent = (id: string, displayPath: string): RecentProjectSummary => ({
  id,
  displayPath,
  lastUsedAt: 1,
})

const displayPaths = (projects: RecentProjectSummary[]) => projects.map((project) => project.displayPath)

describe('deriveSortedRecent', () => {
  it('returns [] when recents is empty', () => {
    expect(deriveSortedRecent([], undefined)).toEqual([])
    expect(deriveSortedRecent([], '/Users/alice/code')).toEqual([])
  })

  it('filters out the current working directory', () => {
    const result = deriveSortedRecent(
      [recent('code', '/Users/alice/code'), recent('docs', '/Users/alice/docs'), recent('photos', '/Users/alice/photos')],
      '/Users/alice/docs',
    )
    expect(displayPaths(result)).toEqual(['/Users/alice/code', '/Users/alice/photos'])
  })

  it('keeps everything when workingDirectory is undefined', () => {
    const result = deriveSortedRecent(
      [recent('code', '/Users/alice/code'), recent('docs', '/Users/alice/docs')],
      undefined,
    )
    expect(displayPaths(result)).toEqual(['/Users/alice/code', '/Users/alice/docs'])
  })

  it('sorts alphabetically by basename, case-insensitive', () => {
    const result = deriveSortedRecent(
      [
        recent('zebra', '/Users/alice/Zebra'),
        recent('apple', '/Users/alice/apple'),
        recent('banana', '/Users/alice/Banana'),
        recent('cherry', '/Users/alice/cherry'),
      ],
      undefined,
    )
    expect(displayPaths(result)).toEqual([
      '/Users/alice/apple',
      '/Users/alice/Banana',
      '/Users/alice/cherry',
      '/Users/alice/Zebra',
    ])
  })

  it('does not mutate the input array', () => {
    const input = [recent('zebra', '/Users/alice/Zebra'), recent('apple', '/Users/alice/apple')]
    const snapshot = [...input]
    deriveSortedRecent(input, undefined)
    expect(input).toEqual(snapshot)
  })

  it('sorts by basename even when paths share a basename in different parents', () => {
    const result = deriveSortedRecent(
      [recent('a-foo', '/a/foo'), recent('b-bar', '/b/bar'), recent('c-foo', '/c/foo')],
      undefined,
    )
    // Stable enough: bar < foo < foo. Both foos remain together; order
    // between them is locale-driven but they must come after bar.
    expect(result[0]?.displayPath).toBe('/b/bar')
    expect(displayPaths(result.slice(1)).sort()).toEqual(['/a/foo', '/c/foo'])
  })
})

describe('deriveSelectionFlags', () => {
  it('returns "no folder" when workingDirectory is undefined', () => {
    const flags = deriveSelectionFlags(undefined)
    expect(flags.hasFolder).toBe(false)
    expect(flags.folderName).toBeUndefined()
    expect(flags.showReset).toBe(false)
  })

  it('returns "no folder" when workingDirectory is undefined but reset is supported', () => {
    const flags = deriveSelectionFlags(undefined, true)
    expect(flags.hasFolder).toBe(false)
    expect(flags.folderName).toBeUndefined()
    expect(flags.showReset).toBe(false)
  })

  it('returns hasFolder + folderName when a custom folder is selected', () => {
    const flags = deriveSelectionFlags('/Users/alice/code/project')
    expect(flags.hasFolder).toBe(true)
    expect(flags.folderName).toBe('project')
  })

  it('showReset is true when backend reset is available', () => {
    const flags = deriveSelectionFlags('/Users/alice/code/project', true)
    expect(flags.hasFolder).toBe(true)
    expect(flags.folderName).toBe('project')
    expect(flags.showReset).toBe(true)
  })

  it('showReset is false when backend reset is unavailable', () => {
    const flags = deriveSelectionFlags('/Users/alice/code/project')
    expect(flags.hasFolder).toBe(true)
    expect(flags.showReset).toBe(false)
  })

  it('folderName falls back to undefined when basename resolves to empty', () => {
    // Path of just '/' — basename is '' — should normalise to undefined,
    // not be passed through as an empty string.
    const flags = deriveSelectionFlags('/', undefined)
    expect(flags.hasFolder).toBe(true)
    expect(flags.folderName).toBeUndefined()
  })
})

describe('WORKING_DIR_FILTER_THRESHOLD', () => {
  it('is 5 — the boundary above which the filter input appears', () => {
    // Pinned as a regression guard: the surfaces share this constant so
    // changing it here must be intentional and applied to both.
    expect(WORKING_DIR_FILTER_THRESHOLD).toBe(5)
  })
})
