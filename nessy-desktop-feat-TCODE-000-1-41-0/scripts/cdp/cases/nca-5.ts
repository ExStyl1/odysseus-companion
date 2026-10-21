/**
 * NCA-5 — `/clear` on the remote agent: the next prompt starts a conversation
 * with no prior history, and the sidecar under the session dir is gone.
 *
 * `NestorCloudAgent.clearHistory()` does three things
 * (`nestor-cloud-agent.ts:306-315`): `contextStore.reset()` — which is
 * `rm(sidecarPath, {force:true})` — a SessionEnd lifecycle with reason `clear`,
 * and `super.clearHistory()`. The remote side is not told anything; the NEXT
 * prompt simply carries no `contextId`, so the gateway opens a fresh context.
 *
 * ## Why the recall control comes FIRST
 *
 * The claim is that a model cannot recall something after `/clear`. On its own
 * that is unfalsifiable — a model can fail to recall for a dozen reasons that
 * have nothing to do with the clear, and the case would report a pass in a world
 * where the remote context was never carried at all.
 *
 * So the case establishes the POSITIVE half before it clears anything: plant a
 * token, then in a SEPARATE turn ask for it back and require it. Only a session
 * that has demonstrably carried the token across one turn boundary is allowed to
 * prove anything by failing to carry it across the next.
 *
 * That control is the whole design, and it is the same shape `AGT-1` uses for
 * fork inheritance and `RTS-13` for the cross-runtime carry.
 *
 * ## The two file-level assertions
 *
 * - the sidecar is GONE after `/clear` — a filesystem fact, unforgeable;
 * - the sidecar written by the NEXT turn carries a DIFFERENT `contextId` — which
 *   is what "a fresh cloud context" means on the wire, and what a `/clear` that
 *   deleted the file but left the id in memory would fail.
 *
 * `requireSessionDir` runs before either, because a wrong `NESSY_CONFIG_DIR`
 * makes "the sidecar is gone" true for every run ever made.
 */

import { existsSync } from 'node:fs'

import { lastAssistantText, sendPrompt, sendSlashCommand } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, isProcessing, transcript, waitFor } from '../lib/state.ts'
import {
  CLOUD_PROVIDER_TYPE,
  chatPaneText,
  cloudTranscript,
  composerCapabilities,
  createSessionOn,
  currentWorkspaceId,
  openSessionInUi,
  probeToken,
  readSidecar,
  requireCloudConnection,
  requireSessionDir,
  sidecarPath,
  waitForChatText,
  waitForSidecar,
} from '../lib/nestor-cloud.ts'

const ID = 'NCA-5'
const TITLE = '/clear on the remote agent deletes the context sidecar and the next prompt opens a fresh cloud context, proven against a recall control taken first'

