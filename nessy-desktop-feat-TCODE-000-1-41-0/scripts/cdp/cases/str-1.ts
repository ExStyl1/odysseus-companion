/**
 * STR-1 — A MID-TURN CORRECTION REACHES THE CLAUDE MODEL BEFORE THE TURN ENDS,
 * and the same probe on `queue` proves it could have failed.
 *
 * This is `L8`'s live proof, the last open row of
 * `docs/superpowers/plans/2026-08-17-claude-live-session.md`. The row states the
 * divergence in user terms: you send Claude a task, it goes off working, a minute
 * later you see it is wrong and you type "stop, that's the other API" — and on
 * Claude that message WAITS, because `defaultMidStreamBehavior` returns `queue`
 * for `anthropic` and `claude-runtime`, while on Pi the same message reaches the
 * model mid-turn. The machinery to deliver it (`ClaudeAgent.redirect` → the next
 * `PreToolUse` hook's `additionalContext` → `steer_undelivered` if no tool fires)
 * is built and unit-tested. What has never existed is a live proof, and the
 * plan's recorded order is prove-then-flip precisely so an unproven default
 * cannot ship.
 *
 * ## THE DETECTOR, and why it is not the obvious one
 *
 * `lib/mid-stream.ts` carries the argument in full. In one line: `steered: true`
 * is the PARKED flag — `redirect()` returns it on a precondition, not on a
 * receipt — and "the correction was answered" is true in BOTH behaviours, because
 * under `queue` it is answered by a second turn, which is the defect.
 *
 * What settles it is the CLI's OWN transcript, a file the host does not author.
 * Two facts read out of it, neither of them ours:
 *
 * 1. **the injection, as the CLI records it.** When our `PreToolUse` hook returns
 *    `additionalContext`, the CLI files
 *    `{"type":"attachment","attachment":{"type":"hook_additional_context",
 *    "hookEvent":"PreToolUse","hookName":"PreToolUse:Bash","toolUseID":"call_…",
 *    "content":["The user just sent a new message while you were working. …"]}}`
 *    — between the `tool_use` it names and that call's `tool_result`. The
 *    `toolUseID` is checked against the `tool_use` ids the same file records, so
 *    the delivery is tied to a tool call the model actually made.
 * 2. **the prompt count.** A turn opens with a user entry carrying a `text`
 *    block. Delivered mid-turn ⇒ **one** such entry for the whole exchange.
 *    Queued ⇒ **two**, the second being the correction.
 *
 * And a third, independent of both and of any field: the seed asks for six
 * sequential probe commands, and a correction that arrives mid-sequence stops
 * them. The `steer` arm's turn ran two; the `queue` arm's ran all six.
 *
 * ## THE CONTROL THAT MUST BE ABLE TO FAIL
 *
 * The identical probe runs twice, in two fresh sessions on the same card in the
 * same run, differing only in the connection's `midStreamBehavior`. The `queue`
 * arm must NOT deliver mid-turn. Without it a detector that always answered
 * "delivered" would pass the claim while measuring nothing — and this is not a
 * hypothetical: `LIV-2`'s first draft passed spuriously against a control that
 * compared two samples of a variable latency.
 *
 * The arms are ordered claim-first so that a run which dies half way still
 * carries the primary evidence, and the case FAILS if the control cannot be
 * established — it is never banked as a pass on its own.
 *
 * ## What this case deliberately does NOT claim
 *
 * That the correction arrived EARLIER in wall-clock terms than a queued one
 * would have. Both routes deliver at a tool boundary (`L5` measured that a turn
 * with no mid-turn boundary does not fold at all), and this rig cannot bound
 * upstream latency: the same 60-item prompt took 9.4 s and 81.2 s on consecutive
 * turns through this gateway. The claim is about WHICH TURN read the correction,
 * which is a structural fact, not a timing one.
 *
 * ## The operator's configuration is borrowed, and put back
 *
 * Every `claude-runtime` connection on this profile carries an explicit
 * `midStreamBehavior: 'queue'` written at creation, and `resolveMidStreamBehavior`
 * honours a stored value over the default BY DESIGN — so this case must SET the
 * behaviour to drive either arm, exactly as the Settings → AI submenu does, and
 * it restores the previous value in a `finally` whatever the outcome.
 */

