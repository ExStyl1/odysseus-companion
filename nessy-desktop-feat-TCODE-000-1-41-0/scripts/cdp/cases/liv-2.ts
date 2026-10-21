/**
 * LIV-2 — STOP LEAVES A SESSION THAT ANSWERS THE NEXT MESSAGE.
 *
 * The review's stated bar for L2, and a thing a user hits constantly. Under the
 * old shape Stop was survivable only by accident: `abort()` IS session death
 * (the SDK's own `abortHandler = () => this.close()`, which ends stdin and then
 * SIGTERMs), and the process was dying anyway because a string prompt made the
 * transport end input at the first result. L1 moved the user Stop onto
 * `Query.interrupt()` — documented "Only available in streaming input mode" —
 * and L2 shipped it with a deadline that escalates to session death when the
 * child stops answering its control channel. Every bit of that was proven
 * against fake CLIs.
 *
 * ## Three questions, and the detector for each
 *
 * 1. **Was a turn really in flight when Stop was pressed?** The app's own send
 *    button becomes the Stop button only while `isProcessing` is true and the
 *    composer is empty (`FreeFormInput.tsx`: `submitMode` is `'stop'` in exactly
 *    that state), and the element's `type` attribute flips from `submit` to
 *    `button` with it. So `button[data-tutorial="send-button"][type="button"]`
 *    is a STRUCTURAL read of the app's own opinion that a turn is running —
 *    locale-independent, unlike the button's label. `isProcessing` is read from
 *    the session state as a second, independent witness immediately before the
 *    click.
 *
 * 2. **Was the turn actually INTERRUPTED, or did it simply finish first?** The
 *    honest detector is the one the CHILD writes itself: the shipped `claude`
 *    binary appends `[Request interrupted by user]` to its own transcript when
 *    it processes an interrupt (the string occurs ten times in
 *    `claude-agent-sdk-darwin-arm64/claude` and nowhere in our own source). The
 *    entry is counted BEFORE the arm and again after, so a marker left by
 *    anything earlier cannot be read as this run's — the exact fault that made
 *    an auto-compaction detector report a previous run's boundary in 2026-08-08.
 *
 *    **The app's own "Response interrupted" info row is deliberately NOT the
 *    detector**, and the reason is worth keeping: `SessionManager` appends it
 *    inside `cancelProcessing`, at the moment the user asks — before anything
 *    has been interrupted. It proves a Stop was REQUESTED. It is recorded as an
 *    observation and asserted nowhere.
 *
 *    **A turn that finished before the Stop is BLOCKED, not FAIL, and telling
 *    the two apart is what this case had to learn.** On 2026-08-17 the same
 *    prompt took 9.4 s on one turn and 81.2 s on the next through the same
 *    gateway; the 9.4 s one had already finished when the Stop was pressed, and
 *    a "the reference turn took longer than the stop delay" control passed
 *    anyway — 81 s is comfortably longer than 4 s. So timing is corroboration
 *    only. The discriminator is the app's own record:
 *    `SessionManager.cancelProcessing` returns early — *"if (!managed.isProcessing)
 *    return // Not processing, nothing to cancel"* — BEFORE it appends its
 *    "Response interrupted" row, so no row means the Stop arrived too late
 *    (BLOCKED), a row with no child marker means the app accepted a Stop the
 *    child never saw (FAIL), and both together mean the interrupt landed.
 *
 * 3. **Does the session answer the next message?** The reference turn IS the
 *    next message. One arm, two jobs: it is the claim, and it supplies the
 *    completed-answer length the interrupted turn is compared against.
 *
 * ## The process reading, which is extra rather than the claim
 *
 * `lib/claude-child.ts` reports whether the pid survived. A Stop that KILLS the
 * child and then resumes a new one would still answer the next message, so the
 * claim above stands either way — but interrupt-not-kill is what L1 and L2
 * actually built, and it is one `ps` away.
 */

import { randomBytes } from 'node:crypto'

