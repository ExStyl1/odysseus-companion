/**
 * RS-20 (P6.284) — an interrupted turn, and whether its SUCCESSOR knows it was
 * cut off.
 *
 * `have` on all three by code read, unmeasured live — which is what makes this a
 * measure and not a promote. The row's native-mechanism clause, verbatim:
 * *"pi and claude: `BaseAgent.redirect`'s default fires
 * `forceAbort(AbortReason.Redirect)`, and both override it the same way. codex:
 * `turn/interrupt`, which stops the current turn only, and
 * `redirectFallbackInterruptsTurn()` declares that its `false` return is inert so
 * the host does not stamp `wasInterrupted` on a turn nothing touched."*
 *
 * ## The detector, and the one that looked right and is WRONG
 *
 * The obvious detector is a `terminal_reason:user_stop` info row. **There is no
 * such row, by design.** `persistTurnTerminalVerdict` writes a verdict only when
 * `hasTerminalReasonNotice(reason)` is true, and `user_stop` is deliberately
 * excluded — the docblock beside it says a server that wrote every reason *"would
 * add an INVISIBLE row to every `user_stop` — i.e. every interrupt — and
 * `groupMessagesByTurn` treats a `terminal_reason:` row as NOT an interruption,
 * so those turns would stop grouping as interrupted"*. A case built on that
 * marker would fail against correct behaviour on every runtime at once.
 *
 * What an interrupt really writes, and what this case reads:
 *
 * | Claim | Source that writes it |
 * | --- | --- |
 * | the interrupt row rendered | an `info` message whose content is the literal `Response interrupted` — `SessionManager.stop(silent=false)`, a host literal rather than a localized string, so it is stable to assert on |
 * | running tools were marked cut off | `handleInterrupted` sets `toolStatus: 'error'`, `toolResult: 'Interrupted'` on every tool with no result |
 * | the work actually stopped | processes on this machine carrying the run's marker — `markedProcesses`, the one detector that does not come from the app. It separates "we stopped watching" from "it stopped running" |
 * | the SUCCESSOR knows | the RUNTIME's own session file. `managed.wasInterrupted` decorates the next effective model message with `<system-reminder>The previous assistant response was interrupted by the user and may be incomplete…` and that decoration is deliberately NOT stored in our own transcript, so our transcript cannot answer this half at all |
 *
 * ## The two controls the row names
 *
 * *"a turn that completes normally must not be stamped, and an interrupt sent
 * when NO turn is running must stamp nothing (codex's declared inert path)"*.
 * The first runs as two ordinary turns before the probe, with the reminder count
 * required to stay at zero. The second is read off the composer's own primary
 * control: while nothing is running there is no stop affordance to press
 * (`resolveSubmitControl` returns `stop` only during a turn), which is the UI's
 * statement of the same fact — recorded as such rather than dressed up as a
 * press of a button that is not there.
 *
 * ## Per runtime, one run
 *
 * The case reads the connection the session is bound to and records it; the
 * sitting runs it once per card. The successor half needs a runtime session
 * reader, and there is one for Pi and for claude only — on codex the case says
 * so and scores the halves it can, rather than reporting an absence it has no
 * instrument for.
 */

import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import {
  longToolTaskPrompt,
  markedProcesses,
  readSubmitControl,
  SEND_BUTTON,
  submitWithoutWaiting,
  waitForFirstTool,
  waitUntilProcessing,
  waitUntilSettled,
} from '../lib/mid-stream.ts'
import { readCodexSessionLog } from '../lib/codex-session-log.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { boundCard, listConnections, runtimeOf } from '../lib/runtime-switch.ts'
import { configDir, readClaudeSessionLog, readPiSessionLog, type RuntimeSessionLog } from '../lib/runtime-session-log.ts'
import { assertElectronApi, freshSession, setPermissionMode, transcript, type SessionKey } from '../lib/state.ts'
import { clickSelector } from '../lib/viewport.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { checkAbsence, positive, turnAnswered } from '../lib/turn-evidence.ts'

const ID = 'RS-20'
const TITLE = 'an interrupted turn — the interrupt row, the stopped work, and whether the next turn’s context records the predecessor as cut off'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.284',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: run once per card. No key is read; the card is named in the observations.',
} as const satisfies CaseMeta

/** The host's own literal for the interrupt row (`SessionManager.stop`). */
const INTERRUPT_ROW = 'Response interrupted'

/** The decoration the NEXT effective model message carries — runtime-side only. */
const SUCCESSOR_REMINDER = 'was interrupted by the user and may be incomplete'

/**
 * The runtime's own session file, for each of the THREE runtimes (C5.25, R4
 * 2026-09-12).
 *
 * The codex arm used to return `undefined` here and the case then said the
 * successor half was *"not scored on codex-runtime"* — the last hop of this
 * row's codex arm, and the only one it was missing. It was not a gap in codex:
 * the app-server writes `sessions/**` + `/rollout-*.jsonl` inside the
 * per-session `CODEX_HOME`, and that file is on disk for the whole life of the
 * session a case is driving. See `lib/codex-session-log.ts` for what was
 * measured and why the attribution is the rollout's own `session_meta.cwd`
 * rather than the newest file.
 */
