/**
 * STR-2 — THE HONEST NEGATIVE: a turn with no tool call cannot take Claude's
 * steer, and the correction must be RE-QUEUED rather than lost.
 *
 * `STR-1` proves the delivery. This is the arm on the other side of it, and it is
 * the one the plan's own tracker singles out as most likely to be broken —
 * `defaultMidStreamBehavior`'s doc comment names it as the reason Claude was left
 * on `queue` in the first place: *"if no tool fires before the turn ends, the
 * steer becomes `steer_undelivered` and gets re-queued anyway, paying for the
 * original turn's tokens for nothing"*. That is a cost, not a defect. The DEFECT
 * would be losing the message, and this repo has shipped exactly that once:
 * `steer_undelivered` used to re-queue under a FRESH message id, and
 * `sendMessage`'s replay looks the id up with `.find(...)!` and threw — so the
 * user's correction was dropped behind a `queued_message_replay_failed` banner
 * after the transcript had already shown it as delivered
 * (`ManagedSession.pendingSteers` + `requeueUndeliveredSteer` carry the story).
 *
 * So the claim here is narrow and it is about NOT LOSING something:
 *
 * 1. no `PreToolUse` fired, so nothing was injected (the mirror of `STR-1`);
 * 2. the app logged `Steer message undelivered, re-queuing`;
 * 3. the correction was answered anyway, as its own turn — TWO prompt entries in
 *    the CLI's own transcript, the second being the correction;
 * 4. and the transcript entry that was briefly shown as delivered went back to
 *    `isQueued: true` rather than being replaced by a new one, which is what the
 *    replay needs in order to find it at all.
 *
 * ## Why this case can BLOCK, and why that is not a dodge
 *
 * The precondition is a turn that makes NO tool call, and only the model decides
 * that. The seed asks for invented prose about a fictional tool and explicitly
 * says not to read files or run commands; if the model reaches for a tool anyway,
 * the steer is deliverable, `steer_undelivered` is unreachable, and the case has
 * measured nothing about the arm it exists for. It says so and BLOCKS. Scoring
 * that as a pass would be the `LIV-2` defect again: an arm whose precondition
 * failed, reported as a result.
 *
 * The reverse is worth stating too: this case does not assert that the model was
 * unable to answer the correction well, or that no tokens were wasted. Both are
 * true and both are the documented price of the route.
 */

import { randomBytes } from 'node:crypto'

import { resolveClaudeCard } from '../lib/claude-child.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import {
  appLogOffset,
  classifyClaudeTranscript,
  correctionPrompt,
  longProsePrompt,
  readMidStreamSends,
  readSessionLogMatching,
  readSteerRequeues,
  requireTurnStarted,
  restoreMidStreamBehavior,
  setMidStreamBehavior,
  steerDelivery,
  submitWithoutWaiting,
  toolActivity,
  transcriptWithQueueFlags,
  waitUntilProcessing,
  waitUntilSettled,
  type MidStreamBehavior,
} from '../lib/mid-stream.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, isProcessing } from '../lib/state.ts'

const ID = 'STR-2'
const TITLE = 'A steer into a tool-less Claude turn is reported undelivered and re-queued, not lost'

function token(prefix: string): string {
  return `${prefix}${randomBytes(3).toString('hex').toUpperCase()}`
}

/**
 * How long to wait after the turn starts before typing the correction.
 *
 * **Zero by default, and that is the fix.** This was a hard-coded 6 000 ms, and
 * it is what blocked the row: the gateway answers one prose prompt in anywhere
 * from 9 s to 81 s (both measured 2026-08-17), so on a fast day the sleep
 * outlived the turn and the arm reported "there was nothing to steer into".
 * Nothing about the claim needs a delay — it needs A TURN IN FLIGHT WHEN ENTER
 * IS PRESSED, and `submitWithoutWaiting` spends several CDP round trips
 * (clear, type, read back, submit) inside the window on its own.
 *
 * The case's own doc already said it: "It is NOT a timing assertion." The knob
 * survives as `NESSY_CDP_STEER_DELAY_MS` for a runtime that needs a wider
 * window, and the in-flight read below moved to the instant of the Enter, which
 * is the instant the claim is actually about.
 */
