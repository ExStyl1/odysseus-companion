import { describe, expect, test } from 'bun:test'
import {
  CHECKPOINT_RETENTION,
  isFirstSnapshotOfItsFile,
  isReferencedByRetainedCheckpoint,
  planCheckpointGc,
  type CheckpointGcCheckpoint,
} from './checkpoint-gc.ts'

function checkpoint(
  id: string,
  filePath: string,
  options: { snapshot?: boolean } = {},
): CheckpointGcCheckpoint {
  const snapshot = options.snapshot ?? true
  return {
    id,
    filePath,
    createdAt: `2026-07-27T00:00:${id.padStart(2, '0').slice(-2)}.000Z`,
    ...(snapshot ? { snapshotFile: `files/${id}/0-snap` } : {}),
  }
}

/** N checkpoints, all on distinct files so the first-snapshot pin never fires. */
function distinct(count: number): CheckpointGcCheckpoint[] {
  return Array.from({ length: count }, (_, index) => checkpoint(`c${index + 1}`, `/repo/file-${index + 1}.ts`))
}

describe('planCheckpointGc — the retention window', () => {
  test('the constant is the documented 100', () => {
    expect(CHECKPOINT_RETENTION).toBe(100)
  })

  const cases = [
    { name: '100 checkpoints discard nothing', total: 100, discarded: 0 },
    { name: '101 checkpoints discard the oldest', total: 101, discarded: 1 },
    { name: '105 checkpoints discard the oldest five', total: 105, discarded: 5 },
  ] as const

  for (const testCase of cases) {
    test(testCase.name, () => {
      const checkpoints = distinct(testCase.total)
      const plan = planCheckpointGc({ checkpoints })
      expect(plan.discardedCheckpointIds).toEqual(
        checkpoints.slice(0, testCase.discarded).map(entry => entry.id),
      )
      expect(plan.retainedCheckpointIds).toHaveLength(
        Math.min(testCase.total, CHECKPOINT_RETENTION),
      )
    })
  }
})

