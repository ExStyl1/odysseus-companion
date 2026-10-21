/**
 * STR-4 — A USER STOP ON A CODEX SESSION ACTUALLY INTERRUPTS THE TURN.
 *
 * Until `055bd70ad` it did not, and the reason it was invisible is the whole
 * design of this case. `turn/interrupt` requires BOTH `threadId` and `turnId`;
 * `forceAbort` sent only the first, and sent it as a NOTIFICATION — and
 * `ClientNotification` is `{"method":"initialized"}` and nothing else, so the
 * app-server never dispatched it. Measured against the bundled binary over real
 * stdio: the request form is rejected by name for the missing field, and the
 * notification form draws no answer whatsoever. Meanwhile `forceAbort` also calls
 * `this.turnSink?.finish()`, so OUR side stopped listening either way.
 *
 * **That is why an app-side detector cannot answer this.** The transcript stops
 * growing, `isProcessing` goes false, and the "Response interrupted" row appears
 * — `SessionManager.cancelProcessing` writes it when the user ASKS, before
 * anything reaches the backend (`LIV-2` records that trap) — in BOTH the broken
 * and the fixed world. Every one of those readings is about us having stopped
 * watching.
 *
 * ## THE DETECTOR: the processes the turn is spawning
 *
 * The seed asks codex to run six `sleep 3 && echo probe-<marker>-N` commands one
 * at a time. Those are real processes on this machine, carrying a per-run marker,
 * and codex — not our host — spawns them. So:
 *
 * - **the positive control, first**: while the turn runs, `ps` must FIND them. If
 *   it never does, the instrument cannot see the turn's work and every absence
 *   below would be meaningless — the case reports BLOCKED, not PASS. (AGENTS.md:
 *   an absence needs a positive control on the same rig.)
 * - **the claim**: after the Stop, no NEW marked process appears for the length of
 *   the watch. A turn that was still running server-side would keep spawning
 *   them: it had four commands left, each three seconds long.
 *
 * The count of DISTINCT commands seen is what is compared, not a snapshot — a
 * `sleep 3` lives three seconds, so sampling "are any running now" answers a
 * different question from "did any new one start".
 *
 * ## What this case does not claim
 *
 * That the app-server acknowledged the interrupt (nothing awaits that answer by
 * design — `forceAbort` is synchronous and the sink is finished either way), nor
 * that the codex thread was torn down. Only that the work stopped.
 */

import { randomBytes } from 'node:crypto'

import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import {
  appLogOffset,
  longToolTaskPrompt,
  markedProcesses,
  readSessionLogMatching,
  requireTurnStarted,
  submitWithoutWaiting,
  toolActivity,
  transcriptWithQueueFlags,
  waitUntilProcessing,
  type ToolActivity,
} from '../lib/mid-stream.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, isProcessing, setPermissionMode, visibleElements, waitFor } from '../lib/state.ts'
import { clickSelector } from '../lib/viewport.ts'

const ID = 'STR-4'
const TITLE = 'A user Stop on a Codex turn stops the work, not just our view of it'

const PROBE_STEPS = 6
/** `FreeFormInput`: `type` is `button` only while `submitMode === 'stop'`. */
const STOP_BUTTON = 'button[data-tutorial="send-button"][type="button"]'
/** How long to watch for a new marked process after the Stop. Two commands' worth. */
const WATCH_AFTER_STOP_MS = 20_000

function token(prefix: string): string {
  return `${prefix}${randomBytes(3).toString('hex').toUpperCase()}`
}

