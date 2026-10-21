/**
 * NCA-2 — the live stream's frame shapes are the ones the codec decodes.
 *
 * This is the plan's own re-verification debt: the a2a-go citations behind
 * `nestor-cloud/event-adapter.ts` are from `v2@v2.1.0` while the backend pins
 * `v2.3.1`, and v2.1.0's CHANGELOG shows the JSON discriminator keys churning
 * INSIDE 2.1.0. If a key drifted, nothing fails — the codec logs and skips.
 *
 * **So the detector is the app log, not the reply.** A drifted envelope produces
 * a perfectly ordinary-looking answer with a warning behind it; a case that read
 * the reply would score that as a pass. The checklist row says this in its own
 * words and this file is that instruction, executed.
 *
 * ## The shape of the assertion, and why it needs two halves
 *
 * The claim is an ABSENCE — no skip warnings. An absence finding needs a
 * positive control on the same rig (AGENTS.md trap register), because an empty
 * log window is also produced by:
 *
 * - a turn that never reached the wire (auth failure, no connection);
 * - a log the app is not writing to (a PACKAGED build writes none at all);
 * - a stale read offset after a relaunch.
 *
 * The positive control is the codec's OWN evidence that it decoded this turn:
 * `NestorCloudEventAdapter.captureRequestId` logs `Nestor request id` at info
 * level, once per distinct id, off `metadata.request_details.request_id` — a
 * field the backend stamps on every outgoing message. No decode, no line. The
 * zero-warning assertions are only allowed to count once that line is in the
 * window AND the transcript has actually grown.
 *
 * ## What a failure here looks like
 *
 * `Unknown A2A stream envelope key { keys: [...] }` names the key it did not
 * recognise, and `Skipped A2A part with no recognised content key { keys: [...] }`
 * names the part's. Both are reported verbatim, because the key list IS the
 * finding — it is the new spelling the codec has to learn.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi } from '../lib/state.ts'
import {
  CLOUD_PROVIDER_TYPE,
  CODEC_SKIP_WARNINGS,
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

const ID = 'NCA-2'
const TITLE = 'A live A2A stream decodes without skipping: no unknown envelope key and no unrecognised part, with the codec\'s own request-id line as the positive control'

/** `event-adapter.ts:110` — logged once per distinct id, only after a decode. */
const DECODE_EVIDENCE = 'Nestor request id'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // Opened FIRST, so the window covers everything this case causes — including
  // the agent card fetch and postInit, which happen at session construction.
  const log = openAppLog('NCA-2 (the codec\'s skip warnings)')
  run.observe('app log', log)

  const cloud = await requireCloudConnection(session, {
    pinnedSlug: process.env.NESSY_CDP_CLOUD_SLUG,
    purpose: 'NCA-2',
  })
  run.observe('cloud connection', { slug: cloud.slug, baseUrl: cloud.baseUrl ?? '(built-in)' })

  const workspaceId = await currentWorkspaceId(session)
  const key = await createSessionOn(run, session, { workspaceId, slug: cloud.slug, label: 'frames', caseId: ID })
  if (!key) blocked('could not create a session on the remote-agent connection; there is no stream to decode')
  run.check('the pane followed the new session', await openSessionInUi(session, key), key.sessionId)

  const caps = await composerCapabilities(session, key.sessionId)
  run.require(
    'the session reports the remote agent as its active runtime',
    caps.activeRuntime === CLOUD_PROVIDER_TYPE,
    `activeRuntime=${String(caps.activeRuntime)}`,
  )

  // A prompt broad enough to exercise more than one envelope: prose (message /
  // statusUpdate text parts), a plan (which the backend may return as an
  // artifact), and enough length that the stream is more than one frame.
  const turn = await sendPrompt(
    session,
    key,
    'In three short numbered points, describe how you would approach reviewing an unfamiliar codebase. '
    + 'Keep it under 120 words.',
    600_000,
  )
  const answer = lastAssistantText(turn.added)
  run.observe('answer', answer.slice(0, 300))

  const after = await cloudTranscript(session, key)
  const errors = after.filter(m => m.role === 'error')
  run.observe('error rows', errors.map(m => m.content.slice(0, 200)))

  const window = appLogSince(log)
  run.observe('app log bytes read since the case started', window.length)

  // --- the positive control, before anything is claimed about absence ------
  const decodes = countIn(window, [DECODE_EVIDENCE])[DECODE_EVIDENCE] ?? 0
  const grew = turn.added.length > 0
  run.observe('decode evidence', { line: DECODE_EVIDENCE, count: decodes, transcriptGrew: grew, addedMessages: turn.added.length })
  if (decodes === 0 || !grew) {
    blocked(
      `the positive control did not establish: ${decodes} "${DECODE_EVIDENCE}" lines in the log window and `
      + `${turn.added.length} messages added to the transcript. An absence of skip warnings proves nothing until `
      + 'this run has shown the codec decoded a live stream at all. Causes to separate before reading anything into '
      + `it: the app is not writing to ${log.path} (a PACKAGED build never does); the turn never reached the wire `
      + `(errors: ${errors.map(m => m.content.slice(0, 160)).join(' | ') || 'none'}); or the backend stopped `
      + 'stamping `request_details.request_id`, which is itself a wire finding worth reporting.',
    )
  }
  run.check(
    'the codec decoded this turn — the positive control the absence below needs',
    decodes > 0 && grew,
    `${decodes} request-id lines, ${turn.added.length} messages added`,
  )

  // --- the claim ----------------------------------------------------------
  const counts = countIn(window, CODEC_SKIP_WARNINGS)
  run.observe('skip warnings in the window', counts)
  for (const warning of CODEC_SKIP_WARNINGS) {
    const count = counts[warning] ?? 0
    run.check(
      `the live stream produced no "${warning}"`,
      count === 0,
      count === 0 ? '0' : `${count} — ${linesContaining(window, warning).join(' ⏎ ')}`,
    )
  }

  run.check(
    'the turn produced no error row',
    errors.length === 0,
    errors.map(m => m.content.slice(0, 200)).join(' | ') || 'none',
  )
  run.check('the remote agent answered with text', answer.trim().length > 0, `${answer.length} chars`)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
