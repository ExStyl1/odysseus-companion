/**
 * AGT-3 — a fork's permission prompt reaches the user AND unblocks the fork.
 *
 * The most important case in the area. Before `558a3b63` a fork's permission
 * request was emitted with the child's hidden session id, nothing rendered it,
 * and the fork hung with no explanation.
 *
 * Both halves are asserted, because "a prompt that appears and does not unblock
 * is the same hang wearing a friendlier face": the card must RENDER, and after
 * Allow the fork must MOVE — its child status must leave `starting`/`running`
 * into a settled state, or the transcript must grow.
 *
 * Surfaces (verified in source):
 *   card     `[data-tutorial="permission-banner"]`
 *   allow    `[data-tutorial="permission-allow-button"]`
 *   agent    the card prints "Requested by: <agentLabel>" — the child id is NOT
 *            in any attribute, so the fork attribution is a text read.
 */

import type { CdpSession } from '../lib/connect.ts'
import { forkStartFailure, seedForkableConversation, startFork } from '../lib/fork.ts'
import { main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, describeElements, freshSession, piReadNote, piRuntime, setPermissionMode, transcript, visibleElements, waitFor } from '../lib/state.ts'
import { clickSelector } from '../lib/viewport.ts'

const ID = 'AGT-3'
const TITLE = "A fork's permission prompt reaches the user and answering it unblocks the fork"

const PERMISSION_CARD = '[data-tutorial="permission-banner"]'
const ALLOW_BUTTON = '[data-tutorial="permission-allow-button"]'

/**
 * Nothing destructive, and nothing that depends on a project.
 *
 * It must be a call the Ask-mode gate actually stops: a read-only command can be
 * auto-allowed by the read-only allowlist, and then the case would pass with no
 * prompt ever raised. Creating one temp directory is a write — it prompts — and
 * removes nothing.
 */