/** Distinct marked command lines seen across a window — not a snapshot. */
async function watchMarked(marker: string, forMs: number): Promise<string[]> {
  const seen = new Set<string>()
  const deadline = Date.now() + forMs
  for (;;) {
    for (const row of markedProcesses(marker)) {
      // The pid changes per process; the command is what identifies the STEP.
      seen.add(row.replace(/^\s*\d+\s+/, ''))
    }
    if (Date.now() >= deadline) return [...seen]
    await Bun.sleep(400)
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const requested = process.env.NESSY_CDP_CODEX_CARD?.trim()
  const connections = await listConnections(session)
  const cards = connections.filter(row => row.providerType === 'codex-runtime')
  run.observe('codex-runtime cards on this host', cards.map(row => row.slug))
  if (cards.length === 0) {
    blocked('this case needs a codex-runtime connection; `turn/interrupt` is codex\'s own protocol method and on a '
      + 'host without a codex card the path never runs.')
  }
  const card = requested && cards.some(row => row.slug === requested) ? requested : cards[0]!.slug
  run.observe('card under test', card)

  const seedId = token('ALPHA')
  const marker = `STR4${randomBytes(2).toString('hex').toUpperCase()}`
  run.observe('per-run process marker', marker)

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.require('the case ran in a session it created', key.fresh,
    key.fresh ? undefined : `${key.reason} (inherited ${key.inheritedMessages} messages)`)
  const outcome = await switchRuntime(session, key.sessionId, card)
  run.observe(`switch onto ${card}`, outcome)
  const active = await waitForConnection(session, key.sessionId, card)
  run.require(`the session runs on ${card}`, active === card, `llmConnection=${String(active)}`)
  await setPermissionMode(session, key.sessionId, 'bypassPermissions')

  const logOffset = appLogOffset()
  const submittedAt = await submitWithoutWaiting(session, longToolTaskPrompt(seedId, PROBE_STEPS, marker))
  run.observe('the app reported a turn in flight after (ms)', await waitUntilProcessing(session, key))

  // ---- THE POSITIVE CONTROL: can this rig see the turn's work at all? ------
  // Short enough that the six-command sequence is still going when it ends —
  // `LIV-2` measured a 9x latency spread on this gateway, and a control window
  // that outlasts the turn turns the Stop into a no-op the case would then score.
  const before = await watchMarked(marker, 25_000)
  run.observe("marked commands seen WHILE the turn ran", before)
  if (before.length === 0) {
    const messages = await transcriptWithQueueFlags(session, key)
    requireTurnStarted(run, messages.filter(m => m.role === 'error').map(m => m.content), 'the seed turn')
    blocked(
      `no process carrying ${marker} was ever visible to \`ps\` while the turn ran (tools so far: `
      + `${JSON.stringify(toolActivity(messages).names)}). The claim below is an ABSENCE — "no new command started after `
      + 'the Stop" — and without this control it would be equally true of an interrupted turn and of a rig that cannot '
      + "see the turn's processes at all. Either the model never ran the commands, or codex executes them somewhere "
      + 'this `ps` cannot reach; both need a different instrument, not a verdict.',
    )
  }

  // ---- the Stop, through the app's own button ------------------------------
  const stopVisible = await waitFor(
    () => visibleElements(session, STOP_BUTTON),
    rows => rows.length === 1,
    { timeoutMs: 30_000, intervalMs: 200, label: 'the send button to become the Stop button' },
  ).then(rows => rows[0]).catch(() => undefined)
  // A turn that finished before the Stop is BLOCKED, not FAIL — `LIV-2`'s first
  // defect was scoring exactly that state, and the reason it matters is that a
  // Stop pressed after the answer arrived measures nothing at all.
  const processingAtClick = await isProcessing(session, key)
  if (stopVisible === undefined || !processingAtClick) {
    blocked(
      'the turn was over before the Stop could be pressed (stop button '
      + `${stopVisible ? 'present' : 'absent'}, isProcessing=${String(processingAtClick)}). `
      + `It ran ${before.length} of ${PROBE_STEPS} probe commands in ${Date.now() - submittedAt} ms. `
      + 'There is nothing to interrupt, so this run measures upstream latency rather than the interrupt. Re-run, or '
      + 'lengthen the probe sequence.',
    )
  }
  run.check('the app itself reports a turn in flight — its send button became the Stop button, and the session was '
    + 'processing at the instant of the click', true, `after ${Date.now() - submittedAt} ms`)
  await clickSelector(session, STOP_BUTTON)
  const clickedAt = Date.now()
  run.observe('Stop pressed at (ms into the turn)', clickedAt - submittedAt)
  const commandsAtStop = markedProcesses(marker).length
  const seenAtStop = [...before]

  // ---- THE CLAIM ----------------------------------------------------------
  const after = await watchMarked(marker, WATCH_AFTER_STOP_MS)
  const fresh = after.filter(command => !seenAtStop.includes(command))
  run.observe(`marked commands seen in the ${WATCH_AFTER_STOP_MS} ms AFTER the Stop`, after)
  run.observe('…of those, ones never seen before the Stop', fresh)

  const processingAfter = await isProcessing(session, key)
  const messages = await transcriptWithQueueFlags(session, key)
  const tools: ToolActivity = toolActivity(messages)
  run.observe('the transcript after the Stop', {
    tools,
    roles: messages.map(message => message.role),
    lastAssistant: messages.filter(m => m.role === 'assistant').map(m => m.content.slice(0, 200)),
  })
  run.observe('interrupt-related lines the app logged',
    readSessionLogMatching(logOffset, /interrupt|Codex (abort|forceAbort)/i) ?? '(no application log)')

  run.check(
    'THE CLAIM: no NEW probe command started after the Stop — the work stopped, not just our view of it',
    fresh.length === 0,
    `${JSON.stringify(fresh)} started after the click; ${commandsAtStop} were running at it. `
    + 'A turn still alive server-side had four commands left, three seconds each, so it would have spawned more.',
  )
  run.check(
    'and the sequence never completed — the Stop landed before the sixth command',
    seenAtStop.length + fresh.length < PROBE_STEPS,
    `${seenAtStop.length + fresh.length} of ${PROBE_STEPS} probe commands ever ran`,
  )
  run.check('the app also stopped reporting the session as processing', processingAfter === false,
    `isProcessing=${String(processingAfter)}`)
  // Recorded, deliberately not the claim: this row is written by
  // `cancelProcessing` when the user ASKS, before anything reaches the backend.
  // It proves a Stop was REQUESTED. `LIV-2` records the same distinction.
  run.observe('the app appended its own "Response interrupted" row',
    messages.filter(m => m.role === 'info' || m.role === 'status').map(m => m.content.slice(0, 120)))
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