import { randomBytes } from 'node:crypto'

import type { CdpSession } from '../lib/connect.ts'
import {
  STEER_INJECTION_MARKER,
  appLogOffset,
  classifyClaudeTranscript,
  correctionPrompt,
  longToolTaskPrompt,
  readMidStreamSends,
  readSteerRequeues,
  readSubmitControl,
  requireTurnStarted,
  restoreMidStreamBehavior,
  setMidStreamBehavior,
  steerDelivery,
  submitWithoutWaiting,
  toolActivity,
  tokenPlacement,
  transcriptWithQueueFlags,
  waitForFirstTool,
  waitUntilProcessing,
  waitUntilSettled,
  type MidStreamBehavior,
  type SteerDelivery,
  type SubmitControlRead,
} from '../lib/mid-stream.ts'
import { resolveClaudeCard } from '../lib/claude-child.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { main, type CaseRun } from '../lib/report.ts'
import { switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, isProcessing, setPermissionMode } from '../lib/state.ts'

const ID = 'STR-1'
const TITLE = 'A mid-turn correction reaches the Claude model inside the running turn on `steer`, and does not on `queue`'

function token(prefix: string): string {
  return `${prefix}${randomBytes(3).toString('hex').toUpperCase()}`
}

/** How many probe commands the seed asks for — see `longToolTaskPrompt`. */
const PROBE_STEPS = 6

interface ArmResult {
  behavior: MidStreamBehavior
  seedId: string
  correctionId: string
  /** The CLI's own transcript, classified. */
  prompts: number
  delivery: SteerDelivery
  correctionInPrompt: boolean
  correctionInAnswer: boolean
  toolUses: string[]
  bashCalls: number
  assistantTexts: string[]
  /** Our own transcript, read at the two moments that mean different things. */
  correctionQueuedInFlight?: boolean
  correctionQueuedAfterSettle?: boolean
  ourAssistantTexts: string[]
  toolsBeforeCorrection: number
  processingWhenCorrectionSent: boolean
  submitControl?: SubmitControlRead
  midStreamSends?: unknown
  steerRequeues?: number
  settledAfterMs: number
  processingGaps: number
  timedOut: boolean
}

/**
 * One arm: seed a long tool-shaped turn, correct it mid-flight, read where the
 * correction landed.
 *
 * Everything it returns is a READ; every decision about what the reads mean is
 * made by the caller, so the two arms cannot be scored by different rules.
 */