describe('planCheckpointGc — the delete predicate', () => {
  test('an unreferenced snapshot that is not a file first is deleted', () => {
    // Two checkpoints on the SAME file: the second is not that file's first, so
    // discarding it is a plain unreferenced delete.
    const checkpoints = [
      checkpoint('first', '/repo/a.ts'),
      checkpoint('second', '/repo/a.ts'),
      ...distinct(1),
    ]
    const plan = planCheckpointGc({ checkpoints, retention: 1 })
    expect(plan.deletedSnapshotFiles).toEqual(['files/second/0-snap'])
  })

  test("a file's first snapshot survives even when unreferenced", () => {
    const checkpoints = [
      checkpoint('first', '/repo/a.ts'),
      checkpoint('second', '/repo/a.ts'),
      ...distinct(1),
    ]
    const plan = planCheckpointGc({ checkpoints, retention: 1 })
    expect(plan.discardedCheckpointIds).toContain('first')
    expect(plan.deletedSnapshotFiles).not.toContain('files/first/0-snap')
    expect(plan.pinnedSnapshotFiles).toEqual(['files/first/0-snap'])
    expect(plan.baselines).toEqual([{
      filePath: '/repo/a.ts',
      snapshotFile: 'files/first/0-snap',
      checkpointId: 'first',
      createdAt: checkpoints[0]!.createdAt,
    }])
  })

  test('a snapshot a retained checkpoint still references survives without becoming a baseline', () => {
    // Deduplicated storage: two checkpoints pointing at one blob. The older one
    // is discarded, the newer is retained, so the blob must stay.
    const shared = { ...checkpoint('older', '/repo/a.ts'), snapshotFile: 'files/shared/0-snap' }
    const alsoShared = { ...checkpoint('newer', '/repo/a.ts'), snapshotFile: 'files/shared/0-snap' }
    const plan = planCheckpointGc({
      checkpoints: [checkpoint('pin', '/repo/a.ts'), shared, alsoShared],
      retention: 1,
    })
    expect(plan.retainedCheckpointIds).toEqual(['newer'])
    expect(plan.deletedSnapshotFiles).toEqual([])
    // 'pin' is the file's first and gets the baseline; 'older' is kept purely by
    // reference and must NOT be pinned.
    expect(plan.baselines.map(entry => entry.checkpointId)).toEqual(['pin'])
  })

  test('a file whose only snapshot is its first survives', () => {
    const plan = planCheckpointGc({
      checkpoints: [checkpoint('only', '/repo/a.ts'), ...distinct(1)],
      retention: 1,
    })
    expect(plan.deletedSnapshotFiles).toEqual([])
    expect(plan.pinnedSnapshotFiles).toEqual(['files/only/0-snap'])
  })

  test('two interleaved files keep one first-snapshot each', () => {
    const checkpoints = [
      checkpoint('a1', '/repo/a.ts'),
      checkpoint('b1', '/repo/b.ts'),
      checkpoint('a2', '/repo/a.ts'),
      checkpoint('b2', '/repo/b.ts'),
      ...distinct(1),
    ]
    const plan = planCheckpointGc({ checkpoints, retention: 1 })
    expect([...plan.deletedSnapshotFiles].sort()).toEqual(['files/a2/0-snap', 'files/b2/0-snap'])
    expect([...plan.pinnedSnapshotFiles].sort()).toEqual(['files/a1/0-snap', 'files/b1/0-snap'])
    expect(plan.baselines.map(entry => entry.filePath).sort()).toEqual(['/repo/a.ts', '/repo/b.ts'])
  })

  test('a checkpoint with no snapshot contributes nothing to collect', () => {
    const plan = planCheckpointGc({
      checkpoints: [checkpoint('absent', '/repo/new.ts', { snapshot: false }), ...distinct(1)],
      retention: 1,
    })
    expect(plan.discardedCheckpointIds).toEqual(['absent'])
    expect(plan.deletedSnapshotFiles).toEqual([])
    expect(plan.baselines).toEqual([])
  })

  test('a baseline from an earlier sweep still pins its file, so the next first is collectable', () => {
    const checkpoints = [checkpoint('a2', '/repo/a.ts'), ...distinct(1)]
    const plan = planCheckpointGc({
      checkpoints,
      retention: 1,
      baselines: [{
        filePath: '/repo/a.ts',
        snapshotFile: 'files/a1/0-snap',
        checkpointId: 'a1',
        createdAt: '2026-07-26T00:00:00.000Z',
      }],
    })
    expect(plan.deletedSnapshotFiles).toEqual(['files/a2/0-snap'])
    expect(plan.baselines.map(entry => entry.checkpointId)).toEqual(['a1'])
  })
})

describe('the predicate halves are separable', () => {
  const checkpoints = [checkpoint('a1', '/repo/a.ts'), checkpoint('a2', '/repo/a.ts')]

  test('isReferencedByRetainedCheckpoint sees retained entries and baselines', () => {
    expect(isReferencedByRetainedCheckpoint('files/a2/0-snap', [checkpoints[1]!])).toBe(true)
    expect(isReferencedByRetainedCheckpoint('files/a1/0-snap', [checkpoints[1]!])).toBe(false)
    expect(isReferencedByRetainedCheckpoint('files/a1/0-snap', [], [{
      filePath: '/repo/a.ts',
      snapshotFile: 'files/a1/0-snap',
      checkpointId: 'a1',
      createdAt: '2026-07-26T00:00:00.000Z',
    }])).toBe(true)
  })

  test('isFirstSnapshotOfItsFile is per file, not per session', () => {
    expect(isFirstSnapshotOfItsFile('a1', checkpoints)).toBe(true)
    expect(isFirstSnapshotOfItsFile('a2', checkpoints)).toBe(false)
    // A different file's first is also a first — the pin is not "the session's
    // oldest snapshot".
    const twoFiles = [checkpoints[0]!, checkpoint('b1', '/repo/b.ts')]
    expect(isFirstSnapshotOfItsFile('b1', twoFiles)).toBe(true)
  })
})
