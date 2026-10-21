/**
 * RS-09 (row P6.187) — Pi's steer is the DEFAULT on the DEFAULT runtime, and
 * nobody has ever driven it end to end in the app.
 *
 * Ledger O5 (pi cell), `—`. **Native mechanism: Pi's own `.steer()`, already
 * wired — there is nothing to build, only to measure.** The decision site is
 * single and reads at HEAD as `const behavior = connection ?
 * resolveMidStreamBehavior(connection) : 'steer'`, with
 * `defaultMidStreamBehavior` returning `'queue'` only for `nestor-cloud-agent`.
 *
 * The finding is the MISSING CASE. `docs/testing/cdp-live-checklist.md` lists
 * STR-1/STR-2 for claude and STR-3/STR-4 for codex, and **no Pi steering case at
 * all** — on the runtime that is the default, using the mechanism that is native
 * rather than emulated. A silent regression here would look exactly like a fast
 * turn, which is why the absence is the finding rather than a gap in coverage.
 *
 * ## The default is READ, not assumed, and that is half the row
 *
 * `resolveMidStreamBehavior` honours a STORED value over the default by design,
 * so a profile whose Pi card carries an explicit `queue` would make the headline
 * claim false for that install while the code is unchanged. This case therefore
 * records what the card carries BEFORE it touches anything:
 *
 *  - unset, or already `steer` — the row's claim holds on this profile and arm 1
 *    measures the shipped default;
 *  - an explicit other value — the claim does NOT hold here, the case says so,
 *    and arm 1 continues with `steer` written explicitly so the mechanism is
 *    still measured. Two different findings, never collapsed into one.
 *
 * Anything this case writes is restored in a `finally`, to the operator's own
 * value including "unset".
 *
 * ## The two arms, and the discriminator between them
 *
 * **Arm 1, steer.** A long tool-shaped turn, a correction typed into it, and the
 * claim: the correction reaches the model INSIDE that turn and opens no turn of
 * its own. Pi delivers a steer after the current tool call finishes, so a tool
 * boundary has to exist — `waitForFirstTool` is the cheapest evidence that this
 * turn is tool-shaped and that more boundaries are coming, and a turn without one
 * BLOCKS rather than scoring.
 *
 * **Arm 2, queue.** The same connection flipped to `queue`. The running turn must
 * be undisturbed and the message must replay as a NEW turn. This is the arm that
 * separates "steer worked" from "the turn had already ended", which is the one
 * way arm 1 can pass for the wrong reason.
 *
 * The discriminator is `waitUntilSettled`'s own `processingGaps`: a replayed turn
 * shows the session stop processing and start again, so **zero gaps is a steer
 * and one gap is a replay**. It is read from the app's own `isProcessing`, not
 * from a log — a PACKAGED build writes no application log at all, so a case that
 * asserted on `Steer message undelivered, re-queuing` would measure a dev build
 * only.
 */

import { randomBytes } from 'node:crypto'

import { resolveAppUnderTest } from '../lib/bundle.ts'
import { lastAssistantText } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import {
  correctionPrompt,
  longToolTaskPrompt,
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
} from '../lib/mid-stream.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, isProcessing } from '../lib/state.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-09'
const TITLE = 'A correction typed into a running Pi turn is steered into it, and queue replays it as its own turn'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.187',
  runtimes: ['pi'],
  credentials: 'none — the default Pi card. This case writes the connection midStreamBehavior for the '
    + 'control arm and restores the operator value, including unset, in a finally.',
} as const satisfies CaseMeta

/** Move a session onto `card` and refuse to continue if it did not land. */
async function requireOn(session: CdpSession, run: CaseRun, sessionId: string, card: string): Promise<void> {
  const moved = await switchRuntime(session, sessionId, card)
  run.observe(`switch onto ${card}`, moved)
  run.require(`the session reports ${card}`, (await waitForConnection(session, sessionId, card)) === card, card)
}

function token(prefix: string): string {
  return `${prefix}${randomBytes(3).toString('hex').toUpperCase()}`
}