const APPROVAL_TASK =
  'Run exactly one shell command — `mkdir -p /tmp/nessy-cdp-agt3-probe` — and then tell me whether it succeeded. ' +
  'Do not run anything else and do not delete anything.'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  await setPermissionMode(session, key.sessionId, 'ask')
  run.observe('permission-mode', 'ask')

  // `/subtask` is refused outright in a session that has never run a turn, and a
  // refused fork raises no permission prompt — the case would time out waiting
  // for a card that was never going to exist.
  await seedForkableConversation(session, key)

  const before = (await transcript(session, key)).length
  const started = await startFork(session, key, APPROVAL_TASK)
  run.observe('composer-after-selection', started.selection.selection.composerAfter)
  run.observe('children', started.children)
  run.require(
    'the fork registered',
    started.child !== undefined,
    started.child ? undefined : 'no child: the prompt cannot be attributed to a fork that never started',
  )
  const refused = forkStartFailure(started.child)
  run.require('the fork actually started', refused === undefined, refused)

  // ---- half one: the prompt renders ---------------------------------------
  // Counted by VISIBLE matches. A zero-sized copy of the card in the tree keeps
  // `selectorCount` above zero forever, which both fakes a render and — later —
  // fakes a card that never clears.
  const appeared = await waitFor(
    () => visibleElements(session, PERMISSION_CARD),
    cards => cards.length > 0,
    { timeoutMs: 180_000, intervalMs: 2_000, label: 'a permission card to render' },
  ).catch(() => [])
  run.observe('cards-in-tree', await describeElements(session, PERMISSION_CARD))
  run.require(
    "the fork's permission prompt rendered",
    appeared.length > 0,
    appeared.length > 0 ? undefined : 'no card: this is the 558a3b63 hang — the fork is waiting on a request nothing displays',
  )
  // The card's own text needs its own wait. `innerText` is layout-dependent —
  // the container is `h-full` inside a pane that sizes a frame later — so the
  // read taken the instant the selector matches comes back EMPTY, and a check on
  // empty text reports "the card does not name the agent" about a card that
  // does. Wait for text, then read it.
  const cardText = await waitFor(
    async () => (await visibleElements(session, PERMISSION_CARD)).map(card => card.text).join(' | '),
    text => text.trim().length > 0,
    { timeoutMs: 15_000, intervalMs: 500, label: 'the permission card to render its text' },
  ).catch(() => '')
  run.observe('card-text', cardText.slice(0, 400))
  // `chat.permissionFromAgent` is translated: "Requested by" / "Запросил". The
  // attribution is a text read because the agent label reaches no attribute
  // (`PermissionRequest.tsx`), so the assertion has to know both locales rather
  // than fail on the app's language setting.
  run.check(
    'the card attributes the request to an agent',
    /Requested by|Запросил/i.test(cardText),
    cardText ? cardText.slice(0, 200) : '(the card rendered no text at all)',
  )

  // ---- half two: answering it unblocks the fork ----------------------------
  const beforeAnswer = await piRuntime(session, key)
  run.observe('child-status-before-answer', beforeAnswer.children.map(c => `${c.agentId}:${c.status}`))
  await clickSelector(session, ALLOW_BUTTON)

  const dismissed = await waitFor(
    () => visibleElements(session, PERMISSION_CARD),
    cards => cards.length === 0,
    { timeoutMs: 30_000, intervalMs: 1_000, label: 'the card to clear after Allow' },
  ).catch(async () => visibleElements(session, PERMISSION_CARD))
  run.observe('cards-after-answer', await describeElements(session, PERMISSION_CARD))
  // A card still on screen is two different findings, and the card's own text
  // cannot tell them apart because a re-request of the same command renders
  // identically. Ask the BACKEND what it still considers unanswered:
  // pendingPermissions empty + a card visible = the renderer kept an answered
  // prompt (`App.tsx handleRespondToPermission` exists precisely to stop that,
  // and its comment names "left on screen forever" as the failure). Non-empty =
  // a second, genuine request, and the case simply has not answered it yet.
  // D1.287 — and the read itself has a THIRD outcome. `piRuntime()` swallows a
  // failing snapshot read into `pendingPermissions: []`, which is the very
  // value that names the first of the two findings, so an instrument failure
  // would be reported as a STALE RENDERED CARD — a product defect, in the
  // sentence a reader acts on. This is deliberately NOT `piPendingPermissions`
  // (which BLOCKS): the claim itself is measured from the DOM, and a block
  // raised here would discard the observation that a card remained, inverting
  // `runCase`'s own rule that a failed check beats a missing precondition. The
  // honest answer is the failure said out loud, with the reason.
  const runtimeAfterAnswer = await piRuntime(session, key)
  const pendingAfter = runtimeAfterAnswer.pendingPermissions
  run.observe('pending-permissions-after-answer', runtimeAfterAnswer.readFailed === true
    ? { readFailed: true, unavailableReason: runtimeAfterAnswer.unavailableReason }
    : pendingAfter)
  run.check(
    'the card clears once answered',
    dismissed.length === 0,
    dismissed.length === 0
      ? undefined
      : `${dismissed.length} visible card(s) remain while the backend reports `
        + (runtimeAfterAnswer.readFailed === true
          ? `NOTHING — the snapshot read failed (${runtimeAfterAnswer.unavailableReason ?? 'no reason reported'}), `
            + 'so which of the two findings this is — a stale rendered card, or a further genuine request — '
            + 'was not measured. See `rs-56.ts` for the packaged-build defect behind the failing read.'
          : `${pendingAfter.length} pending request(s). `
            + (pendingAfter.length === 0
              ? 'Backend has nothing pending, so this is a STALE RENDERED CARD — the answered prompt was not removed.'
              : 'The backend still has a pending request, so this is a further prompt rather than a card that failed to clear.')),
  )

  // D1.310 — the child half of this wait is an observation (the transcript arm
  // beside it is what can still satisfy the check), so the read's own verdict
  // travels in the recorded value rather than blocking the case.
  const movedReading = async (): Promise<{ children: string[]; messages: number; readFailed: boolean }> => {
    const runtime = await piRuntime(session, key)
    return {
      children: runtime.children.map(c => `${c.agentId}:${c.status}`),
      messages: (await transcript(session, key)).length,
      readFailed: piReadNote(runtime).readFailed,
    }
  }
  const moved = await waitFor(
    movedReading,
    v => v.messages > before + 1 || v.children.some(s => !/:starting$|:running$/.test(s)),
    { timeoutMs: 180_000, intervalMs: 3_000, label: 'the fork to make progress after approval' },
  ).catch(movedReading)
  run.observe('after-answer', moved)
  run.check(
    'the fork continued after approval',
    moved.messages > before + 1 || moved.children.some(s => !/:starting$|:running$/.test(s)),
    JSON.stringify(moved),
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
