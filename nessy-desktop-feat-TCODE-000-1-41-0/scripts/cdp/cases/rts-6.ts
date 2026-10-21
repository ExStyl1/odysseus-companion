/**
 * RTS-6 — a `/loop` started on Pi must stop when the session leaves Pi.
 *
 * Blocker C2. The loop is delivered by `piCronServices`, which owns a live
 * `setInterval`, and delivery is not provider-gated: nothing in the timer asks
 * which runtime the session is on before waking it. So without the explicit
 * stop that `clearRuntimeScopedSessionState` performs
 * (`SessionManager.ts` — `piCronServices.get(key)?.stop()` then `.delete(key)`),
 * a loop started on Pi keeps firing turns at a session now running on Claude or
 * Codex: prompts the user did not send, on a runtime they did not schedule them
 * for, charged to a different provider.
 *
 * ## The positive control comes first, and the case refuses without it
 *
 * "No turn fired after the switch" is an ABSENCE, and an absence proves nothing
 * until something on the same rig makes the thing happen. A build where `/loop`
 * never schedules anything passes the naive version of this case perfectly. So
 * the loop must be seen to FIRE on Pi before the switch is allowed to mean
 * anything; if it does not, the case reports BLOCKED — the instrument did not
 * work — rather than PASS.
 *
 * ## Turns, not prose
 *
 * A fire is measured as the transcript growing with no user message added by
 * this case. The model's own account of whether it scheduled something is not
 * evidence: RTS-11 shows `/loop` is offered on runtimes whose scheduling tools
 * do not exist, which is precisely the situation in which a model will describe
 * a schedule it never created.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, transcript, waitFor, type SessionKey } from '../lib/state.ts'
import { clearComposer, readComposer, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { requireRuntimeTrio, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { waitUntilSettled } from '../lib/mid-stream.ts'

const ID = 'RTS-6'
const TITLE = 'A /loop scheduled on Pi stops firing when the session moves to another runtime'

/** Short enough to watch twice, long enough that the app accepts it. */
const INTERVAL = '1m'
const INTERVAL_MS = 60_000

async function messageCount(session: CdpSession, key: SessionKey): Promise<number> {
  return (await transcript(session, key)).length
}

/**
 * Type a command whose palette entry cannot carry an argument, and submit it.
 *
 * The palette closes as soon as the caret leaves the slash-token — the space
 * after `/loop` does it — so `submitComposer`'s refusal-while-open guard is not
 * being worked around here; by the time Enter is pressed there is no palette to
 * intercept it. The composer is read back and returned so the row records what
 * was actually sent.
 */
async function sendTypedCommand(session: CdpSession, text: string): Promise<string> {
  await clearComposer(session)
  await typeIntoComposer(session, text)
  const typed = await readComposer(session)
  if (typed.replace(/\s+/g, ' ').trim() !== text.replace(/\s+/g, ' ').trim()) {
    throw new Error(`composer-mismatch: meant to send ${JSON.stringify(text)}, composer holds ${JSON.stringify(typed)}`)
  }
  await submitComposer(session)
  return typed
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const key = await freshSession(session, `${ID} loop then switch`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')
  await switchRuntime(session, key.sessionId, trio.pi)
  run.require(
    'the session starts on Pi',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )

  // --- start the loop ------------------------------------------------------
  //
  // Typed, not selected from the palette, and that is a deliberate exception to
  // this harness's rule. `selectSlashCommand` asserts the app's own prefill,
  // which is the cheap proof that a command was committed as a command rather
  // than sent as prose. `/loop` has no prefill: selecting it leaves the composer
  // empty (a residual "\n"), i.e. it is a self-executing entry like `/compact`,
  // so there is no way to attach `1m <prompt>` through the selection path.
  //
  // The rule exists because a run once typed `/subtask …` as prose, the parent
  // answered it as a question, and the pass was retracted. What replaces the
  // prefill assertion here is stronger, not weaker: the positive control below
  // requires the loop to FIRE. Prose cannot schedule a turn, so a fire is proof
  // the text was taken as a command — and if it never fires the case reports
  // BLOCKED rather than reading the silence as a pass.
  const started = await sendTypedCommand(session, `/loop ${INTERVAL} Reply with exactly: LOOP-TICK`)
  run.observe('composer at submit', started)

  const afterStart = await messageCount(session, key)
  run.observe('messages after starting the loop', afterStart)

  // --- the positive control: it must actually fire -------------------------
  const fired = await waitFor(
    () => messageCount(session, key),
    count => count > afterStart,
    { timeoutMs: INTERVAL_MS * 3, intervalMs: 5_000, label: 'the loop to fire at least once on Pi' },
  ).catch(() => afterStart)
  run.observe('messages after waiting for a tick on Pi', fired)
  if (fired <= afterStart) {
    blocked(
      `the loop never fired on Pi within ${(INTERVAL_MS * 3) / 1000}s, so "it stopped after the switch" would be `
      + 'unfalsifiable — the absence this case is about needs a firing loop to be an absence OF. '
      + 'RTS-11 is the related read: /loop is offered on runtimes whose scheduling tools do not exist.',
    )
  }
  run.check('the loop fires on Pi — the instrument works before it is used', fired > afterStart)

  // --- the switch ----------------------------------------------------------
  // Settle first: the tick's message row lands BEFORE the tick's turn settles
  // (measured 2026-08-21 on Pi 0.84 / packaged 1.31.0 — deterministic, not a
  // flake: message-count growth at 7s, `isProcessing` still true, switch
  // refused SESSION_BUSY on every run; the 2026-08-15 pass predates the Pi
  // bump). The refusal itself is the PRODUCT being right — RTS-8 owns that
  // property — so this case must wait out the turn it provoked before asking
  // for the switch, or it measures its own race.
  const settle = await waitUntilSettled(session, key, { quietMs: 8_000, timeoutMs: 180_000 })
  run.observe('tick turn settled before the switch', settle)
  const outcome = await switchRuntime(session, key.sessionId, trio.claude)
  run.observe('switch pi → claude', outcome)
  run.require('the switch was accepted', outcome.ok, outcome.error ?? '')
  run.require(
    'the session reports the claude card',
    (await waitForConnection(session, key.sessionId, trio.claude)) === trio.claude,
    trio.claude,
  )
  // What the app SAYS it stopped, for the record. The measurement below is what
  // decides the row — `capabilityDelta` is the app's own account of itself.
  run.observe('capabilityDelta reported by the switch', outcome.result?.capabilityDelta ?? null)

  const atSwitch = await messageCount(session, key)
  run.observe('messages at the moment of the switch', atSwitch)

  // --- two full intervals of silence --------------------------------------
  const quietFor = INTERVAL_MS * 2 + 30_000
  await Bun.sleep(quietFor)
  const afterQuiet = await messageCount(session, key)
  run.observe(`messages after ${quietFor / 1000}s on the new runtime`, afterQuiet)

  run.check(
    'no turn fired after the session left Pi — the cron timer was stopped, not merely orphaned',
    afterQuiet === atSwitch,
    afterQuiet === atSwitch
      ? `${atSwitch} messages, unchanged across two intervals`
      : `${atSwitch} → ${afterQuiet}: the loop kept waking a session that is no longer on Pi`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
