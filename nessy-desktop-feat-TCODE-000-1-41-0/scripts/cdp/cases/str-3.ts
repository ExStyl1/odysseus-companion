/**
 * STR-3 — CODEX'S NATIVE `turn/steer`, LIVE.
 *
 * Landed in `055bd70ad`, unit-tested, and never run against a real app-server
 * until this case. Unlike Claude's emulation there is nothing to fail to deliver
 * quietly: `turn/steer` carries a REQUIRED `expectedTurnId`, so the server itself
 * refuses a steer aimed at a turn that has moved on, and `NonSteerableTurnKind`
 * (`"review" | "compact"`) names the two turn kinds that cannot take one. A
 * refusal comes back as `steer_undelivered` on the turn's own sink and
 * `SessionManager` re-queues it.
 *
 * ## THE DETECTORS, and the one this runtime does not have
 *
 * **Codex leaves no transcript.** `codex-agent.ts` mints its `CODEX_HOME` with
 * `mkdtempSync` and `rmSync`s it on teardown, so the instrument `STR-1` leans on
 * — the CLI's own record of the injection, in a file the host does not author —
 * does not exist here. `runtime-session-log.ts` states that and warns against
 * quietly moving a claim to the runtime that happens to be readable. So this case
 * uses three weaker readings that do not overlap:
 *
 * 1. **The turn's own tool sequence — the load-bearing one.** The seed asks for
 *    six sequential probe commands and then a note carrying build id `ALPHA…`;
 *    the correction, typed after the first command comes back, says the id is
 *    `BETA…` and to skip the rest. A correction delivered INTO the running turn
 *    cuts the sequence short and the answer carries `BETA…`. A queued one lets
 *    all six run and answers `ALPHA…` first. That is a consequence of delivery,
 *    not a field about it.
 * 2. **The app's own debug record of the request.** `CodexAgent.redirect` logs
 *    `Codex steering turn <expectedTurnId>` before the request and
 *    `Codex steer refused (<reason>)` on rejection — the two halves it promises to
 *    report. Both reach the dev build's log. This proves the REQUEST and the
 *    absence of a refusal; it proves nothing about the model.
 * 3. **`mid-stream send`** — which branch `SessionManager` took at all.
 *
 * And one OPEN QUESTION the code itself asked this sitting to settle:
 * `TurnSteerResponse` is `{ turnId }`, and whether that is an echo of the steered
 * turn or a NEW turn id decides whether the running turn's accounting still
 * holds. `redirect()` logs the disagreement rather than acting on it —
 * *"the live sitting reads this line first"* — so this case reports that line
 * whether or not it appears.
 *
 * ## THE CONTROL THAT MUST BE ABLE TO FAIL
 *
 * The same probe on `queue`, in a second fresh session on the same card in the
 * same run. It must let the sequence finish and answer the correction separately.
 * Without it, "the sequence stopped early" could be the model losing interest.
 */

import { randomBytes } from 'node:crypto'

import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import {
  appLogOffset,
  correctionPrompt,
  longToolTaskPrompt,
  readMidStreamSends,
  readSessionLogMatching,
  readSteerRequeues,
  readSubmitControl,
  requireTurnStarted,
  restoreMidStreamBehavior,
  setMidStreamBehavior,
  submitWithoutWaiting,
  toolActivity,
  transcriptWithQueueFlags,
  waitForFirstTool,
  waitUntilProcessing,
  waitUntilSettled,
  type MidStreamBehavior,
  type SubmitControlRead,
} from '../lib/mid-stream.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, isProcessing, setPermissionMode } from '../lib/state.ts'

const ID = 'STR-3'
const TITLE = "Codex's native turn/steer delivers a mid-turn correction into the running turn, and `queue` does not"

const PROBE_STEPS = 6

function token(prefix: string): string {
  return `${prefix}${randomBytes(3).toString('hex').toUpperCase()}`
}

