/**
 * NCA-8 — reasoning frames render AS reasoning.
 *
 * T1's stricter gate: the codec's `reasoning` branch now requires the backend's
 * `data_type` envelope instead of the old free-string guess —
 *
 * ```ts
 * if (data.data_type === 'reasoning' && typeof data.reasoning === 'string') {
 *   outputs.push({ kind: 'agent_event', event: {
 *     type: 'text_complete', text: data.reasoning, isIntermediate: true, turnId } })
 * }
 * ```
 * (`nestor-cloud/event-adapter.ts:225-236`)
 *
 * so a live turn that reasons is the only proof the envelope was read right. A
 * unit test proves the branch fires on a fixture; it cannot prove the backend
 * still sends that shape.
 *
 * ## The detector
 *
 * `isIntermediate` survives all the way to the stored message —
 * `SessionManager.ts:23723` assigns it onto the assistant message it appends —
 * so the claim is readable out of `getSessionMessages`. `lib/state.ts`
 * `transcript()` drops the field, which is why this wave reads through
 * `cloudTranscript()`.
 *
 * On THIS backend the reasoning branch is the only producer of an intermediate
 * `text_complete` (the other two data arms produce a `status` line and a
 * read-only tool card), so an `assistant` row with `isIntermediate === true` in
 * a cloud session is a decoded reasoning frame and nothing else.
 *
 * ## What would make it pass vacuously, and what stops it
 *
 * | Vacuous world | What stops it |
 * | --- | --- |
 * | Some earlier turn in a reused session left an intermediate row | The session is created for this run and asserted empty first. |
 * | The reasoning row IS the answer, so nothing was "rendered as reasoning" | A non-intermediate assistant row is required as well: the reply and the reasoning must be two different rows. |
 * | The frame arrived but was skipped, and the case reports absence as a product fault | The app log is checked for `Skipped A2A part with no recognised content key` in the same window — a skip is reported as the finding it is, not as "no reasoning". |
 * | The model simply did not reason | BLOCKED, not FAIL. This case cannot make a model think out loud, and a red there would be a finding about the prompt. |
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi } from '../lib/state.ts'
import {
  CLOUD_PROVIDER_TYPE,
  appLogSince,
  cloudTranscript,
  composerCapabilities,
  countIn,
  createSessionOn,
  currentWorkspaceId,
  linesContaining,
  openAppLog,
  openSessionInUi,
  requireCloudConnection,
} from '../lib/nestor-cloud.ts'

const ID = 'NCA-8'
const TITLE = 'A live remote turn that reasons produces a separate intermediate assistant row, decoded from the backend\'s own data_type envelope'

const PART_SKIPPED = 'Skipped A2A part with no recognised content key'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // Optional here, unlike NCA-2/NCA-3: the log only tells a MISSING reasoning
  // row apart from a SKIPPED part. Without it the case still measures its claim,
  // and says in the observation that it could not separate the two.
  let log: ReturnType<typeof openAppLog> | undefined
  try {
    log = openAppLog('NCA-8 (separating a skipped part from an absent one)')
  } catch {
    log = undefined
  }
  run.observe('app log', log ?? 'not available — a skipped part cannot be told from an absent one on this run')

  const cloud = await requireCloudConnection(session, {
    pinnedSlug: process.env.NESSY_CDP_CLOUD_SLUG,
    purpose: 'NCA-8',
  })
  run.observe('cloud connection', { slug: cloud.slug, baseUrl: cloud.baseUrl ?? '(built-in)' })

  const workspaceId = await currentWorkspaceId(session)
  const key = await createSessionOn(run, session, { workspaceId, slug: cloud.slug, label: 'reasoning', caseId: ID })
  if (!key) blocked('could not create a session on the remote-agent connection')
  run.check('the pane followed the new session', await openSessionInUi(session, key), key.sessionId)

  const caps = await composerCapabilities(session, key.sessionId)
  run.require(
    'the session reports the remote agent as its active runtime',
    caps.activeRuntime === CLOUD_PROVIDER_TYPE,
    `activeRuntime=${String(caps.activeRuntime)}`,
  )

  const before = await cloudTranscript(session, key)
  run.require(
    'the session starts with no history of its own',
    before.length === 0,
    `${before.length} messages already present — an intermediate row here could be an earlier turn's`,
  )

  // A question with a real intermediate step. Nothing instructs the model to
  // "show its reasoning": whether a reasoning FRAME is emitted is the backend's
  // decision, and a prompt that asked for visible reasoning would be satisfied
  // by ordinary prose in the answer — the wrong row entirely.
  const turn = await sendPrompt(
    session,
    key,
    'A team runs three services. Service A depends on B, B depends on C, and C has a 30 minute deploy. '
    + 'If all three must be redeployed in dependency order and A and B each take 10 minutes, how long is the '
    + 'whole rollout? Give the number and one sentence of justification.',
    900_000,
  )
  run.observe('answer', lastAssistantText(turn.added).slice(0, 400))

  const after = await cloudTranscript(session, key)
  const assistants = after.filter(m => m.role === 'assistant')
  run.observe('assistant rows', assistants.map(m => ({
    intermediate: m.isIntermediate === true,
    chars: m.content.length,
    head: m.content.slice(0, 120),
  })))

  const reasoningRows = assistants.filter(m => m.isIntermediate === true)
  const answerRows = assistants.filter(m => m.isIntermediate !== true && m.content.trim().length > 0)

  if (reasoningRows.length === 0) {
    const skipped = log ? (countIn(appLogSince(log), [PART_SKIPPED])[PART_SKIPPED] ?? 0) : -1
    if (skipped > 0) {
      // This is not "the model did not reason" — it is the envelope drifting,
      // which is the very thing this row's stricter gate exists to catch.
      run.check(
        'the reasoning part was decoded rather than skipped',
        false,
        `${skipped} × "${PART_SKIPPED}" — ${linesContaining(appLogSince(log!), PART_SKIPPED).join(' ⏎ ')}`,
      )
      return
    }
    blocked(
      'no intermediate assistant row arrived, and the log carries no skipped-part warning'
      + (skipped === -1 ? ' (no log was available to check)' : '')
      + '. This case cannot make a model think out loud, and scoring its absence as a failure would be a finding '
      + 'about the prompt rather than about the wire. Re-run; if it recurs with an app log showing no skips, the '
      + 'backend is not sending `data_type: "reasoning"` on this route and THAT is the report.',
    )
  }

  run.check(
    'the turn produced at least one intermediate assistant row — a decoded reasoning frame',
    reasoningRows.length > 0,
    `${reasoningRows.length} rows`,
  )
  run.check(
    'the reasoning is a SEPARATE row from the answer',
    answerRows.length > 0,
    `${answerRows.length} non-intermediate assistant rows; ${reasoningRows.length} intermediate`,
  )
  run.check(
    'the reasoning row carries text',
    reasoningRows.every(m => m.content.trim().length > 0),
    reasoningRows.map(m => m.content.length).join(', '),
  )

  if (log) {
    const skipped = countIn(appLogSince(log), [PART_SKIPPED])[PART_SKIPPED] ?? 0
    run.check(
      'no part of this stream was skipped for an unrecognised content key',
      skipped === 0,
      skipped === 0 ? '0' : linesContaining(appLogSince(log), PART_SKIPPED).join(' ⏎ '),
    )
  }

  const errors = after.filter(m => m.role === 'error')
  run.check(
    'the turn produced no error row',
    errors.length === 0,
    errors.map(m => m.content.slice(0, 200)).join(' | ') || 'none',
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