/** `base-agent.ts:4275-4289` — the one cross-backend `/clear` arm's own info. */
const CLEARED_NOTICE = 'Context cleared'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const cloud = await requireCloudConnection(session, {
    pinnedSlug: process.env.NESSY_CDP_CLOUD_SLUG,
    purpose: 'NCA-5',
  })
  run.observe('cloud connection', { slug: cloud.slug, baseUrl: cloud.baseUrl ?? '(built-in)' })

  const workspaceId = await currentWorkspaceId(session)
  const key = await createSessionOn(run, session, { workspaceId, slug: cloud.slug, label: 'clear', caseId: ID })
  if (!key) blocked('could not create a session on the remote-agent connection')
  run.check('the pane followed the new session', await openSessionInUi(session, key), key.sessionId)

  const caps = await composerCapabilities(session, key.sessionId)
  run.require(
    'the session reports the remote agent as its active runtime',
    caps.activeRuntime === CLOUD_PROVIDER_TYPE,
    `activeRuntime=${String(caps.activeRuntime)}`,
  )

  // --- plant ---------------------------------------------------------------
  // Stated, never "remembered": `lib/codeword.ts` records what the word
  // "remember" costs — the model reaches for its memory tool and writes the
  // token into a file every later child can read, and the control goes void.
  const token = probeToken()
  await sendPrompt(
    session,
    key,
    `For this conversation only, the build tag is ${token}. Do not write it to any file. Reply with exactly OK.`,
    600_000,
  )

  requireSessionDir(key)
  const planted = await waitForSidecar(key, read => Boolean(read.contextId), 30_000)
  run.observe('sidecar after the plant', {
    present: planted.present, path: planted.path, contextId: planted.contextId, activeTaskId: planted.activeTaskId,
  })
  if (!planted.present || !planted.contextId) {
    blocked(
      `no remote context id in ${planted.path} after a completed turn, so there is nothing for /clear to clear. `
      + 'Either NESSY_CONFIG_DIR does not name the dir the app was launched with, or the turn never reached the '
      + 'gateway.',
    )
  }
  const contextBefore = planted.contextId

  // --- the control: the session DOES carry it across a turn boundary -------
  const recall = await sendPrompt(session, key, 'What is the build tag for this conversation?', 600_000)
  const recalled = lastAssistantText(recall.added)
  run.observe('recall before /clear', recalled.slice(0, 300))
  if (!recalled.includes(token)) {
    blocked(
      'the CONTROL did not establish: the remote agent could not repeat the build tag one turn after being told it, '
      + 'so this session has never been shown to carry context at all and its failure to carry it after /clear would '
      + `prove nothing. It answered: ${JSON.stringify(recalled.slice(0, 300))}`,
    )
  }
  run.check('control: the remote agent carries the tag across a turn boundary', true, token)

  // --- /clear --------------------------------------------------------------
  // Selected from the palette, never typed as prose: selection is what turns
  // typed text into a command, and `/clear` is a MESSAGE_COMMAND that submits
  // on selection (`slash-command-actions.ts`), so the composer is left empty.
  const cleared = await sendSlashCommand(session, key, {
    token: 'clear',
    match: /clear/i,
    expectComposer: '',
    submitOnSelect: true,
    // F1.491 — not a turn `waitForTurn` can see end: the host EMPTIES the live
    // transcript when `/clear` completes (`SessionManager`'s `/clear` arm of the
    // complete handler), so the count never grows past the one read before the
    // send, and the waited form only ever returned through the window F1.491
    // closed. The emptying is awaited below instead, as `clearConversation` does.
    noWait: true,
  })
  run.observe('palette entries offered for "clear"', cleared.selection.paletteItems)

  const notice = await waitForChatText(
    session,
    text => text.includes(CLEARED_NOTICE),
    { label: 'the cleared notice', timeoutMs: 60_000 },
  )
  // The notice is a TRANSIENT info: `SessionManager`'s `case 'info'` persists
  // only `Compacted…` and warning-level rows, so this is read off the rendered
  // pane and never out of `getSessionMessages`.
  run.check(
    `the chat pane shows the "${CLEARED_NOTICE}…" notice`,
    notice.found,
    notice.found ? CLEARED_NOTICE : `pane tail: ${notice.text.slice(-300)}`,
  )

  const gone = await waitForSidecar(key, read => !read.present, 30_000)
  run.check(
    'the remote-agent context sidecar is deleted',
    !gone.present && !existsSync(sidecarPath(key)),
    `${sidecarPath(key)} ${gone.present ? 'still exists' : 'is gone'}`,
  )

  // The clear has ENDED only once the live transcript is empty and nothing is
  // processing; the claim's turn below is measured against that empty baseline.
  await waitFor(
    async () => ({ messages: (await transcript(session, key)).length, processing: await isProcessing(session, key) }),
    v => v.messages === 0 && !v.processing,
    { timeoutMs: 180_000, intervalMs: 1_000, label: 'the /clear to empty the live transcript' },
  )

  // --- the claim -----------------------------------------------------------
  const afterClear = await sendPrompt(session, key, 'What is the build tag for this conversation?', 600_000)
  const answer = lastAssistantText(afterClear.added)
  run.observe('recall after /clear', answer.slice(0, 300))
  // An empty answer — a turn that errored, or one that said nothing — cannot
  // show the tag is gone, and the absence check below would pass on it.
  run.check(
    'the post-clear turn answered at all — an empty answer cannot prove the tag is gone',
    answer.trim().length > 0,
    `${answer.trim().length} chars; rows this turn added: [${afterClear.added.map(m => m.role).join(', ')}]`,
  )
  run.check(
    'the cleared conversation cannot produce the tag',
    !answer.includes(token),
    answer.includes(token)
      ? `the answer still carries ${token} — the remote context survived /clear`
      : 'the tag is absent from the answer',
  )

  const reopened = await waitForSidecar(key, read => Boolean(read.contextId), 30_000)
  run.observe('sidecar after the post-clear turn', {
    present: reopened.present, contextId: reopened.contextId, activeTaskId: reopened.activeTaskId,
  })
  run.check(
    'the next prompt opened a DIFFERENT cloud context',
    Boolean(reopened.contextId) && reopened.contextId !== contextBefore,
    `${String(contextBefore)} → ${String(reopened.contextId)}`,
  )

  const after = await cloudTranscript(session, key)
  run.observe('transcript roles after the run', [...new Set(after.map(m => m.role))])
  run.observe('final pane tail', (await chatPaneText(session).catch(() => '')).slice(-400))
  run.observe('final sidecar', readSidecar(key).raw)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