/**
 * A `codex-runtime` card that completes a turn, chosen BY MEASUREMENT.
 *
 * Same rule as `resolveClaudeCard`: a pinned card turns an upstream refusal into
 * a wave-wide BLOCKED and produces no evidence at all. `NESSY_CDP_CODEX_CARD`
 * names the one to try first.
 */
async function resolveCodexCard(session: CdpSession, run: CaseRun): Promise<string> {
  const requested = process.env.NESSY_CDP_CODEX_CARD?.trim()
  const connections = await listConnections(session)
  const cards = connections.filter(row => row.providerType === 'codex-runtime')
  run.observe('codex-runtime cards on this host', cards.map(row => row.slug))
  if (cards.length === 0) {
    blocked(
      'this case needs a codex-runtime connection; the host lists '
      + `${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}. `
      + "`turn/steer` is codex's own protocol method — on a host without a codex card the path never runs.",
    )
  }
  if (requested && !cards.some(row => row.slug === requested)) {
    blocked(`NESSY_CDP_CODEX_CARD names "${requested}", which is not a codex-runtime connection here. `
      + `Available: ${cards.map(row => row.slug).join(', ')}.`)
  }
  return requested ?? cards[0]!.slug
}

interface ArmResult {
  behavior: MidStreamBehavior
  seedId: string
  correctionId: string
  probeCommandsRun: number
  markedCommands: number
  toolNames: string[]
  answers: string[]
  answerHasCorrectedId: boolean
  answerHasOriginalId: boolean
  correctionQueuedInFlight?: boolean
  processingWhenCorrectionSent: boolean
  submitControl?: SubmitControlRead
  steerRequests: string[] | undefined
  steerRefusals: string[] | undefined
  differentTurnIdWarnings: string[] | undefined
  midStreamSends?: unknown
  steerRequeues?: number
  settledAfterMs: number
  processingGaps: number
  timedOut: boolean
}