async function runArm(
  run: CaseRun,
  session: CdpSession,
  cardSlug: string,
  behavior: MidStreamBehavior,
): Promise<ArmResult> {
  const seedId = token('ALPHA')
  const correctionId = token('BETA')

  const key = await freshSession(session, `CDP ${ID} ${behavior} ${new Date().toISOString().slice(11, 19)}`)
  run.require(`[${behavior}] the arm ran in a session it created`, key.fresh,
    key.fresh ? undefined : `${key.reason} (inherited ${key.inheritedMessages} messages)`)
  const outcome = await switchRuntime(session, key.sessionId, cardSlug)
  run.observe(`[${behavior}] switch onto ${cardSlug}`, outcome)
  const active = await waitForConnection(session, key.sessionId, cardSlug)
  run.require(`[${behavior}] the session runs on ${cardSlug}`, active === cardSlug, `llmConnection=${String(active)}`)

  // The probe's tools must run without a permission card, or the turn parks on
  // the user instead of reaching the boundary the steer is delivered at. Set on
  // the SESSION, through the app's own command channel — the same thing `AGT-3`
  // does with Ask mode. The PreToolUse hook still fires in this mode (it is an
  // SDK hook, not the permission callback), which is what carries the injection.
  await setPermissionMode(session, key.sessionId, 'bypassPermissions')

  const logOffset = appLogOffset()

  // ---- the seed turn, not waited on ---------------------------------------
  await submitWithoutWaiting(session, longToolTaskPrompt(seedId))
  const startedProcessingAfter = await waitUntilProcessing(session, key)
  run.observe(`[${behavior}] the app reported a turn in flight after (ms)`, startedProcessingAfter)

  // A turn that will make no further tool call cannot take Claude's steer at
  // all — by design. Waiting for the first tool is the cheapest evidence that
  // this turn is tool-shaped and that boundaries remain ahead of the correction.
  const firstTool = await waitForFirstTool(session, key)
  run.observe(`[${behavior}] tools seen before the correction`, firstTool)
  if (firstTool.names.length === 0) {
    const messages = await transcriptWithQueueFlags(session, key)
    requireTurnStarted(run, messages.filter(m => m.role === 'error').map(m => m.content), `[${behavior}] the seed turn`)
    run.require(
      `[${behavior}] the seed turn made a tool call, so a PreToolUse boundary existed to deliver into`,
      false,
      'no tool entry appeared before the turn ended — the model answered without tools, so this arm measures the '
      + 'PROMPT rather than the mid-stream route. STR-2 is the case for the no-tool arm.',
    )
  }

  // ---- the correction, typed into the running turn ------------------------
  const processingAtSend = await isProcessing(session, key)
  const beforeCorrection = await transcriptWithQueueFlags(session, key)
  const toolsBefore = toolActivity(beforeCorrection).names.length
  // The composer's primary control exists as queue/steer only between "typed"
  // and "sent" — it reads `stop` while the composer is empty. See
  // `submitWithoutWaiting`'s note: reading it before typing is a true reading of
  // the wrong instant, and it looked like the setting not reaching the UI.
  let control: SubmitControlRead | undefined
  await submitWithoutWaiting(session, correctionPrompt(seedId, correctionId), async () => {
    control = await readSubmitControl(session)
  })
  run.observe(`[${behavior}] the composer's own primary control, with the correction typed and the turn running`, control)

  // IN FLIGHT, not after settling. Under `queue` the message is replayed as its
  // own turn and `isQueued` goes back to FALSE, so the post-settle read reports
  // "not queued" about a message that was plainly queued.
  const inFlight = await transcriptWithQueueFlags(session, key)
  const inFlightCorrection = inFlight.find(message => message.role === 'user' && message.content.includes(correctionId))
  run.observe(`[${behavior}] the correction's isQueued while the turn was still running`,
    inFlightCorrection ? inFlightCorrection.isQueued : '(not in the transcript yet)')

  // ---- let everything finish, including a queued replay -------------------
  const settle = await waitUntilSettled(session, key)
  run.observe(`[${behavior}] settled`, settle)

  const messages = await transcriptWithQueueFlags(session, key)
  requireTurnStarted(run, messages.filter(m => m.role === 'error').map(m => m.content), `[${behavior}] the arm`)
  const correction = messages.find(message => message.role === 'user' && message.content.includes(correctionId))
  const shape = classifyClaudeTranscript(key)
  run.observe(`[${behavior}] the CLI's own transcript`, {
    file: shape.file, files: shape.files, entries: shape.entries,
    prompts: shape.prompts.length, nonPrompts: shape.nonPrompts.length,
    toolUses: shape.toolUses, hookContexts: shape.hookContexts.length, reason: shape.reason,
  })
  const delivery = steerDelivery(shape, correctionId)
  run.observe(`[${behavior}] the CLI's own record of the injection`, delivery)
  const placement = tokenPlacement(shape, correctionId)
  run.observe(`[${behavior}] where the correction's id appears in the CLI's transcript`, placement)

  const sends = readMidStreamSends(logOffset, key.sessionId)
  run.observe(`[${behavior}] the app's own \`mid-stream send\` record`, sends ?? '(no application log on this build)')
  const requeues = readSteerRequeues(logOffset, key.sessionId)

  return {
    behavior,
    seedId,
    correctionId,
    prompts: shape.prompts.length,
    delivery,
    correctionInPrompt: placement.inPrompt,
    correctionInAnswer: placement.inAssistant,
    toolUses: shape.toolUses,
    bashCalls: shape.toolUses.filter(name => name === 'Bash').length,
    assistantTexts: shape.assistantTexts,
    ...(inFlightCorrection ? { correctionQueuedInFlight: inFlightCorrection.isQueued === true } : {}),
    ...(correction ? { correctionQueuedAfterSettle: correction.isQueued === true } : {}),
    ourAssistantTexts: messages.filter(m => m.role === 'assistant' && m.content.trim()).map(m => m.content.slice(0, 200)),
    toolsBeforeCorrection: toolsBefore,
    processingWhenCorrectionSent: processingAtSend === true,
    ...(control ? { submitControl: control } : {}),
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

  const card = await resolveClaudeCard(session, run, { caseId: ID })
  run.observe('card under test', card.slug)

  let previous: MidStreamBehavior | undefined
  let touched = false
  try {
    // ---- ARM 1: THE CLAIM -------------------------------------------------
    const toSteer = await setMidStreamBehavior(session, card.slug, 'steer')
    previous = toSteer.previous
    touched = true
    run.observe('the connection was moved to `steer`', toSteer)
    run.require('the app itself now reports `steer` for this connection', toSteer.ok,
      `saveLlmConnection/listLlmConnections say ${JSON.stringify(toSteer)}`)

    const steer = await runArm(run, session, card.slug, 'steer')
    run.observe('steer arm', steer)

    run.require('[steer] a turn was in flight when the correction was typed', steer.processingWhenCorrectionSent,
      'the app reported no turn in flight, so nothing was steered and every check below is void')
    run.check('[steer] the app took the steer branch and parked the message',
      Array.isArray(steer.midStreamSends)
        ? (steer.midStreamSends as Array<Record<string, unknown>>).some(send => send.behavior === 'steer' && send.steered === true)
        : true,
      steer.midStreamSends === undefined
        ? 'no application log on this build — corroboration unavailable, not a negative result'
        : JSON.stringify(steer.midStreamSends))

    run.check(
      'THE CLAIM: the CLI recorded ONE prompt for the whole exchange — the correction did not open a turn of its own',
      steer.prompts === 1,
      `the CLI's own transcript holds ${steer.prompts} prompt entries`,
    )
    run.check(
      'THE DELIVERY: the CLI recorded the correction being injected by a PreToolUse hook, inside that turn',
      steer.delivery.atToolBoundary.length > 0,
      JSON.stringify(steer.delivery.injections),
    )
    run.check(
      'and the injection names a tool call the same file records the model making — a real boundary, not a stray entry',
      steer.delivery.toolUseIdsResolve,
      JSON.stringify(steer.delivery.atToolBoundary.map(hook => hook.toolUseID)),
    )
    run.check(
      'the injected text is the one our own agent wraps a parked steer in',
      steer.delivery.carriesWrapper,
      `expected ${JSON.stringify(STEER_INJECTION_MARKER)}`,
    )
    run.check(
      'and the model ACTED on it inside that turn: the answer carries the corrected build id',
      steer.correctionInAnswer && !steer.correctionInPrompt,
      JSON.stringify({ inAnswer: steer.correctionInAnswer, inPrompt: steer.correctionInPrompt, said: steer.ourAssistantTexts }),
    )
    run.check(
      'it also STOPPED what it was doing: the six-command sequence was cut short',
      steer.bashCalls < PROBE_STEPS,
      `${steer.bashCalls} of ${PROBE_STEPS} probe commands ran (${JSON.stringify(steer.toolUses)})`,
    )
    run.check('[steer] the transcript showed the correction as delivered rather than queued while the turn ran',
      steer.correctionQueuedInFlight === false,
      `isQueued=${String(steer.correctionQueuedInFlight)}`)

    // ---- ARM 2: THE CONTROL ----------------------------------------------
    const toQueue = await setMidStreamBehavior(session, card.slug, 'queue')
    run.observe('the connection was moved to `queue` for the control', toQueue)
    run.require('the app itself now reports `queue` for this connection', toQueue.ok, JSON.stringify(toQueue))

    const queue = await runArm(run, session, card.slug, 'queue')
    run.observe('queue arm', queue)

    run.require('[queue] a turn was in flight when the correction was typed', queue.processingWhenCorrectionSent,
      'the control arm never had a turn to queue behind, so it cannot show the opposite of anything')
    run.check('[queue] the app took the queue branch and steered nothing',
      Array.isArray(queue.midStreamSends)
        ? (queue.midStreamSends as Array<Record<string, unknown>>).some(send => send.behavior === 'queue' && send.steered === false)
        : true,
      queue.midStreamSends === undefined ? '(no application log)' : JSON.stringify(queue.midStreamSends))
    run.check(
      'THE CONTROL: on `queue` the correction opened a SECOND turn — two prompt entries in the CLI\'s own transcript, '
      + 'and the correction IS the second one',
      queue.prompts === 2 && queue.correctionInPrompt,
      JSON.stringify({ prompts: queue.prompts, inPrompt: queue.correctionInPrompt }),
    )
    run.check(
      'and nothing was injected mid-turn on `queue` — no PreToolUse hook carried it',
      queue.delivery.injections.length === 0,
      JSON.stringify(queue.delivery.injections),
    )
    run.check(
      'the running turn on `queue` finished the job it had been given, uncorrected — all six probe commands ran',
      queue.bashCalls === PROBE_STEPS,
      `${queue.bashCalls} of ${PROBE_STEPS} (${JSON.stringify(queue.toolUses)})`,
    )
    run.check('[queue] the transcript showed the correction as queued while the turn ran',
      queue.correctionQueuedInFlight === true,
      `isQueued=${String(queue.correctionQueuedInFlight)}`)
    // Not a defect and worth recording: after the replay the SAME transcript
    // entry stops being queued, because `processNextQueuedMessage` sends it under
    // its own id. Reading this field after settlement is what made a first draft
    // report the control arm as "not queued".
    run.observe('[queue] and after the replay that same entry is no longer queued',
      queue.correctionQueuedAfterSettle)
    run.check(
      'the two arms differ on the one thing the case is about — so the positive result was a measurement, not a constant',
      steer.prompts !== queue.prompts
      && steer.delivery.atToolBoundary.length > 0 && queue.delivery.atToolBoundary.length === 0,
      `steer: ${steer.prompts} prompts / ${steer.delivery.atToolBoundary.length} injections; `
      + `queue: ${queue.prompts} prompts / ${queue.delivery.atToolBoundary.length} injections`,
    )
    // The composer's own control is derived from `resolveMidStreamBehavior`
    // (`composer-capabilities.ts:171`), so its label must differ between the
    // arms. Labels are localized, so they are compared to each OTHER and never
    // to a literal.
    run.check('the composer offered a different primary control in the two arms',
      Boolean(steer.submitControl?.label && queue.submitControl?.label
        && steer.submitControl.label !== queue.submitControl.label),
      `steer=${JSON.stringify(steer.submitControl)} queue=${JSON.stringify(queue.submitControl)}`)
  } finally {
    if (touched) {
      const restored = await restoreMidStreamBehavior(session, card.slug, previous)
      run.observe("the operator's own setting was put back", { previous: previous ?? '(unset)', restored })
    }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