function runtimeLog(runtime: string, key: SessionKey): RuntimeSessionLog | undefined {
  if (runtime === 'pi') return readPiSessionLog(key)
  if (runtime === 'anthropic') return readClaudeSessionLog(key.workspaceId, configDir(), key.sessionId)
  if (runtime === 'codex-runtime') return readCodexSessionLog(key)
  return undefined
}

/**
 * How many interrupted-reminders the runtime's own session file carries, or
 * `undefined` when NO FILE ANSWERED.
 *
 * The `log.file` clause is the load-bearing half, added by R4 on 2026-09-12
 * while driving C5.25, and it is a detector fault of the family this harness
 * exists to catch. All three readers answer a failed read with
 * `{ entries: [], reason }` — a shape this function used to count, returning
 * **0**. So a read that found nothing became "zero reminders", the positive
 * control *"two turns that completed normally stamped nothing"* PASSED on it
 * (both of its arms agree when the log is empty — a deleted test that still
 * runs), and the real check then reported `0 → 0`, i.e. *"on <runtime> the
 * successor is not told"*, about a runtime that was telling it. Exactly what
 * {@link directoryIsFor}'s docblock records having already happened once on
 * claude. Reading `file` rather than `reason` is deliberate: a successful read
 * can also carry a `reason` (an ambiguity note), and only `file` says a file was
 * actually opened.
 */