async function runArm(
  run: CaseRun,
  session: CdpSession,
  cardSlug: string,
  behavior: MidStreamBehavior,
): Promise<ArmResult> {
  const seedId = token('ALPHA')
  const correctionId = token('BETA')
  const marker = `STR3${randomBytes(2).toString('hex').toUpperCase()}`

  const key = await freshSession(session, `CDP ${ID} ${behavior} ${new Date().toISOString().slice(11, 19)}`)
  run.require(`[${behavior}] the arm ran in a session it created`, key.fresh,
    key.fresh ? undefined : `${key.reason} (inherited ${key.inheritedMessages} messages)`)
  const outcome = await switchRuntime(session, key.sessionId, cardSlug)
  run.observe(`[${behavior}] switch onto ${cardSlug}`, outcome)
  const active = await waitForConnection(session, key.sessionId, cardSlug)
  run.require(`[${behavior}] the session runs on ${cardSlug}`, active === cardSlug, `llmConnection=${String(active)}`)
  await setPermissionMode(session, key.sessionId, 'bypassPermissions')

  const logOffset = appLogOffset()

  await submitWithoutWaiting(session, longToolTaskPrompt(seedId, PROBE_STEPS, marker))
  run.observe(`[${behavior}] the app reported a turn in flight after (ms)`, await waitUntilProcessing(session, key))

  const firstTool = await waitForFirstTool(session, key)
  run.observe(`[${behavior}] tool activity before the correction`, firstTool)
  if (firstTool.names.length === 0) {
    const messages = await transcriptWithQueueFlags(session, key)
    requireTurnStarted(run, messages.filter(m => m.role === 'error').map(m => m.content), `[${behavior}] the seed turn`)
    blocked(
      `[${behavior}] the seed turn ran no command, so there was no multi-step sequence for a correction to cut short `
      + 'and the tool-sequence detector — the only one on this runtime that measures a CONSEQUENCE rather than a '
      + 'request — has nothing to read. Re-run; this is the model\'s choice.',
    )
  }

  const processingAtSend = await isProcessing(session, key)
  let control: SubmitControlRead | undefined
  await submitWithoutWaiting(session, correctionPrompt(seedId, correctionId), async () => {
    control = await readSubmitControl(session)
  })
  run.observe(`[${behavior}] the composer's own primary control, with the correction typed and the turn running`, control)

  const inFlight = await transcriptWithQueueFlags(session, key)
  const inFlightCorrection = inFlight.find(message => message.role === 'user' && message.content.includes(correctionId))
  run.observe(`[${behavior}] the correction's isQueued while the turn was still running`,
    inFlightCorrection ? inFlightCorrection.isQueued : '(not in the transcript yet)')

  const settle = await waitUntilSettled(session, key)
  run.observe(`[${behavior}] settled`, settle)

  const messages = await transcriptWithQueueFlags(session, key)
  requireTurnStarted(run, messages.filter(m => m.role === 'error').map(m => m.content), `[${behavior}] the arm`)
  const tools = toolActivity(messages)
  // Every probe command carries this run's marker, so the count is attributable
  // to this arm rather than to whatever else the session did.
  const markedCommands = messages.filter(message =>
    JSON.stringify(message.toolInput ?? '').includes(`probe-${marker}-`)
    || (message.toolResult ?? '').includes(`probe-${marker}-`)).length
  // THE COUNT THAT IS ASSERTED ON is the tool-call count, not the marker count.
  // The marker read depends on the transcript carrying `toolInput`/`toolResult`
  // for a codex row; a first run of this case dropped both from its read, counted
  // zero probe commands in an arm that had plainly run six, and scored its own
  // CONTROL as failed. The tool rows themselves are what the app records either
  // way, and `STR-4` proves independently — with `ps` — that each one is a real
  // `sleep 3` process.
  const probeCommandsRun = tools.names.filter(name => /bash|shell|exec/i.test(name)).length
  const answers = messages.filter(m => m.role === 'assistant' && m.content.trim()).map(m => m.content.slice(0, 300))
  run.observe(`[${behavior}] the turn's tools and answers`, { tools, probeCommandsRun, markedCommands, answers })

  const steerRequests = readSessionLogMatching(logOffset, /Codex steering turn/)
  const steerRefusals = readSessionLogMatching(logOffset, /Codex steer (refused|declined)/)
  const differentTurnId = readSessionLogMatching(logOffset, /Codex steer answered with a DIFFERENT turn id/)
  run.observe(`[${behavior}] the app's own record of the steer request`, steerRequests ?? '(no application log)')
  run.observe(`[${behavior}] refusals`, steerRefusals ?? '(no application log)')
  run.observe(`[${behavior}] TurnSteerResponse turn-id disagreement (the open question redirect() logged)`,
    differentTurnId ?? '(no application log)')

  const sends = readMidStreamSends(logOffset, key.sessionId)
  run.observe(`[${behavior}] the app's own \`mid-stream send\` record`, sends ?? '(no application log)')
  const requeues = readSteerRequeues(logOffset, key.sessionId)

  return {
    behavior,
    seedId,
    correctionId,
    probeCommandsRun,
    markedCommands,
    toolNames: tools.names,
    answers,
    answerHasCorrectedId: answers.some(text => text.includes(correctionId)),
    answerHasOriginalId: answers.some(text => text.includes(seedId)),
    ...(inFlightCorrection ? { correctionQueuedInFlight: inFlightCorrection.isQueued === true } : {}),
    processingWhenCorrectionSent: processingAtSend === true,
    ...(control ? { submitControl: control } : {}),
    steerRequests,
    steerRefusals,
    differentTurnIdWarnings: differentTurnId,
    ...(sends ? { midStreamSends: sends } : {}),
    ...(requeues === undefined ? {} : { steerRequeues: requeues }),
    settledAfterMs: settle.settledAfterMs,
    processingGaps: settle.processingGaps,
    timedOut: settle.timedOut,
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const card = await resolveCodexCard(session, run)
  run.observe('card under test', card)

  let previous: MidStreamBehavior | undefined
  let touched = false
  try {
    const toSteer = await setMidStreamBehavior(session, card, 'steer')
    previous = toSteer.previous
    touched = true
    run.observe('the connection was moved to `steer`', toSteer)
    run.require('the app itself now reports `steer` for this connection', toSteer.ok, JSON.stringify(toSteer))

    const steer = await runArm(run, session, card, 'steer')
    run.observe('steer arm', steer)
    run.require('[steer] a turn was in flight when the correction was typed', steer.processingWhenCorrectionSent,
      'nothing was steered, so every check below is void')

    run.check('the app asked the app-server to steer, naming the turn it expected',
      steer.steerRequests === undefined ? true : steer.steerRequests.length > 0,
      steer.steerRequests === undefined ? '(no application log — corroboration unavailable)' : JSON.stringify(steer.steerRequests))
    run.check('and the app-server did not refuse it',
      steer.steerRefusals === undefined ? true : steer.steerRefusals.length === 0,
      JSON.stringify(steer.steerRefusals))
    run.check('[steer] the app took the steer branch',
      Array.isArray(steer.midStreamSends)
        ? (steer.midStreamSends as Array<Record<string, unknown>>).some(send => send.behavior === 'steer' && send.steered === true)
        : true,
      JSON.stringify(steer.midStreamSends))
    run.check(
      'THE CLAIM: the correction reached the running turn — the six-command sequence was cut short',
      steer.probeCommandsRun < PROBE_STEPS,
      `${steer.probeCommandsRun} of ${PROBE_STEPS} probe commands ran (${JSON.stringify(steer.toolNames)})`,
    )
    run.check(
      'and the answer carries the CORRECTED build id',
      steer.answerHasCorrectedId,
      JSON.stringify(steer.answers),
    )
    run.check('[steer] nothing had to be re-queued',
      steer.steerRequeues === undefined ? true : steer.steerRequeues === 0,
      `${String(steer.steerRequeues)} re-queue lines`)

    // ---- THE CONTROL -------------------------------------------------------
    const toQueue = await setMidStreamBehavior(session, card, 'queue')
    run.observe('the connection was moved to `queue` for the control', toQueue)
    run.require('the app itself now reports `queue` for this connection', toQueue.ok, JSON.stringify(toQueue))

    const queue = await runArm(run, session, card, 'queue')
    run.observe('queue arm', queue)
    run.require('[queue] a turn was in flight when the correction was typed', queue.processingWhenCorrectionSent,
      'the control arm had nothing to queue behind')
    run.check('[queue] no steer was requested at all',
      queue.steerRequests === undefined ? true : queue.steerRequests.length === 0,
      JSON.stringify(queue.steerRequests))
    run.check(
      'THE CONTROL: on `queue` the running turn finished its sequence uncorrected — all six commands ran',
      queue.probeCommandsRun >= PROBE_STEPS,
      `${queue.probeCommandsRun} of ${PROBE_STEPS} (${JSON.stringify(queue.toolNames)})`,
    )
    run.check(
      'and it answered the ORIGINAL build id before the correction was ever read',
      queue.answerHasOriginalId,
      JSON.stringify(queue.answers),
    )
    run.check(
      'the two arms differ on the one thing the case is about — so the positive result was a measurement, not a constant',
      steer.probeCommandsRun < queue.probeCommandsRun,
      `steer ran ${steer.probeCommandsRun}, queue ran ${queue.probeCommandsRun}`,
    )
    run.check('the composer offered a different primary control in the two arms',
      Boolean(steer.submitControl?.label && queue.submitControl?.label
        && steer.submitControl.label !== queue.submitControl.label),
      `steer=${JSON.stringify(steer.submitControl)} queue=${JSON.stringify(queue.submitControl)}`)
  } finally {
    if (touched) {
      const restored = await restoreMidStreamBehavior(session, card, previous)
      run.observe("the operator's own setting was put back", { previous: previous ?? '(unset)', restored })
    }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