const CORRECTION_DELAY_MS = Number(process.env.NESSY_CDP_STEER_DELAY_MS ?? '0')

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const card = await resolveClaudeCard(session, run, { caseId: ID })
  run.observe('card under test', card.slug)

  let previous: MidStreamBehavior | undefined
  let touched = false
  try {
    const toSteer = await setMidStreamBehavior(session, card.slug, 'steer')
    previous = toSteer.previous
    touched = true
    run.observe('the connection was moved to `steer`', toSteer)
    run.require('the app itself now reports `steer` for this connection', toSteer.ok, JSON.stringify(toSteer))

    const seedId = token('ALPHA')
    const correctionId = token('BETA')

    const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
    run.require('the case ran in a session it created', key.fresh,
      key.fresh ? undefined : `${key.reason} (inherited ${key.inheritedMessages} messages)`)
    const outcome = await switchRuntime(session, key.sessionId, card.slug)
    run.observe(`switch onto ${card.slug}`, outcome)
    const active = await waitForConnection(session, key.sessionId, card.slug)
    run.require(`the session runs on ${card.slug}`, active === card.slug, `llmConnection=${String(active)}`)

    const logOffset = appLogOffset()

    // ---- a turn tools cannot help with -------------------------------------
    await submitWithoutWaiting(session, longProsePrompt(seedId))
    const startedAfter = await waitUntilProcessing(session, key)
    run.observe('the app reported a turn in flight after (ms)', startedAfter)

    if (CORRECTION_DELAY_MS > 0) await Bun.sleep(CORRECTION_DELAY_MS)

    // The in-flight read happens at the INSTANT OF THE ENTER, not before the
    // typing. `submitWithoutWaiting`'s `beforeSubmit` hook runs with the
    // correction already in the composer and the submit one call away, which is
    // the moment the claim is about; the older read was taken before four CDP
    // round trips and could report a turn that had ended by the time the
    // message actually went.
    let processingAtSend = false
    await submitWithoutWaiting(session, correctionPrompt(seedId, correctionId), async () => {
      processingAtSend = await isProcessing(session, key)
    })
    run.observe('the turn was in flight at the moment the correction was sent', processingAtSend)
    // BLOCKED, not FAIL. A turn that finished before the correction was sent
    // measured NOTHING — the arm needs a turn in flight to steer into, and the
    // gateway's latency for one prose prompt varies by an order of magnitude
    // between runs (9 s and 81 s were both measured on 2026-08-17). Reporting
    // this as FAIL blames the product for "the gateway was fast today", which is
    // the exact defect class this plan keeps catching in its own cases.
    if (!processingAtSend) {
      blocked(
        'the prose turn had already finished by the time the correction was submitted'
        + (CORRECTION_DELAY_MS > 0 ? ` (NESSY_CDP_STEER_DELAY_MS=${CORRECTION_DELAY_MS} was waited first)` : '')
        + ', so there was nothing to steer into and this arm measured nothing. The correction is now sent as soon as '
        + 'the app reports a turn in flight, so a re-run is usually enough; if this recurs, the card is answering the '
        + 'long-prose prompt faster than four CDP round trips, and the lever is a LONGER prompt rather than a delay.',
      )
    }
    run.check('a turn was still in flight when the correction was sent', processingAtSend)

    const inFlight = await transcriptWithQueueFlags(session, key)
    const inFlightCorrection = inFlight.find(message => message.role === 'user' && message.content.includes(correctionId))
    run.observe("the correction's isQueued at the moment it was accepted",
      inFlightCorrection ? inFlightCorrection.isQueued : '(not in the transcript yet)')
    const inFlightId = inFlightCorrection?.id

    const settle = await waitUntilSettled(session, key)
    run.observe('settled', settle)

    const messages = await transcriptWithQueueFlags(session, key)
    requireTurnStarted(run, messages.filter(m => m.role === 'error').map(m => m.content), 'the arm')
    const shape = classifyClaudeTranscript(key)
    run.observe("the CLI's own transcript", {
      file: shape.file, entries: shape.entries, prompts: shape.prompts.length,
      toolUses: shape.toolUses, hookContexts: shape.hookContexts.length,
    })
    const ourTools = toolActivity(messages)
    run.observe('tools the turn used', { cliRecorded: shape.toolUses, ourTranscript: ourTools })

    // ---- THE PRECONDITION, and it belongs to the model ----------------------
    if (shape.toolUses.length > 0 || ourTools.names.length > 0) {
      blocked(
        `the seed turn called ${JSON.stringify(shape.toolUses.length > 0 ? shape.toolUses : ourTools.names)} despite being `
        + 'asked for invented prose with no file reads and no commands. A PreToolUse boundary therefore existed, the '
        + 'steer was deliverable, and `steer_undelivered` — the whole subject of this case — is unreachable on this '
        + 'run. STR-1 is the case for the delivered path. Re-run; this is the model\'s choice, not a defect.',
      )
    }

    const requeues = readSteerRequeues(logOffset, key.sessionId)
    const sends = readMidStreamSends(logOffset, key.sessionId)
    run.observe("the app's own `mid-stream send` record", sends ?? '(no application log on this build)')
    run.observe("the app's own `Steer message undelivered, re-queuing` count",
      requeues ?? '(no application log on this build)')

    const delivery = steerDelivery(shape, correctionId)
    run.check(
      'nothing was injected mid-turn — no PreToolUse hook fired, which is the precondition of this whole arm',
      delivery.injections.length === 0,
      JSON.stringify(delivery.injections),
    )
    run.check(
      'the app parked the steer in the first place (so there was something to fail to deliver)',
      Array.isArray(sends)
        ? (sends as Array<Record<string, unknown>>).some(send => send.behavior === 'steer' && send.steered === true)
        : true,
      sends === undefined ? '(no application log — corroboration unavailable)' : JSON.stringify(sends),
    )
    run.check(
      'THE CLAIM: the app reported the steer UNDELIVERED and re-queued it',
      requeues === undefined ? true : requeues > 0,
      requeues === undefined
        ? '(no application log on this build — read from the transcript checks below instead)'
        : `${requeues} re-queue lines for this session`,
    )
    run.check(
      'and the correction was answered anyway, as its own turn — two prompt entries in the CLI\'s own transcript',
      shape.prompts.length === 2 && shape.prompts.some(text => text.includes(correctionId)),
      JSON.stringify({ prompts: shape.prompts.length, ids: shape.prompts.map(text => text.slice(0, 60)) }),
    )
    run.check(
      'THE THING THAT MUST NOT HAPPEN: the message was not lost — the answer addresses the corrected build id',
      shape.assistantTexts.some(text => text.includes(correctionId)),
      JSON.stringify(messages.filter(m => m.role === 'assistant').map(m => m.content.slice(0, 160))),
    )
    // ---- the id the REPLAY used, which is the whole defect ------------------
    //
    // A FIRST DRAFT OF THIS CHECK PASSED VACUOUSLY, and it is worth saying how.
    // It compared the transcript entry's id before and after — which is
    // unchanged by construction, because nothing rewrites a transcript id — and
    // called that "the re-queue reused it". The question is what the QUEUE
    // carried, and only the replay's own log lines answer it: `replay queued
    // {messageId}` is the id `sendMessage` is handed as `existingMessageId`, and
    // `replay failed {error}` is what happens when that id is in no transcript.
    const afterCorrection = messages.find(message => message.role === 'user' && message.content.includes(correctionId))
    const replayQueued = readSessionLogMatching(logOffset, /replay queued/)
    const replayFailed = readSessionLogMatching(logOffset, /replay failed/)
    run.observe('the app\'s own replay lines', { replayQueued, replayFailed })
    const replayedId = replayQueued?.map(line => /"messageId":\s*"([^"]+)"/.exec(line)?.[1]).filter(Boolean)
    run.check(
      'the replay used the transcript entry the user can see — not an id minted at re-queue time',
      replayedId === undefined ? true : Boolean(inFlightId && replayedId.includes(inFlightId)),
      `the transcript holds ${String(inFlightId)}; the replay was handed ${JSON.stringify(replayedId)}`,
    )
    run.check(
      'and the replay did not fail',
      replayFailed === undefined ? true : replayFailed.length === 0,
      JSON.stringify(replayFailed),
    )
    run.observe('the transcript entry id, before and after',
      { inFlight: inFlightId, after: afterCorrection?.id })
    run.observe('and whether the transcript still shows the lost correction as DELIVERED',
      afterCorrection ? { isQueued: afterCorrection.isQueued } : '(gone)')
    run.check(
      'and there is exactly one copy of the correction in the transcript, so nothing was replayed twice',
      messages.filter(message => message.role === 'user' && message.content.includes(correctionId)).length === 1,
      JSON.stringify(messages.filter(m => m.role === 'user').map(m => m.content.slice(0, 60))),
    )
    run.observe('no queued-replay failure banner appeared',
      messages.filter(m => m.role === 'error' || m.role === 'warning').map(m => m.content.slice(0, 200)))
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
