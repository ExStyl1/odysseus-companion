/**
 * F1.577 — what the Send-to-workspace toast says about the reasons the pipeline returned.
 *
 * `SendResourceToWorkspaceDialog` runs `resources:export`, then `resources:import`. Both
 * return reasons: the export returns `warnings` (a skipped entry, a stripped header, and so
 * on) and each import bucket returns `failed` and `warnings`. Before this, the dialog sent the
 * export warnings to the console and dropped the import ones. So a send whose every entry was
 * skipped showed "Nothing was sent to <workspace>" with no reason.
 *
 * The toast now shows how many there were and the FIRST one verbatim. Order: the export's
 * warnings, then the import's failures, then its warnings. That is the order in which the
 * pipeline produced them. A failure is shown as `<id>: <error>`, except the whole-bundle
 * refusal, whose id is `*`. Blank strings are not counted. The strings themselves are the
 * server's English diagnostics and are shown as they are; only the wrapper is translated.
 */

import type { ImportBucketResult } from '@nessy-agent/shared/resources'

export interface SendResourceNotes {
  /** How many reasons the export and the import returned together. */
  count: number
  /** The first of them, verbatim. */
  first: string
}

/** The fields of an import bucket this reads; a remote server's answer may omit any of them. */
export type SendResourceImportNotes = Partial<Pick<ImportBucketResult, 'failed' | 'warnings'>>

export function collectSendResourceNotes(
  exportWarnings: readonly string[] | undefined,
  bucket: SendResourceImportNotes | undefined,
): SendResourceNotes | undefined {
  const notes = [
    ...(exportWarnings ?? []),
    ...(bucket?.failed ?? []).map(({ id, error }) => (id === '*' ? error : `${id}: ${error}`)),
    ...(bucket?.warnings ?? []),
  ].filter(note => typeof note === 'string' && note.trim() !== '')
  const first = notes[0]
  return first === undefined ? undefined : { count: notes.length, first }
}
