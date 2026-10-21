/**
 * RS-18 (P6.281) — the Pi checkpoint arm end to end: which restores are skipped
 * and why, whether a rewind survives a resume, and whether the 100-checkpoint
 * retention really discards.
 *
 * Three S measurements sharing ONE rig — a packaged Pi session with tracked
 * edits — which is why the row is one lane and not three: the setup is most of
 * the cost and separating them triples it.
 *
 * ## What is already established, and must not be re-derived here
 *
 * The retention is ENFORCED, not commented: `CHECKPOINT_RETENTION = 100` and
 * `isSnapshotDeletable` in `packages/shared/src/sessions/checkpoint-gc.ts`,
 * applied on every write through `sweepFileCheckpoints`. The skip vocabulary is
 * exhaustive over `FileCheckpointSkipReason` and each member has user-facing
 * copy — `apps/electron/src/renderer/utils/checkpoint-skip.ts` fails to compile
 * if a reason gains no explanation. A sitting does not re-read those; it drives
 * them.
 *
 * The non-Pi cells are derivative: no checkpoint PRODUCER runs on claude or
 * codex today (`RUNTIME_FILE_CHECKPOINT_PRODUCERS`), so those cells read
 * `absent` rather than `n/a`, exactly as the ledger scores their parent F1.
 * RS-29 measures the claude producer separately once W10-a's switch is on;
 * this case is the Pi arm and stays there.
 *
 * ## The six skip reasons, and the ones a rig can actually reach
 *
 * `symlink`, `hard-link`, `not-a-regular-file`, `parent-directory-missing`,
 * `parent-directory-moved`, `snapshot-unreadable`. The row's `done_means` does
 * not demand all six: it demands *"each observed at least once, or the ones that
 * cannot be reached are named as unreachable"*. Naming an unreachable one is a
 * result. Inventing a reading for it is not.
 *
 * ## The detector: the rewind's own return value, not the toast
 *
 * `sessionCommand(id, { type: 'rewindToMessage', messageId, restoreFiles: true })`
 * ANSWERS with a `ConversationRewindResult` carrying `restoredCheckpoints`,
 * `fileCheckpointsTracked`, `skippedLinks` and `skippedPaths` — the app's own
 * account of what it reverted and what it declined. `sessionCommandResult` in
 * `scripts/cdp/lib/state.ts` is the read; a `void` call and a toast cannot
 * separate "the rewind reverted nothing" from "the rewind reverted something and
 * the file assertion is looking at the wrong file".
 *
 * `fileCheckpointsTracked: false` is the one field that changes what the number
 * MEANS: with it false, `restoredCheckpoints: 0` is not "nothing needed
 * restoring", it is "nothing could be". Read both or read neither.
 *
 * ## The half nobody has driven
 *
 * `restoredCheckpoints` appears in eight files of `file-checkpoints.ts`'s
 * persistence path and no probe has ever driven a rewind AFTER a resume. That is
 * clause (b), and it is the reason this row is a measure at all.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-18'
const TITLE = 'the Pi checkpoint arm end to end — the skip reasons, a rewind after a resume, and whether the 100-checkpoint retention discards'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.281',
  runtimes: ['pi'],
  credentials: 'owner: a Pi card (the gateway Pi card is enough — no BYO key is needed). Name the card in the run notes.',
} as const satisfies CaseMeta

/** Exhaustive over `FileCheckpointSkipReason` — the row's "six named reasons". */
export const SKIP_REASONS = [
  'symlink',
  'hard-link',
  'not-a-regular-file',
  'parent-directory-missing',
  'parent-directory-moved',
  'snapshot-unreadable',
] as const

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, one content panel. New session on a Pi card, working directory a scratch git repository this sitting creates — never the operator\'s own tree, because clause (c) deliberately drives a hundred edits through it.',
    '2. Confirm the producer runs at all: make ONE edit through the foreground Edit tool, then read `sessionCommand(id, { type: "rewindTrackedChanges" })`. If it reports nothing tracked, STOP — every measurement below would be scoring an absent producer.',
    '3. (a) SKIP REASONS. Give each reason a subject, then rewind past all of them in one go and read `skippedPaths` off the result: symlink — create a symlink inside the workspace and have the agent edit through it; hard-link — `ln` a tracked file and edit it; not-a-regular-file — a FIFO or a device node in the tracked set; parent-directory-missing — delete the directory of a tracked file after the edit; parent-directory-moved — rename that directory instead; snapshot-unreadable — chmod 000 a snapshot under the session\'s checkpoint store (restore the mode afterwards).',
    '4. Record each reason OBSERVED, with the path it came back on. Any reason this rig cannot reach is written down as UNREACHABLE with the attempt that failed — the row accepts that answer and accepts no other.',
    '5. Also drive the four EDIT ORIGINS the F11 row rides on this same rig: an edit through the foreground Edit tool, an edit through the Bash tool, an edit made by a subagent, and an edit made externally (a shell outside the app). Record which of the four produced a checkpoint.',
    '6. (b) REWIND AFTER A RESUME. In the live session, rewind to a known anchor with `restoreFiles: true` and record `restoredCheckpoints` and the file contents — this is the CONTROL. Then quit the app, relaunch it, reopen the same session (a resume), and drive the SAME rewind to the SAME anchor. The two must restore the same files.',
    '7. (c) RETENTION. Drive past 100 checkpoints in one session — a scripted loop of small tracked edits is enough, and the count is the checkpoint count, not the turn count. At 99, confirm NOTHING has been discarded (the control). At 101, confirm the oldest snapshots are gone AND that each file\'s FIRST snapshot survives, because that first snapshot is the session-diff baseline and losing it silently changes what a diff means.',
    '8. Record every number off the rewind result, never off the toast: `restoredCheckpoints`, `fileCheckpointsTracked`, `skippedLinks`, `skippedPaths[].reason`.',
  ],
  expected: 'Three answers: a table of the six skip reasons marked observed or unreachable-with-the-attempt; a post-resume rewind restoring the same files as the pre-resume one; and a retention boundary where 99 discards nothing, 101 discards the oldest, and every file\'s first snapshot survives.',
  detector: 'the return value of `sessionCommand(id, { type: "rewindToMessage", messageId, restoreFiles: true })` — `restoredCheckpoints`, `fileCheckpointsTracked`, `skippedLinks`, `skippedPaths` — read through `sessionCommandResult`. Plus the filesystem for the restored contents. Never the toast: it is a rendering of the same numbers and it cannot say which file it meant.',
  positiveControl: '(b) the same rewind driven in the LIVE session before the resume. (c) the same session at 99 checkpoints, where nothing may be discarded. And step 2 is the whole rig\'s control: a producer that is not running makes every later number a zero that means nothing.',
  doneMeans: '(a) the six named skip reasons are each observed at least once, or the ones that cannot be reached are named as unreachable; (b) a rewind driven AFTER resuming the session restores the same files as one driven before it, control — the same rewind in the live session; (c) at 101 checkpoints the oldest snapshots are gone and each file\'s FIRST snapshot survives as the session-diff baseline, control — at 99 nothing is discarded.',
  safety: 'The scratch repository is created by the sitting and removed by it. Never point this case at the operator\'s own tree: step 7 makes a hundred edits and step 3 deletes and renames directories inside it on purpose.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