interface ArmReading {
  behavior: MidStreamBehavior
  processingAtSend: boolean
  toolsBeforeCorrection: string[]
  toolsAtSettle: string[]
  processingGaps: number
  timedOut: boolean
  answer: string
  namesRightId: boolean
  namesWrongId: boolean
  correctionWasQueued?: boolean
}

async function runArm(
  session: CdpSession,
  run: CaseRun,
  key: { workspaceId: string; sessionId: string },
  behavior: MidStreamBehavior,
): Promise<ArmReading> {
  const seedId = token('ALPHA')
  const correctionId = token('BETA')
  // F1.521: every read below is of THIS arm's rows — the seed, the correction and
  // what they produced — never of rows an inherited session already held.
  const armBefore = (await transcriptWithQueueFlags(session, key)).length

  await submitWithoutWaiting(session, longToolTaskPrompt(seedId))
  const startedAfter = await waitUntilProcessing(session, key)
  run.observe(`${behavior}: the app reported a turn in flight after (ms)`, startedAfter)

  // Pi delivers a steer after the CURRENT tool call finishes, so a turn with no
  // tool call has no boundary to deliver into. Waiting for the first one is the
  // precondition, not an optimisation.
  const firstTool = await waitForFirstTool(session, key)
  run.observe(`${behavior}: tools seen before the correction`, firstTool)

  let processingAtSend = false
  await submitWithoutWaiting(session, correctionPrompt(seedId, correctionId), async () => {
    processingAtSend = await isProcessing(session, key)
  })
  run.observe(`${behavior}: a turn was in flight at the instant of the correction`, processingAtSend)

  const inFlight = await transcriptWithQueueFlags(session, key)
  const correctionWasQueued = inFlight
    .find(message => message.role === 'user' && message.content.includes(correctionId))?.isQueued

  const settle = await waitUntilSettled(session, key)
  run.observe(`${behavior}: settled`, settle)

  const messages = (await transcriptWithQueueFlags(session, key)).slice(armBefore)
  requireTurnStarted(run, messages.filter(message => message.role === 'error').map(message => message.content), `the ${behavior} arm`)
  const answer = lastAssistantText(messages)
  return {
    behavior,
    processingAtSend,
    toolsBeforeCorrection: firstTool.names,
    toolsAtSettle: toolActivity(messages).names,
    processingGaps: settle.processingGaps,
    timedOut: settle.timedOut,
    answer: answer.slice(0, 600),
    namesRightId: answer.includes(correctionId),
    namesWrongId: answer.includes(seedId),
    correctionWasQueued,
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — a dev build is not the shipped artefact`)

  const connections = await listConnections(session)
  const piRow = connections.find(row => runtimeOf(row.providerType) === 'pi')
  if (!piRow) {
    blocked(
      'this case is about the DEFAULT runtime and needs a Pi connection; the host lists '
      + `${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}.`,
    )
  }
  const card = piRow.slug

  let previous: MidStreamBehavior | undefined
  let touched = false
  try {
    // `setMidStreamBehavior` reads the connection through `listLlmConnections`
    // and hands back what it found, so its `previous` IS the stored value the
    // resolver would have honoured. `listConnections` does not project the field,
    // which is why the headline is read from here rather than from the card row.
    const toSteer = await setMidStreamBehavior(session, card, 'steer')
    previous = toSteer.previous
    touched = true
    run.observe('what the Pi card carried before this case touched anything', previous ?? '(unset)')
    run.observe(
      'the row headline, on THIS profile',
      previous === undefined || previous === 'steer'
        ? 'holds — the shipped default resolves to steer on the default runtime'
        : `does NOT hold on this profile: the card carries an explicit "${previous}", which resolveMidStreamBehavior `
          + 'honours over the default. Arm 1 below writes steer explicitly, so the MECHANISM is still measured — '
          + 'but the default claim is a separate finding and is recorded as one.',
    )
    run.require('the app itself now reports `steer` for this connection', toSteer.ok, JSON.stringify(toSteer))

    // ---- arm 1: steer -------------------------------------------------------
    const steerKey = await freshSession(session, `CDP ${ID} steer ${new Date().toISOString().slice(11, 19)}`)
    run.check('the steer arm ran in a session it created', steerKey.fresh,
      steerKey.fresh ? undefined : `inherited ${steerKey.inheritedMessages} messages`)
    await requireOn(session, run, steerKey.sessionId, card)
    const steer = await runArm(session, run, steerKey, 'steer')
    run.observe('steer arm', steer)

    if (!steer.processingAtSend) {
      blocked(
        'the seed turn had already finished by the time the correction was submitted, so there was nothing to '
        + 'steer into and this arm measured nothing. The lever is a LONGER seed (more probe steps), never a '
        + 'sleep before the correction — re-run.',
      )
    }
    if (steer.toolsBeforeCorrection.length === 0) {
      blocked(
        'the seed turn had made no tool call when the correction was sent. Pi delivers a steer after the '
        + 'CURRENT tool call finishes, so there was no boundary to deliver into and the mechanism was not '
        + 'exercised. Re-run; this is the model\'s choice, not a defect.',
      )
    }

    run.check(
      'the correction reached the model inside the running turn',
      steer.namesRightId,
      steer.namesRightId ? undefined
        : `the final answer does not carry the corrected id (wrongIdStillNamed=${steer.namesWrongId})`,
    )
    run.check(
      'and it opened no turn of its own — the session never stopped and restarted processing',
      steer.processingGaps === 0,
      steer.processingGaps === 0 ? undefined
        : `${steer.processingGaps} processing gap(s): the session stopped and started again, which is the shape of a REPLAY, not a steer`,
    )
    run.observe('steer arm: tools at settle', steer.toolsAtSettle)

    // ---- arm 2: the queue control ------------------------------------------
    const toQueue = await setMidStreamBehavior(session, card, 'queue')
    run.require('the app itself now reports `queue` for this connection', toQueue.ok, JSON.stringify(toQueue))
    const queueKey = await freshSession(session, `CDP ${ID} queue ${new Date().toISOString().slice(11, 19)}`)
    run.check('the queue arm ran in a session it created', queueKey.fresh,
      queueKey.fresh ? undefined : `inherited ${queueKey.inheritedMessages} messages`)
    await requireOn(session, run, queueKey.sessionId, card)
    const queued = await runArm(session, run, queueKey, 'queue')
    run.observe('queue arm', queued)

    if (!queued.processingAtSend) {
      run.observe('queue arm', 'the seed turn ended before the correction went — this control measured nothing; re-run')
    } else {
      // THE CONTROL IS THE PAIR, and the pair is `isQueued`. Measured 2026-09-12
      // (R7, the first end-to-end Pi drive): `undefined` on the steer arm and
      // `true` on the queue arm — the two arms disagree, which is the whole
      // requirement of a control.
      run.check(
        'THE CONTROL — under `queue` the correction is held, and under `steer` it is NOT',
        queued.correctionWasQueued === true && steer.correctionWasQueued !== true,
        `queue isQueued=${String(queued.correctionWasQueued)}, steer isQueued=${String(steer.correctionWasQueued)}`
        + ' — without the PAIR, "steer worked" cannot be told from "the turn had already ended"',
      )
      // `processingGaps` CANNOT see a replay here, and that is a measurement
      // rather than a suspicion: `waitUntilSettled` polls `isProcessing` once a
      // second, and a queued message is dequeued the moment the turn ends, so
      // the session need never READ as idle between the two. Both arms scored 0
      // on 2026-09-12 — a check whose two arms cannot disagree is a deleted
      // test, so this is an observation and the pair above is the control.
      run.observe('queue arm — processing gaps (1 s resolution; 0 does not refute a replay)',
        { queue: queued.processingGaps, steer: steer.processingGaps })
      run.observe('queue arm — tool calls at settle, against the steer arm',
        { queue: queued.toolsAtSettle.length, steer: steer.toolsAtSettle.length })
    }
  } finally {
    if (touched) {
      const restored = await restoreMidStreamBehavior(session, card, previous)
      run.observe('restored the operator value', restored)
    }
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
