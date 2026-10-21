/**
 * Reference-counted garbage collection for file-checkpoint snapshots.
 *
 * `checkpointing.md`: "Claude Code keeps file snapshots for the 100 most recent
 * checkpoints in a session. Discarding an older checkpoint deletes the snapshot
 * files that no remaining checkpoint references, except each file's first
 * snapshot, which the VS Code extension uses as the baseline for its session
 * diffs."
 *
 * So the delete predicate is a conjunction, and BOTH halves matter:
 *
 *     referencedByNoRetainedCheckpoint(snapshot) && !isFirstSnapshotOfItsFile(snapshot)
 *
 * It is NOT a ring buffer. Dropping the second half loses the diff baseline for
 * every file the session touched more than `retention` checkpoints ago; dropping
 * the first half deletes snapshots a live checkpoint still needs to rewind.
 *
 * This module is pure — no filesystem, no manifest I/O — so both halves can be
 * mutated independently and killed by a test. The store applies the plan.
 */

/**
 * The documented cap, per session. `checkpointing.md` records no setting that
 * changes it, so it is a constant and not a config key.
 */
export const CHECKPOINT_RETENTION = 100

/** The subset of a manifest entry the predicate reads. Manifest order = creation order. */
export interface CheckpointGcCheckpoint {
  readonly id: string
  readonly filePath: string
  /** Absent when the target did not exist at checkpoint time — nothing to collect. */
  readonly snapshotFile?: string
  /** Carried onto a baseline so a pinned blob keeps its real creation time. */
  readonly createdAt: string
}

/**
 * A file's first snapshot, kept after the checkpoint that produced it fell out
 * of the retention window. This is the session-diff baseline: the blob has to
 * survive, and something has to still point at it, or the next sweep sees an
 * unreferenced file and the pin only worked once.
 */
export interface CheckpointGcBaseline {
  readonly filePath: string
  readonly snapshotFile: string
  /** Provenance, kept so the blob is still attributable once its entry is gone. */
  readonly checkpointId: string
  readonly createdAt: string
}

export interface CheckpointGcInput {
  /** Every checkpoint in the manifest, oldest first. */
  readonly checkpoints: readonly CheckpointGcCheckpoint[]
  /** Baselines pinned by earlier sweeps. */
  readonly baselines?: readonly CheckpointGcBaseline[]
  readonly retention?: number
}

export interface CheckpointGcPlan {
  readonly retainedCheckpointIds: readonly string[]
  readonly discardedCheckpointIds: readonly string[]
  /** Snapshot files the sweep would delete, in manifest order. */
  readonly deletedSnapshotFiles: readonly string[]
  /** Snapshot files kept ONLY because they are a file's first snapshot. */
  readonly pinnedSnapshotFiles: readonly string[]
  /** The full baseline set to persist — prior pins plus the ones this run added. */
  readonly baselines: readonly CheckpointGcBaseline[]
}

/**
 * First half of the predicate. A snapshot is safe to delete only when nothing
 * that survives the sweep still points at it — a retained checkpoint or an
 * already-persisted baseline.
 */
export function isReferencedByRetainedCheckpoint(
  snapshotFile: string,
  retained: readonly CheckpointGcCheckpoint[],
  baselines: readonly CheckpointGcBaseline[] = [],
): boolean {
  return retained.some(entry => entry.snapshotFile === snapshotFile)
    || baselines.some(baseline => baseline.snapshotFile === snapshotFile)
}

/**
 * Second half of the predicate, and the one that is easy to get wrong: the pin
 * is per FILE, not per session. A snapshot is its file's first when no earlier
 * checkpoint for the same path produced one and no baseline already claims that
 * path.
 */
export function isFirstSnapshotOfItsFile(
  candidateId: string,
  checkpoints: readonly CheckpointGcCheckpoint[],
  baselines: readonly CheckpointGcBaseline[] = [],
): boolean {
  const index = checkpoints.findIndex(entry => entry.id === candidateId)
  if (index < 0) return false
  const candidate = checkpoints[index]!
  if (!candidate.snapshotFile) return false
  if (baselines.some(baseline => baseline.filePath === candidate.filePath)) return false
  return !checkpoints.some((entry, position) => (
    position < index && entry.filePath === candidate.filePath && entry.snapshotFile !== undefined
  ))
}

/** The documented conjunction, in one place so a probe can kill either half. */
export function isSnapshotDeletable(
  candidateId: string,
  input: {
    readonly checkpoints: readonly CheckpointGcCheckpoint[]
    readonly retained: readonly CheckpointGcCheckpoint[]
    readonly baselines?: readonly CheckpointGcBaseline[]
  },
): boolean {
  const candidate = input.checkpoints.find(entry => entry.id === candidateId)
  if (!candidate?.snapshotFile) return false
  const baselines = input.baselines ?? []
  return !isReferencedByRetainedCheckpoint(candidate.snapshotFile, input.retained, baselines)
    && !isFirstSnapshotOfItsFile(candidateId, input.checkpoints, baselines)
}

/**
 * Plan one sweep. Pure: the caller decides whether to apply it, which is what
 * makes the store's dry-run mode exact rather than an approximation.
 */
export function planCheckpointGc(input: CheckpointGcInput): CheckpointGcPlan {
  const retention = Math.max(0, Math.floor(input.retention ?? CHECKPOINT_RETENTION))
  const checkpoints = input.checkpoints
  const priorBaselines = input.baselines ?? []

  const firstRetained = Math.max(0, checkpoints.length - retention)
  const discarded = checkpoints.slice(0, firstRetained)
  const retained = checkpoints.slice(firstRetained)

  const deletedSnapshotFiles: string[] = []
  const pinnedSnapshotFiles: string[] = []
  const baselines = [...priorBaselines]

  for (const candidate of discarded) {
    if (!candidate.snapshotFile) continue
    if (isSnapshotDeletable(candidate.id, { checkpoints, retained, baselines })) {
      deletedSnapshotFiles.push(candidate.snapshotFile)
      continue
    }
    // Kept. Pin it only when the reason is the first-snapshot rule — a snapshot
    // a retained checkpoint still references needs no baseline yet, and gets
    // reconsidered when that checkpoint is itself discarded.
    if (isFirstSnapshotOfItsFile(candidate.id, checkpoints, baselines)) {
      pinnedSnapshotFiles.push(candidate.snapshotFile)
      baselines.push({
        filePath: candidate.filePath,
        snapshotFile: candidate.snapshotFile,
        checkpointId: candidate.id,
        createdAt: candidate.createdAt,
      })
    }
  }

  return {
    retainedCheckpointIds: retained.map(entry => entry.id),
    discardedCheckpointIds: discarded.map(entry => entry.id),
    deletedSnapshotFiles,
    pinnedSnapshotFiles,
    baselines,
  }
}