function reminderCount(log: RuntimeSessionLog | undefined): number | undefined {
  if (!log || log.file === undefined) return undefined
  return log.entries.filter(entry => entry.text.includes(SUCCESSOR_REMINDER)).length
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.check(
    'the case ran in a session it created',
    key.fresh,
    key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`,
  )

  const slug = await boundCard(session, key.sessionId)
  const rows = await listConnections(session)
  const connection = rows.find(r => r.slug === slug)
  if (!connection) {
    blocked(`this session is bound to ${slug ? `connection ${slug}, which the app does not list` : 'no connection'}`)
  }
  const runtime = runtimeOf(connection.providerType)
  run.observe('runtime', { card: connection.name ?? connection.slug, slug: connection.slug, providerType: connection.providerType, runtime })

  // The posture — PR-3 (W14-sit, 2026-09-11). This case interrupts a turn made
  // of `sleep 3 && echo …` shell calls, and with no posture the FIRST of them
  // raises a permission card that nothing answers: the turn never starts
  // running, `waitForFirstTool` never sees a tool, and the case burns its
  // timeout having measured the absence of an operator rather than the
  // interrupt. Permissions are not what this row asks about, so the strongest
  // posture is the right one — and the approver underneath is the net for
  // anything `bypassPermissions` deliberately does not cover (the removal
  // breaker fires in EVERY mode).
  const setMode = await setPermissionMode(session, key.sessionId, 'bypassPermissions').then(() => 'set').catch(error => `refused: ${String(error)}`)
  run.observe('permission-posture', { posture: 'bypassPermissions', outcome: setMode })
  const approver = approvePermissionsWhile(session, key.sessionId)
  const stopApprovals = async (): Promise<void> => { run.observe('permission-cards-answered', await approver.stop()) }

  // ---- CONTROL 2 — nothing to interrupt while nothing runs ------------------
  const idleControl = await readSubmitControl(session)
  run.observe('submit-control-while-idle', idleControl)
  run.check(
    'THE CONTROL — with no turn in flight there is no stop affordance to press',
    idleControl.type !== 'button',
    idleControl.type === 'button'
      ? 'the composer offers Stop with nothing running — an interrupt here would stamp a turn nothing touched'
      : undefined,
  )

  // ---- CONTROL 1 — two ordinary turns, which must stamp nothing -------------
  const firstReady = await sendPrompt(session, key, 'I am setting up a short test. Reply with the single word ready.', 120_000)
  const secondReady = await sendPrompt(session, key, 'Thank you. Reply with the single word ready again.', 120_000)
  const baselineLog = runtimeLog(runtime, key)
  const baseline = reminderCount(baselineLog)
  run.observe('successor-detector', baseline === undefined
    ? `unavailable on ${runtime} — no runtime session reader exists for it, so the successor half is not scored here`
    : { file: baselineLog?.file, entries: baselineLog?.entries.length, reason: baselineLog?.reason })
  if (baseline !== undefined) {
    // F1.504 — "stamped nothing" needs two turns that ANSWERED and a log that
    // recorded them: an empty log stamps nothing either.
    const answered = [turnAnswered(firstReady.added), turnAnswered(secondReady.added)]
    const logged = baselineLog?.entries.length ?? 0
    checkAbsence(
      run,
      'THE CONTROL — two turns that completed normally stamped nothing',
      baseline === 0,
      positive(answered.every(turn => turn.ok) && logged > 0, 'two answered turns and a runtime log that recorded them',
        `${answered.map(turn => turn.saw).join(' | ')}; runtime log entries ${logged}`),
      baseline === 0 ? undefined : `${baseline} interrupted-reminder(s) already present before any interrupt — the count below cannot be attributed to this run`,
    )
  }

  // ---- THE PROBE -----------------------------------------------------------
  const marker = `rs20${Date.now().toString(36)}`
  const buildId = `RS20-${marker}`
  // F1.562 — the probe turn's rows are the ones after this count: two warm-up turns precede it.
  const beforeProbe = (await transcript(session, key)).length
  await submitWithoutWaiting(session, longToolTaskPrompt(buildId, 6, marker))
  await waitUntilProcessing(session, key, 90_000)
  const firstTool = await waitForFirstTool(session, key, 150_000)
  run.observe('tools-before-stop', firstTool)
  run.require(
    'the turn to be interrupted is tool-shaped and running',
    firstTool.names.length > 0,
    'no tool call started — interrupting a turn that was about to end measures nothing',
  )

  const runningControl = await readSubmitControl(session)
  run.observe('submit-control-while-running', runningControl)
  run.require(
    'the composer offers Stop while the turn runs',
    runningControl.type === 'button',
    `it reports type=${String(runningControl.type)} — there is nothing to click`,
  )

  const processesBefore = markedProcesses(marker).length
  run.observe('marked-processes-before-stop', processesBefore)

  await clickSelector(session, SEND_BUTTON)
  const settled = await waitUntilSettled(session, key, { quietMs: 8_000, timeoutMs: 180_000 })
  run.observe('settled', settled)

  const after = (await transcript(session, key)).slice(beforeProbe)
  const interruptRows = after.filter(m => m.role === 'info' && m.content.includes(INTERRUPT_ROW))
  run.check(
    'the interrupt row rendered',
    interruptRows.length > 0,
    interruptRows.length > 0
      ? undefined
      : `no info message carrying ${JSON.stringify(INTERRUPT_ROW)} — on ${runtime} the stop produced no user-visible verdict`,
  )
  const cutOffTools = after.filter(m => m.toolName && m.toolResult === 'Interrupted')
  run.observe('tools-marked-interrupted', cutOffTools.map(m => m.toolName))
  run.check(
    'the tools still running when Stop was pressed are marked cut off',
    cutOffTools.length > 0 || firstTool.settled === firstTool.names.length,
    'no tool was marked Interrupted and at least one was still open when Stop was pressed',
  )

  const processesAfter = markedProcesses(marker).length
  run.observe('marked-processes-after-stop', processesAfter)
  run.check(
    'the work itself stopped, not just our view of it',
    processesAfter <= processesBefore,
    `${processesBefore} marked process(es) before the stop, ${processesAfter} after — the sequence is still spawning`,
  )

  // ---- THE SUCCESSOR -------------------------------------------------------
  await sendPrompt(session, key, 'Never mind that. Reply with the single word noted.', 150_000)
  const afterLog = runtimeLog(runtime, key)
  const afterCount = reminderCount(afterLog)
  run.observe('successor-reminders', { before: baseline, after: afterCount, file: afterLog?.file, reason: afterLog?.reason })
  if (baseline === undefined || afterCount === undefined) {
    run.observe(
      'successor-verdict',
      `not scored on ${runtime}: the decoration rides the effective model message and is deliberately not stored in our transcript,`
      + ` and no runtime session file answered for this session (${afterLog?.reason ?? 'no reader for this runtime family'}).`
      + ' Record the cell as UNMEASURED with this reason, never as absent.',
    )
    await stopApprovals()
    return
  }
  run.check(
    'the NEXT turn’s context records the predecessor as cut off',
    afterCount > baseline,
    afterCount > baseline
      ? undefined
      : `the runtime session file gained no interrupted-reminder after the stop (${baseline} → ${afterCount}) — on ${runtime} the successor is not told`,
  )
  await stopApprovals()
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, one content panel. New session on the card under test.',
    '2. `bun run scripts/cdp/cases/rs-20.ts` with NESSY_CDP_PORT pointed at the app.',
    '3. Repeat per card. On a codex card the successor half is reported UNMEASURED with its reason — record it that way; do not write `absent`.',
  ],
  expected: 'the interrupt row renders, the open tools are marked Interrupted, the marked processes stop appearing, and (pi/claude) the runtime session file gains the interrupted reminder on the next turn.',
  detector: 'the `Response interrupted` info literal, `toolResult === "Interrupted"`, `markedProcesses(marker)`, and the runtime\'s own session file. NOT a `terminal_reason:user_stop` row — `user_stop` deliberately writes none, and a case built on it would fail against correct behaviour.',
  positiveControl: 'two turns that complete normally must stamp nothing; and with no turn in flight the composer offers no stop affordance at all, which is the UI\'s own statement of codex\'s declared inert path.',
  doneMeans: 'each runtime\'s interrupt row renders and the NEXT turn\'s context records the predecessor as cut off, or the cell is demoted with the run behind it.',
} as const satisfies SittingRecipe
