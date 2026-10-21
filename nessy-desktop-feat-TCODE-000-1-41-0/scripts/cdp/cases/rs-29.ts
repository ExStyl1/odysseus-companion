/**
 * RS-29 (P6.851's residual) — claude's `/rewind` really RESTORES a file
 * checkpoint.
 *
 * P6.851 is decided and built: enable file checkpointing on claude behind the
 * same setting Pi and codex already read (`fileCheckpointingEnabled`),
 * native-first. The decision tail names what is left: *"the restore path is a
 * P7.5 case before anyone relies on it."* Turning on a PRODUCER hands `/rewind`
 * a restore path nobody has ever driven on that runtime, and the risk of a
 * rewind that reports success for an operation that did nothing is exactly what
 * this case is for.
 *
 * ## The detector: the command's own answer, and the field that changes its meaning
 *
 * `sessionCommand(id, { type: 'rewindToMessage', messageId, restoreFiles: true })`
 * returns a `ConversationRewindResult`. Two of its fields must be read together
 * or neither should be quoted:
 *
 * - `restoredCheckpoints` — how many it reverted;
 * - `fileCheckpointsTracked` — whether this session's runtime creates file
 *   checkpoints AT ALL. Its own docblock states the trap: with it `false`,
 *   `restoredCheckpoints: 0` is not *"nothing needed restoring"*, it is
 *   *"nothing could be"*, and the two are indistinguishable at every surface.
 *
 * On a claude session before P6.851 the honest answer is `tracked: false`. So
 * this case's first job is to say which world it is in, and its second is to
 * prove the restore actually happened on disk — because a count is a claim and
 * the file is the fact.
 *
 * ## The controls
 *
 * 1. **`rewindTrackedChanges` BEFORE the rewind** — the read-only pre-click half
 *    (P6.103). It says which anchors a file-restoring rewind would revert
 *    something for. If it reports nothing, the producer never ran and every
 *    number afterwards is a zero that means nothing.
 * 2. **A file the AGENT never touched**, written by this case inside the same
 *    window. A rewind must leave it alone. Without it, "the file came back" is
 *    consistent with a blanket restore of the whole directory, which is a
 *    different and much worse product.
 *
 * ## What the operator adds by hand
 *
 * The case drives the same command the UI dispatches, which is the state-first
 * read the harness prefers over a menu click that may or may not have landed.
 * The sitting should ALSO open `/rewind` once and confirm the menu offers the
 * anchor — that half is about the affordance, not the restore, and one glance
 * settles it.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, boundCard, listConnections, runtimeOf, trustScratchProject } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, sessionCommandResult, setPermissionMode, transcript } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-29'
const TITLE = 'claude’s /rewind restores a file checkpoint — the count, the file on disk, and the file it must not touch'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.851',
  runtimes: ['claude'],
  credentials: 'owner: a claude-runtime card, already signed in, on a build with `fileCheckpointingEnabled` on. No key is read.',
} as const satisfies CaseMeta

interface RewindResult {
  success: boolean
  messageId: string
  removedMessages?: number
  restoredCheckpoints?: number
  fileCheckpointsTracked?: boolean
  skippedLinks?: number
  skippedPaths?: readonly { path?: string; reason?: string }[]
  error?: string
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  const slug = await boundCard(session, key.sessionId)
  const rows = await listConnections(session)
  const connection = rows.find(r => r.slug === slug)
  if (!connection || runtimeOf(connection.providerType) !== 'anthropic') {
    blocked(
      'this case measures the CLAUDE restore path and refuses to pass vacuously on a runtime that has always had one. '
      + `This session is on ${connection ? `${connection.slug}(${connection.providerType})` : 'no connection'}.`,
    )
  }
  run.observe('card', { slug: connection.slug, providerType: connection.providerType })

  // The posture — PR-3 (W14-sit, 2026-09-11). Both probe turns are file writes
  // inside the session's own working directory, which is precisely what
  // `acceptEdits` auto-approves (`pre-tool-use.ts`: the filesystem commands,
  // bounded by the session roots). With no posture the first write raises a card
  // and the case measures an unanswered approval instead of a checkpoint; with
  // `bypassPermissions` it would also skip the protected-path floor, which this
  // case has no business standing down. The approver underneath is the net, and
  // its count is recorded.
  const setMode = await setPermissionMode(session, key.sessionId, 'acceptEdits').then(() => 'set').catch(error => `refused: ${String(error)}`)
  run.observe('permission-posture', { posture: 'acceptEdits', outcome: setMode })
  const approver = approvePermissionsWhile(session, key.sessionId)

  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs29-')))
  const probeFile = join(workspace, 'probe.txt')
  const untouchedFile = join(workspace, 'untouched.txt')
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const first = `RS29-FIRST-${stamp}`
  const second = `RS29-SECOND-${stamp}`
  const untouched = `RS29-UNTOUCHED-${stamp}`
  run.observe('workspace', { workspace, probeFile, untouchedFile })

  try {
    await bindProject(run, session, key.sessionId, workspace, {
      gate: () => trustScratchProject(session, workspace),
    })

    // ---- the tracked edit ---------------------------------------------------
    await sendPrompt(session, key, `Create a file called probe.txt in your working directory whose only line is ${first}.`, 240_000)
    run.require(
      'the agent created the probe file',
      safeRead(probeFile).includes(first),
      `probe.txt does not hold ${first}; there is nothing for a checkpoint to be taken of`,
    )

    // The negative control, written by THIS case so no tool call ever touched
    // it. A rewind that reverts it is restoring a directory, not a checkpoint.
    writeFileSync(untouchedFile, `${untouched}\n`, 'utf8')

    const beforeSecond = (await transcript(session, key)).length
    await sendPrompt(session, key, `Now change the only line of probe.txt to ${second}.`, 240_000)
    run.require(
      'the agent made the second, rewindable edit',
      safeRead(probeFile).includes(second),
      `probe.txt does not hold ${second}; the rewind below would have nothing to undo`,
    )

    // ---- CONTROL 1 — the pre-click read -------------------------------------
    const tracked = await sessionCommandResult<unknown>(session, key.sessionId, { type: 'rewindTrackedChanges' })
    run.observe('rewind-tracked-changes', tracked)

    // The anchor: the user message that opened the second turn. Rewinding to it
    // is what should put probe.txt back to its first content.
    const anchor = (await transcript(session, key)).slice(beforeSecond).find(m => m.role === 'user')
    run.require(
      'the second turn’s user message is a usable rewind anchor',
      anchor !== undefined,
      'no user message was added by the second turn — the transcript does not carry an anchor to rewind to',
    )

    const result = await sessionCommandResult<RewindResult>(session, key.sessionId, {
      type: 'rewindToMessage',
      messageId: anchor!.id,
      restoreFiles: true,
    })
    run.observe('rewind-result', result)

    // The field that decides what the count MEANS. Read first, always.
    if (result.fileCheckpointsTracked !== true) {
      run.check(
        'this claude session creates file checkpoints at all',
        false,
        `fileCheckpointsTracked=${String(result.fileCheckpointsTracked)} — restoredCheckpoints=${String(result.restoredCheckpoints)} therefore means`
        + ' "nothing COULD be restored", not "nothing needed restoring". Record the cell as the producer being off on this build'
        + ' (P6.851 enables it behind `fileCheckpointingEnabled`) rather than as a broken restore.',
      )
      return
    }

    run.check(
      'the rewind reports restoring at least one checkpoint',
      (result.restoredCheckpoints ?? 0) >= 1,
      `restoredCheckpoints=${String(result.restoredCheckpoints)} with tracking ON — the producer ran and the restore did nothing`,
    )
    // The count is a claim; the file is the fact.
    const after = safeRead(probeFile)
    run.check(
      'probe.txt is back to its pre-rewind content ON DISK',
      after.includes(first) && !after.includes(second),
      `it holds ${JSON.stringify(after.slice(0, 200))}`,
    )
    // ---- CONTROL 2 — the file no tool ever touched --------------------------
    run.check(
      'THE CONTROL — the file the agent never touched is left alone',
      safeRead(untouchedFile).includes(untouched),
      'the rewind changed a file no tool call ever wrote — that is a directory restore, not a checkpoint restore',
    )
    run.observe('skipped', { links: result.skippedLinks, paths: result.skippedPaths })
  } finally {
    run.observe('permission-cards-answered', await approver.stop().catch(() => -1))
    try { rmSync(workspace, { recursive: true, force: true }) } catch { /* scratch, not evidence */ }
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const manual = {
  steps: [
    '1. PACKAGED build carrying W10-a\'s P6.851 build, with `fileCheckpointingEnabled` ON. New session on the claude-runtime card.',
    '2. `bun run scripts/cdp/cases/rs-29.ts` with NESSY_CDP_PORT pointed at the app.',
    '3. By hand, once: open `/rewind` in a claude session and confirm the menu OFFERS the anchor. The case drives the command the UI dispatches; this half is about the affordance.',
    '4. If `fileCheckpointsTracked` comes back false, the producer is off on that build — record it as such and do not read the restore as broken.',
  ],
  expected: 'fileCheckpointsTracked true, restoredCheckpoints at least one, probe.txt back to its first content on disk, and the untouched file unchanged.',
  detector: 'the rewind command\'s own return value (`restoredCheckpoints` AND `fileCheckpointsTracked` together, never one alone) plus the file on disk. A count is a claim; the file is the fact.',
  positiveControl: '`rewindTrackedChanges` before the rewind, which must report something tracked; and a file this case wrote itself that no tool ever touched, which the rewind must leave alone.',
  doneMeans: 'the restore path is a P7.5 case before anyone relies on it — measured in the packaged sitting before the default flips.',
} as const satisfies SittingRecipe
