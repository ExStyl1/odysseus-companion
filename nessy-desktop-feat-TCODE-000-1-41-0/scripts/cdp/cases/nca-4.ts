/**
 * NCA-4 — the remote agent's follow-up question reaches the user, and the next
 * prompt answers THAT question rather than starting a new one.
 *
 * `ask_followup_question` is one of the two TERMINAL tools
 * (`nestor-cloud/tool-schema.ts` `NESTOR_TERMINAL_TOOL_NAMES`): the backend
 * parks the call, the turn ends `complete` with
 * `terminalReason: 'tool_deferred'`, and the user's next prompt is sent back as
 * that call's `tool_result` on the SAME `taskId`.
 *
 * ## The detector, and the two obvious wrong ones
 *
 * **Wrong detector 1 — the terminal-reason row.** `tool_deferred` is NOT in
 * `TERMINAL_REASON_NOTICE_VALUES` (`core/types/message.ts:1094`), so no
 * `terminal_reason:tool_deferred` row is ever written to the transcript. A case
 * looking for one would find nothing and report a failure about a feature that
 * worked. (Measured against the source, 2026-08-27.)
 *
 * **Wrong detector 2 — "the second reply looks like an answer".** The checklist
 * row names this one itself: *a fresh turn that merely looks sensible is the
 * failure this fixes*. A model handed "the second one" as a bare prompt will
 * produce something plausible whether or not it is continuing anything.
 *
 * **The detector that works is the sidecar.** `NestorCloudContextStore` writes
 * `<session>/meta/nestor-cloud-context.json`, and the parking branch
 * (`nestor-cloud/turn.ts:284-286`) puts `pendingTerminalTool: { toolCallId,
 * name }` in it. The continuation clears it — and can only clear it by
 * answering the call it names, because `update.clearTask` and
 * `clearPendingTerminalTool` are the only two paths that delete the field
 * (`context-store.ts:96-98`), and the parked call is addressed by `taskId`. So:
 *
 * | Observation | What it rules out |
 * | --- | --- |
 * | `pendingTerminalTool.name === 'ask_followup_question'` after turn 1 | the model answered in prose instead of asking; the turn failed |
 * | the question is the turn's LAST text | the harness reading some earlier narration as the question |
 * | after turn 2: no `pendingTerminalTool` | the answer went out as a fresh message, leaving the call parked |
 * | after turn 2: the SAME `contextId` | the second turn started a new conversation |
 *
 * When the model does not ask at all, the case reports BLOCKED — it cannot make
 * a model ask, and a FAIL there would be a finding about the prompt.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi } from '../lib/state.ts'
import {
  CLOUD_PROVIDER_TYPE,
  cloudTranscript,
  composerCapabilities,
  createSessionOn,
  currentWorkspaceId,
  openSessionInUi,
  probeToken,
  readSidecar,
  requireCloudConnection,
  requireSessionDir,
  waitForSidecar,
} from '../lib/nestor-cloud.ts'

const ID = 'NCA-4'
const TITLE = 'A remote follow-up question parks the turn and reaches the user, and the next prompt answers that parked call on the same task'

/** `tool-schema.ts:44-47` — the terminal tool this case is about. */
const ASK_TOOL = 'ask_followup_question'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const cloud = await requireCloudConnection(session, {
    pinnedSlug: process.env.NESSY_CDP_CLOUD_SLUG,
    purpose: 'NCA-4',
  })
  run.observe('cloud connection', { slug: cloud.slug, baseUrl: cloud.baseUrl ?? '(built-in)' })

  const workspaceId = await currentWorkspaceId(session)
  const key = await createSessionOn(run, session, { workspaceId, slug: cloud.slug, label: 'followup', caseId: ID })
  if (!key) blocked('could not create a session on the remote-agent connection')
  run.check('the pane followed the new session', await openSessionInUi(session, key), key.sessionId)

  const caps = await composerCapabilities(session, key.sessionId)
  run.require(
    'the session reports the remote agent as its active runtime',
    caps.activeRuntime === CLOUD_PROVIDER_TYPE,
    `activeRuntime=${String(caps.activeRuntime)}`,
  )

  // --- turn 1: provoke the question ---------------------------------------
  // A genuine ambiguity the agent cannot resolve on its own, phrased so that
  // asking is the cooperative move. Nothing here names a tool: a prompt that
  // names a tool and constrains it trips a guardian as prompt injection
  // (AGENTS.md trap register), and the wreckage reads like a dispatch bug.
  const askTurn = await sendPrompt(
    session,
    key,
    'I want you to write me a one-sentence project summary, but the tone matters a lot to me and I have not '
    + 'told you which one I want. Before you write anything, ask me the single question you most need answered.',
    600_000,
  )
  const question = lastAssistantText(askTurn.added)
  run.observe('the turn\'s last text (the question, if there is one)', question.slice(0, 500))

  requireSessionDir(key)
  const parked = await waitForSidecar(key, read => Boolean(read.pendingTerminalTool?.name), 30_000)
  run.observe('sidecar after turn 1', {
    present: parked.present,
    path: parked.path,
    contextId: parked.contextId,
    activeTaskId: parked.activeTaskId,
    activeTaskStatus: parked.activeTaskStatus,
    pendingTerminalTool: parked.pendingTerminalTool,
  })

  if (!parked.present) {
    blocked(
      `no remote-agent sidecar at ${parked.path} after a completed turn. Either the config dir this case reads is not `
      + 'the one the app was launched with (export NESSY_CONFIG_DIR), or the turn never reached the backend.',
    )
  }
  if (parked.pendingTerminalTool?.name !== ASK_TOOL) {
    blocked(
      `the model did not park a ${ASK_TOOL} call — the sidecar carries `
      + `${JSON.stringify(parked.pendingTerminalTool ?? null)}. This case cannot make a model ask a question, and `
      + 'scoring the prose it produced instead would be a finding about the prompt rather than about the wire. '
      + `The turn's last text was: ${JSON.stringify(question.slice(0, 300))}. Re-run; if it recurs, the remote `
      + 'agent is answering rather than asking and THAT is the report.',
    )
  }
  run.check(
    `turn 1 parked an ${ASK_TOOL} call`,
    parked.pendingTerminalTool?.name === ASK_TOOL,
    JSON.stringify(parked.pendingTerminalTool),
  )
  run.check(
    'the question reached the user as the turn\'s last text',
    question.trim().length > 0,
    `${question.length} chars`,
  )

  const taskBefore = parked.activeTaskId
  const contextBefore = parked.contextId
  run.check('the parked turn recorded a task id', Boolean(taskBefore), String(taskBefore))
  run.check('the parked turn recorded a context id', Boolean(contextBefore), String(contextBefore))

  // --- turn 2: answer it ---------------------------------------------------
  // The answer carries a per-run token so the reply can be tied to THIS answer
  // and not to a plausible-sounding continuation. It is only corroboration: the
  // sidecar assertions below are the load-bearing ones.
  const token = probeToken()
  const answerTurn = await sendPrompt(
    session,
    key,
    `Use a dry, factual tone, and include the marker ${token} at the end of the sentence.`,
    600_000,
  )
  const reply = lastAssistantText(answerTurn.added)
  run.observe('reply to the answer', reply.slice(0, 500))

  const resumed = await waitForSidecar(key, read => !read.pendingTerminalTool, 30_000)
  run.observe('sidecar after turn 2', {
    present: resumed.present,
    contextId: resumed.contextId,
    activeTaskId: resumed.activeTaskId,
    activeTaskStatus: resumed.activeTaskStatus,
    pendingTerminalTool: resumed.pendingTerminalTool,
  })

  run.check(
    'the parked call was answered — the sidecar no longer holds it',
    !resumed.pendingTerminalTool,
    JSON.stringify(resumed.pendingTerminalTool ?? null),
  )
  run.check(
    'the answer continued the SAME remote conversation',
    Boolean(contextBefore) && resumed.contextId === contextBefore,
    `${String(contextBefore)} → ${String(resumed.contextId)}`,
  )
  run.check(
    'the reply carries the marker the answer supplied',
    reply.includes(token),
    reply.includes(token) ? token : `reply did not contain ${token}`,
  )

  const after = await cloudTranscript(session, key)
  const errors = after.filter(m => m.role === 'error')
  run.check(
    'neither turn produced an error row',
    errors.length === 0,
    errors.map(m => m.content.slice(0, 200)).join(' | ') || 'none',
  )

  // Recorded, not asserted: whether the continuation reuses the task id is the
  // backend's to decide (`clearTask` also clears the parked call), and pinning
  // it here would manufacture a finding out of an unexamined boundary.
  run.observe('task id across the continuation', { before: taskBefore, after: resumed.activeTaskId })
  run.observe('final sidecar', readSidecar(key).raw)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