import {
  assertProcessInstrument,
  childIdentity,
  echoTurn,
  etimeSeconds,
  resolveClaudeCard,
  sessionDirOf,
  waitForChildCount,
  type ClaudeChild,
} from '../lib/claude-child.ts'
import { clearComposer, readComposer, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir, readClaudeSessionLog } from '../lib/runtime-session-log.ts'
import { switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import {
  assertElectronApi,
  freshSession,
  isProcessing,
  selectorCount,
  transcript,
  waitFor,
  type SessionKey,
  type TranscriptMessage,
} from '../lib/state.ts'
import { clickSelector } from '../lib/viewport.ts'

const ID = 'LIV-2'
const TITLE = 'A user Stop interrupts the turn and the same Claude session answers the next message'

/**
 * The send button while it is the STOP button.
 *
 * `type={submitMode === 'stop' ? 'button' : 'submit'}` — the attribute is the
 * app's own state, not a label this harness has to translate.
 */
const STOP_BUTTON = 'button[data-tutorial="send-button"][type="button"]'

/** The CLI's own record of an interrupt, in its own words. */
const CHILD_INTERRUPT_MARKER = '[Request interrupted by user]'

/**
 * A prompt whose answer takes long enough to interrupt, and which does nothing.
 *
 * No tool call, no file, no network beyond the model itself: a case that presses
 * Stop must not leave half a side effect behind.
 *
 * **Sized against the gateway's own variance.** This list ran in 9.4 s on one
 * turn and 81.2 s on the next, and the 9.4 s one finished before a 4 s Stop —
 * which is how this case learned to tell "could not be driven" from "defect"
 * (see the split below). A 200-item version was tried and abandoned: it did not
 * finish inside a five-minute turn timeout, which failed the case for the
 * upstream's latency. The split, not the length, is what makes a too-short turn
 * honest rather than red.
 */
const LONG_PROMPT =
  'Write a numbered list of 60 short facts about the history of the bicycle, one per line, '
  + 'each on its own numbered line, numbered 1 to 60.'

/**
 * The last item of a COMPLETE answer to {@link LONG_PROMPT}.
 *
 * A completeness test that needs no second sample: an interrupted answer cannot
 * have reached the final item, so its absence is the evidence that the turn was
 * cut short. Comparing against another run of the same prompt was tried and
 * abandoned — the gateway's latency for it varied 9x between two turns.
 */
const COMPLETION_MARKER = '60.'

const STOP_DELAY_MS = 2_500
const TURN_TIMEOUT_MS = 300_000

function token(prefix: string): string {
  return `${prefix}${randomBytes(3).toString('hex').toUpperCase()}`
}

function child(entry: ClaudeChild): Record<string, unknown> {
  return { pid: entry.pid, startedAt: entry.lstart, elapsed: entry.etime, model: entry.spawnModel }
}

/** How many times the child has recorded an interrupt in its own transcript. */
function childInterruptCount(key: SessionKey): { count: number; files: number; reason?: string } {
  const log = readClaudeSessionLog(key.workspaceId, configDir(), key.sessionId)
  if (log.reason) return { count: 0, files: 0, reason: log.reason }
  return {
    count: log.entries.filter(entry => entry.text.includes(CHILD_INTERRUPT_MARKER)).length,
    files: log.files?.length ?? (log.file ? 1 : 0),
  }
}

function errorRows(messages: TranscriptMessage[]): string[] {
  return messages.filter(message => message.role === 'error').map(message => message.content)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  assertProcessInstrument(run)

  const card = await resolveClaudeCard(session, run, { caseId: ID })
  run.observe('card under test', card.slug)

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.require('the case ran in a session it created', key.fresh,
    key.fresh ? undefined : `${key.reason} (inherited ${key.inheritedMessages} messages)`)

  const outcome = await switchRuntime(session, key.sessionId, card.slug)
  run.observe('switch onto the claude card', outcome)
  const active = await waitForConnection(session, key.sessionId, card.slug)
  run.require(`the session runs on ${card.slug}`, active === card.slug, `llmConnection=${String(active)}`)

  const dir = sessionDirOf(key)

  // ---- a seed turn, so the arm below interrupts a session that WORKS --------
  // `echoTurn` BLOCKS rather than fails when the model declines or the upstream
  // errors: with no answered turn there is no live session to interrupt, and
  // that is a rig fact rather than a defect.
  await echoTurn(session, run, key, 'the seed turn', token('ALPHA'), TURN_TIMEOUT_MS)
  const before = await waitForChildCount(dir, 1)
  run.observe('child after the seed turn', before.map(child))
  run.require('the seed turn left exactly one child for this session', before.length === 1, JSON.stringify(before.map(child)))
  const original = before[0]!

  const interruptsBefore = childInterruptCount(key)
  run.observe('interrupt records in the child\'s own transcript before the arm', interruptsBefore)
  run.require(
    'the child\'s own transcript is readable, so an interrupt record can be counted',
    interruptsBefore.reason === undefined,
    interruptsBefore.reason,
  )
  run.require(
    'and it carries no interrupt record yet — this run\'s marker cannot be an older one',
    interruptsBefore.count === 0,
    interruptsBefore.count === 0 ? undefined : `${interruptsBefore.count} already present`,
  )

  // ---- THE STOP ARM --------------------------------------------------------
  const transcriptBefore = (await transcript(session, key)).length
  await clearComposer(session)
  await typeIntoComposer(session, LONG_PROMPT)
  const typed = await readComposer(session)
  run.require('the composer holds the long prompt', typed.replace(/\s+/g, ' ').trim() === LONG_PROMPT,
    JSON.stringify(typed.slice(0, 120)))
  await submitComposer(session)
  const submittedAt = Date.now()

  const stopButtonAppeared = await waitFor(
    () => selectorCount(session, STOP_BUTTON),
    count => count > 0,
    { timeoutMs: 30_000, intervalMs: 200, label: 'the send button to become the Stop button' },
  ).then(() => Date.now() - submittedAt).catch(() => -1)
  run.observe('the send button became Stop after (ms)', stopButtonAppeared)
  run.require(
    'the app itself reports a turn in flight — its send button became the Stop button',
    stopButtonAppeared >= 0,
    stopButtonAppeared >= 0
      ? `+${stopButtonAppeared} ms after submit`
      : 'the button never entered stop mode, so there was nothing to stop and the arm would measure nothing',
  )

  await Bun.sleep(STOP_DELAY_MS)
  const processingAtClick = await isProcessing(session, key)
  const clickedAt = Date.now()
  const stoppedAfterMs = clickedAt - submittedAt
  // BLOCKED, not FAIL, and the difference is the whole point of this line.
  // `run.require` throws, and `runCase` maps a throw to FAIL — which would
  // report a PRODUCT DEFECT for "the gateway was fast today". It is not a
  // theoretical race: the same prompt was measured at 9.4 s on one turn and
  // 81.2 s on the next through this gateway, and 119 s on a third rig, against a
  // stop delay of a couple of seconds. A turn that finished before the click was
  // never interrupted, so this arm measured NOTHING, which is exactly what
  // BLOCKED means and exactly what FAIL does not.
  if (!processingAtClick) {
    blocked(
      `the turn had already finished when Stop was pressed (+${stoppedAfterMs} ms), so there was nothing to `
      + 'interrupt and this arm measured nothing. `isProcessing` was false at the click. Re-run — the gateway\'s '
      + 'latency for one prompt varied 9x between two turns on 2026-08-17 — or lengthen LONG_PROMPT so the '
      + 'window is wider.',
    )
  }
  run.check(
    `the session was still processing when Stop was pressed (+${stoppedAfterMs} ms)`,
    processingAtClick,
  )
  await clickSelector(session, STOP_BUTTON)

  const settled = await waitFor(
    () => isProcessing(session, key),
    value => value === false,
    { timeoutMs: 90_000, intervalMs: 250, label: 'the session to stop processing after Stop' },
  ).then(() => Date.now() - clickedAt).catch(() => -1)
  run.observe('processing ended after the click (ms)', settled)
  run.check('Stop ended the turn', settled >= 0, settled < 0 ? 'still processing 90 s after the click' : undefined)

  // The child writes its own record asynchronously; poll rather than sample.
  const interruptsAfter = await (async () => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const now = childInterruptCount(key)
      if (now.count > interruptsBefore.count) return now
      if (Date.now() >= deadline) return now
      await Bun.sleep(1_000)
    }
  })()
  run.observe('interrupt records in the child\'s own transcript after the arm', interruptsAfter)

  const stopArm = (await transcript(session, key)).slice(transcriptBefore)
  run.observe('what the stopped turn left in the transcript', stopArm.map(message => ({
    role: message.role,
    length: message.content.length,
    text: message.content.slice(0, 160),
  })))
  const infoRows = stopArm.filter(message => message.role === 'info').map(message => message.content)
  run.observe('the app\'s own info row', infoRows)
  run.observe('error rows the Stop produced', errorRows(stopArm))
  run.observe('the composer after Stop', (await readComposer(session)).slice(0, 120))

  const stoppedAnswer = stopArm.filter(message => message.role === 'assistant').map(message => message.content).join('')
  run.observe('assistant text the stopped turn kept', stoppedAnswer.length)

  // ---- interrupted, unreachable, or simply too late? -----------------------
  //
  // THE SPLIT THAT KEEPS THIS CASE HONEST, and it was earned: on 2026-08-17 the
  // same prompt took 9.4 s on one turn and 81.2 s on the next through the same
  // gateway, and the 9.4 s one had FINISHED before the Stop was pressed. The
  // turn kept a complete 3 692-character answer, the child recorded no
  // interrupt, and a naive "the reference turn took longer than the stop delay"
  // control passed anyway — 81 s is comfortably longer than 4 s. An arm that
  // could not be driven must not be scored as a defect, and it must not be
  // scored as a pass either.
  //
  // The discriminator is the app's own record. `SessionManager.cancelProcessing`
  // returns early — `if (!managed.isProcessing) return // Not processing,
  // nothing to cancel` — BEFORE it appends the "Response interrupted" info row.
  // So:
  //   - no info row  ⇒ the Stop arrived after the turn had ended. Nothing was
  //     interrupted because there was nothing to interrupt: BLOCKED.
  //   - info row, no child marker ⇒ the app accepted a Stop that never reached
  //     the child. That is the defect this case exists to catch: FAIL.
  //   - both ⇒ the interrupt landed.
  const interruptLanded = interruptsAfter.count > interruptsBefore.count
  const stopWasAccepted = infoRows.some(text => /interrupt/i.test(text))
  if (!interruptLanded && !stopWasAccepted) {
    blocked(
      `the turn ended before the Stop landed, so there was nothing to interrupt and this arm measured nothing. `
      + `Evidence: the app appended no "Response interrupted" row (${JSON.stringify(infoRows)}), which `
      + '`cancelProcessing` only skips by returning early on a session that is no longer processing; the child '
      + `recorded no interrupt; and the "stopped" turn kept ${stoppedAnswer.length} characters of answer. `
      + `The Stop was pressed ${stoppedAfterMs} ms after submit. Re-run — the gateway's latency for one prompt `
      + 'varied 9x between two turns on 2026-08-17 — or lengthen LONG_PROMPT so the window is wider.',
    )
  }
  run.check(
    `THE INTERRUPT LANDED: the child wrote "${CHILD_INTERRUPT_MARKER}" into its own transcript during this arm`,
    interruptLanded,
    interruptLanded
      ? `${interruptsBefore.count} -> ${interruptsAfter.count}`
      : `${interruptsBefore.count} -> ${interruptsAfter.count}, while the app DID accept the Stop `
        + `(${JSON.stringify(infoRows)}). Only the shipped CLI writes that string, and only when it processes an `
        + 'interrupt, so the app recorded a Stop the child never saw.',
  )

  // The answer the model was asked for ENDS in a known token, so a turn that
  // finished before the Stop is visible in its own text rather than by
  // comparison with another sample. This is the guard for the one case the split
  // above cannot see: the app accepting a Stop for a turn that had already
  // produced everything.
  run.check(
    `the interrupted turn was CUT SHORT — its text does not reach "${COMPLETION_MARKER}", the last item it was asked for`,
    !stoppedAnswer.includes(COMPLETION_MARKER),
    `kept ${stoppedAnswer.length} characters, ending ${JSON.stringify(stoppedAnswer.slice(-60))}`,
  )

  // ---- THE NEXT MESSAGE, and it is the claim -------------------------------
  //
  // A SHORT turn on purpose. An earlier draft reused the long prompt so one arm
  // could double as a timing control; the gateway then took longer than the
  // 300 s turn timeout to finish it and the case failed for the upstream's
  // latency rather than for anything about Stop. The claim is that the session
  // answers — not that it answers a 200-item list inside five minutes.
  const startedReference = Date.now()
  const nextToken = token('DELTA')
  const next = await echoTurn(session, run, key, 'the message after the Stop', nextToken, TURN_TIMEOUT_MS)
  const referenceMs = Date.now() - startedReference
  run.observe('durations', { stoppedAfterMs, settledAfterClickMs: settled, nextMessageMs: referenceMs })
  run.check(
    'THE CLAIM: the session answered the next message normally after the Stop',
    next.said.includes(nextToken) && next.errors.length === 0,
    next.errors.length > 0
      ? `errors: ${next.errors.join(' | ').slice(0, 400)}`
      : `the assistant said ${JSON.stringify(next.said.slice(0, 200))} in ${referenceMs} ms`,
  )

  // ---- interrupt, not kill -------------------------------------------------
  const after = await waitForChildCount(dir, 1, 5_000)
  run.observe('children at the end', after.map(child))
  run.check(
    'the Stop INTERRUPTED the child rather than killing it — the same process served the seed turn, the stopped turn '
    + 'and the next message',
    after.length === 1 && childIdentity(after[0]!) === childIdentity(original),
    `seed ${childIdentity(original)}; end ${JSON.stringify(after.map(childIdentity))}. A different process here would `
    + 'still satisfy the claim above (the app resumes), but it would mean Stop is session death rather than '
    + '`Query.interrupt()`.',
  )
  if (after.length === 1 && childIdentity(after[0]!) === childIdentity(original)) {
    run.observe('that process has now been alive for', `${etimeSeconds(after[0]!.etime)} s`)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
