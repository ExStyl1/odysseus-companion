import type { FileCheckpointSkipReason, FileCheckpointSkippedPath } from '@nessy-agent/shared/protocol'

/**
 * i18n keys for the reasons a rewind refuses to touch a tracked path.
 *
 * Keys, not resolved strings: `i18n.t()` must never run at module level. The
 * record is exhaustive over `FileCheckpointSkipReason`, so adding a reason
 * without a user-facing explanation fails to compile — which is the point. A
 * rewind that silently declines has told the user their files are back when they
 * are not.
 */
export const CHECKPOINT_SKIP_REASON_KEYS: Readonly<Record<FileCheckpointSkipReason, string>> = {
  'symlink': 'toast.checkpointSkipReason.symlink',
  'hard-link': 'toast.checkpointSkipReason.hardLink',
  'not-a-regular-file': 'toast.checkpointSkipReason.notRegularFile',
  'parent-directory-missing': 'toast.checkpointSkipReason.parentDirectoryMissing',
  'parent-directory-moved': 'toast.checkpointSkipReason.parentDirectoryMoved',
  'snapshot-unreadable': 'toast.checkpointSkipReason.snapshotUnreadable',
}

/** The distinct reasons behind a set of skipped paths, in first-seen order. */
export function distinctSkipReasonKeys(
  skippedPaths: readonly FileCheckpointSkippedPath[] | undefined,
): string[] {
  const keys: string[] = []
  for (const skipped of skippedPaths ?? []) {
    const key = CHECKPOINT_SKIP_REASON_KEYS[skipped.reason]
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}
