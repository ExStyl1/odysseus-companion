/**
 * RS-81 (D1.81) — claude's interrupt receipt: what the child PROMISES, what the
 * host asks for, and what it does with the answer.
 *
 * ## The row
 *
 * D1.81, carried from P6.468: *"does claude's interrupt receipt name messages
 * Stop did not cancel — we stamp every message with a uuid so the receipt can
 * name them, then discard it"*. `done_means`: *"a recorded PASS/FAIL — a
 * non-empty `still_queued` means Stop lied, and the fix is `cancel_queued:
 * true`."*
 *
 * Measure sitting 5c recorded it NOT driven, for a reason that is itself a
 * reading: the receipt is discarded by the host (`void live.interrupt()
 * .catch(...)`), and the claude per-session diagnostic scores 0 for
 * `still_queued`, `cancel_queued`, `interrupt` and `control_request` over an
 * ORDINARY turn — so a driven arm needs an actual interrupt with messages
 * queued.
 *
 * ## What the artefact already says, before anything is driven
 *
 * Both halves of the seam are IN the shipped build, and both were read off it
 * rather than off the source tree (`grep -aoF`, occurrences, with
 * `contextWindow` → 1501 in the host bundle as the reader's positive control):
 *
 * | fact | where | reading |
 * | --- | --- | --- |
 * | the child ADVERTISES the receipt | vendored `claude` 2.1.251 | `interrupt_receipt_v1` = "the interrupt control_response success payload carries still_queued (uuids of async user messages that survive the interrupt)"; `still_queued` 18, `cancel_queued` 23 |
 * | the child also advertises the FIX | same binary | `interrupt_cancel_queued_v1` = the request honours `cancel_queued: true`, and `still_queued` is then empty |
 * | the host READS the advertisement | `dist/main.cjs` | `childAdvertisesInterruptReceipt()`, and its own comment: *"nothing in this tree consumes `still_queued` yet, so a branch here would be invented rather than read"* |
 * | the host never SENDS the fix | `dist/main.cjs` | `cancel_queued` → **0**, `interrupt_cancel_queued_v1` → **0** |
 * | the host DISCARDS the receipt | `dist/main.cjs` | `void live.interrupt().catch(...)` — true when this table was read; since D1.361 the host READS it (below) |
 *
 * So the row's premise is confirmed in the bundle. What is NOT confirmed there
 * is whether this child, on this gateway card, actually advertises the
 * capability — that is a runtime fact about the session, and it is the one thing
 * a drive can add.
 *
 * ## TWO arms, because one of them is the control
 *
 * Arm A presses Stop with a message QUEUED behind a running tool call; arm B
 * presses the same Stop with nothing queued. Everything else is identical — same
 * card, same `queue` setting, same prompt, same wait for a real tool call, same
 * click. Without B, "Stop did not stop it" in A is equally true of a click that
 * never landed, and the first drive of this case met exactly that ambiguity.
 *
 * ## What this case drives, and what it reads
 *
 * The host writes the answer itself, at the seam, on every interrupt:
 *
 *     Claude turn interrupt (<reason>); child advertises|does NOT advertise
 *     interrupt_receipt_v1 (capabilities: <the advertised list>)
 *
 * **`noteInterruptSeam` writes it TWICE, to two different files, and this case
 * read only one of them until D1.381.** Its whole body is `this.debug(note)`
 * plus `appendSessionRuntimeHostNote('claude', …)`. The first lands in the
 * host's own debug channel, which a PACKAGED build does not write; the second
 * writes `<config>/logs/runtime/<id>-claude-host.txt`, whose `-host` tail exists
 * precisely to keep it off `<id>-claude.txt` — the file that on claude belongs
 * to the CHILD (RS-71 measured that one readable on this packaged build, 238
 * lines, six domain tags). So the host's note file is the surface that CAN carry
 * the seam here, and `'…-claude-host.txt'.endsWith('-claude.txt')` is `false`:
 * the reader that needed it was filtering it out. Both are read now, and which
 * one carried the line is recorded.
 *
 * So the case starts a long tool-shaped turn, QUEUES a second message while it
 * runs, presses Stop, and reads that line.
 *
 * ## A SECOND detector rides the same drive — D1.376, one read, its own verdict
 *
 * The composer's primary control is `stop` while a turn runs and the composer is
 * EMPTY, which is exactly the state a queued submit leaves behind. One read of
 * it plus one read of the host's own `isProcessing` says whether the app still
 * believes a turn is in flight after a follow-up was queued behind it — the
 * whole of D1.376, with no second turn and no waiting. It is a SEPARATE
 * PASS/FAIL, because a build can lower `isProcessing` in the renderer and still
 * interrupt correctly at the host, and one verdict for both would hide whichever
 * half was right.
 *
 * ## The controls
 *
 *  1. **the diagnostic is readable at all** — it exists and carries lines before
 *     the interrupt. Without it every count below is an unread file.
 *  2. **the seam line is ABSENT before the Stop and PRESENT after** — the same
 *     file, two reads. A line already there would mean something else wrote it.
 *  3. **the turn really was interrupted** — the app's own interrupt row in the
 *     transcript, and a message that really was queued rather than sent.
 *
 * ## The receipt's CONTENT, which the host now records (F1.767)
 *
 * This section used to say the receipt could not be observed: the host threw
 * the promise away. Since D1.361 it READS it and writes one more line to the
 * host's note file, `Claude turn interrupt receipt (<reason>): still_queued=[…]`
 * (SIT-b, packaged `5896a66d2`: `still_queued=[]` on both arms). So the last
 * check reads that line and asks the row's own question — the receipt is
 * recorded, and `still_queued` names nothing (a non-empty list means Stop lied).
 * A receipt answered `none` (a child on the older empty success) records no
 * content and does not pass it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import { clickSelector } from '../lib/viewport.ts'
import type { CdpSession } from '../lib/connect.ts'
import {
  SEND_BUTTON,
  readSubmitControl,
  restoreMidStreamBehavior,
  setMidStreamBehavior,
  submitWithoutWaiting,
  waitForFirstTool,
  waitUntilProcessing,
  waitUntilSettled,
} from '../lib/mid-stream.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, isProcessing, transcript } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-81'
const TITLE = 'claude\'s interrupt receipt at the seam — what the child advertises and what the host does with it'

/** The host's own seam line, `ClaudeAgent`'s interrupt path. */
const SEAM = 'Claude turn interrupt ('
const ADVERTISES = 'advertises interrupt_receipt_v1'
const NOT_ADVERTISES = 'does NOT advertise interrupt_receipt_v1'
/** The receipt's own field, and the fix the row names. */
const STILL_QUEUED = 'still_queued'
const CANCEL_QUEUED = 'cancel_queued'
/**
 * F1.767 — the host's receipt lines, written by `noteInterruptSeam` after
 * `live.interrupt()` answers (D1.361). Neither contains {@link SEAM}, so the
 * seam counts and the before-Stop control are unchanged by them.
 */
const RECEIPT = 'Claude turn interrupt receipt ('
const RECEIPT_FAILED = 'Claude turn interrupt failed:'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.81',
  runtimes: ['claude'],
  credentials:
    'owner: a claude-runtime card. No key is read and no credential file is touched; the app must be in debug '
    + 'mode (NESSY_DEBUG=1) or the per-session diagnostic this case reads is never written.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher AND NESSY_DEBUG=1.',
    '2. A session on the claude card; seed one turn so a child exists.',
    '3. Start a LONG tool-shaped turn and wait until the app itself reports it in flight and a tool has started.',
    '4. Type a second message while it runs so it is QUEUED. Read the composer control and `isProcessing` in that '
    + 'instant — that pair alone is D1.376\'s verdict — then press the composer\'s Stop.',
    '5. Read BOTH `<config>/logs/runtime/<that session id>-claude.txt` (the child\'s) and `<…>-claude-host.txt` '
    + '(the host\'s note file, where `appendSessionRuntimeHostNote` puts the seam on a packaged build), before and '
    + 'after.',
    '6. Repeat the whole arm with NOTHING queued — that pair is the case\'s control.',
  ],
  expected:
    'The seam line appears once, naming whether this child advertised `interrupt_receipt_v1` and listing the '
    + 'capabilities it did advertise, and the host\'s note file then records the receipt, '
    + '`Claude turn interrupt receipt (user_stop): still_queued=[]` — an EMPTY list.',
  detector:
    'the per-session diagnostic, BOTH files — `<config>/logs/runtime/<id>-claude.txt` (the child\'s) and '
    + '`<id>-claude-host.txt` (the host\'s note file) — read before and after the Stop; never the transcript, which '
    + 'carries the user-visible interrupt row and nothing about the receipt. D1.376 has its own detector on the '
    + 'same drive: the composer control plus `isProcessing`, read once in the instant after the queued submit.',
  positiveControl:
    'arm B — the SAME Stop, in the same session shape and the same connection setting, with NOTHING queued behind '
    + 'the turn. It is what separates "Stop does not work when a message is queued" from "the click never landed". '
    + 'Each arm additionally reads its own diagnostic before and after, so a seam count of zero is a host that '
    + 'wrote nothing rather than a file nobody found: the file is keyed by the session id, never "the richest one '
    + 'in the directory", which is what made the first drive report a PREVIOUS session\'s 266 lines twice.',
  doneMeans:
    'D1.81 records whether the shipped child advertises the receipt on this card, that the host asks for it and '
    + 'records it (D1.361), and that `cancel_queued: true` — the row\'s stated fix — is sent nowhere in the bundle. D1.376 '
    + 'records its own PASS/FAIL from the same drive: on a build carrying `b1a840678` the composer still offers '
    + 'Stop and the host still reports `isProcessing` after the queued submit. And the receipt itself: recorded, '
    + 'with `still_queued` empty (F1.767).',
  doNotConflate:
    'A receipt that was never RECORDED is not an empty receipt: the check needs a parsed `still_queued=[…]` '
    + 'line, and a `none` answer or no line at all fails it rather than reading as "nothing survived".',
} as const satisfies SittingRecipe

export interface DiagnosticFile {
  file: string | undefined
  lines: number
  seam: number
  advertises: number
  notAdvertises: number
  stillQueued: number
  cancelQueued: number
  seamLines: string[]
  /** F1.767 — the host's receipt (and receipt-failure) lines, in file order. */
  receiptLines: string[]
}

export interface DiagnosticRead extends DiagnosticFile {
  /** The CHILD's file, `<id>-claude.txt`, on its own. */
  child: DiagnosticFile
  /** The HOST's note file, `<id>-claude-host.txt`, on its own. */
  host: DiagnosticFile
}

const EMPTY_FILE: DiagnosticFile = {
  file: undefined, lines: 0, seam: 0, advertises: 0, notAdvertises: 0, stillQueued: 0, cancelQueued: 0, seamLines: [],
  receiptLines: [],
}

/** One file's counts, or {@link EMPTY_FILE} when it is absent or unreadable. */
function readDiagnosticFile(dir: string, sessionId: string, suffix: string): DiagnosticFile {
  if (!existsSync(dir)) return EMPTY_FILE
  let best = EMPTY_FILE
  for (const name of readdirSync(dir)) {
    // `latest` is a SYMLINK the vendored binary writes beside the file the host
    // named (measured by sitting 5c); reading it as well would double-count the
    // last session, so only real per-session names are read.
    if (!name.endsWith(suffix) || name.startsWith('latest')) continue
    if (!name.startsWith(sessionId)) continue
    const file = join(dir, name)
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const lines = text.split('\n').filter(Boolean)
    const read: DiagnosticFile = {
      file,
      lines: lines.length,
      seam: text.split(SEAM).length - 1,
      advertises: text.split(ADVERTISES).length - 1,
      notAdvertises: text.split(NOT_ADVERTISES).length - 1,
      stillQueued: text.split(STILL_QUEUED).length - 1,
      cancelQueued: text.split(CANCEL_QUEUED).length - 1,
      seamLines: lines.filter(line => line.includes(SEAM)).map(line => line.slice(0, 300)),
      receiptLines: lines.filter(line => line.includes(RECEIPT) || line.includes(RECEIPT_FAILED)).map(line => line.slice(0, 300)),
    }
    // Keep the file with the most seam lines, then the most lines: a session
    // that never interrupted would otherwise win on length alone.
    if (read.seam > best.seam || (read.seam === best.seam && read.lines > best.lines)) best = read
  }
  return best
}

/**
 * THIS SESSION's diagnostic — BOTH files, keyed by its session id.
 *
 * Not "the richest file in the directory", which is what the first drive used
 * and what made it answer 266 lines of a PREVIOUS session's log twice — an
 * identical before/after that read exactly like a host that wrote nothing. The
 * host names the file after the session, so the session id is the key, and a
 * file that does not exist is reported as absent rather than substituted for.
 *
 * **THERE ARE TWO FILES, and this reader saw only one of them until D1.381**
 * (`scripts/cdp/cases/rs-81.ts`, the `endsWith('-claude.txt')` filter). The seam
 * line goes through `ClaudeAgent`'s `noteInterruptSeam`, whose whole body is two
 * calls:
 *
 *     this.debug(note);
 *     appendSessionRuntimeHostNote('claude', this.config.session?.id, note, isDebugEnabled());
 *
 * The first lands in the host's own debug channel, which a PACKAGED build does
 * not write — which is why this case's own clause about the seam reads
 * UNAVAILABLE on the artefact rather than negative. The second writes
 * `<id>-claude-host.txt`, and `sessionRuntimeHostNotePath`'s own docblock says
 * why the tail is there: *"The `-host` tail is what keeps it off
 * `<id>-<runtime>.txt`, which on claude belongs to the child."* So the host's
 * file is precisely the surface that CAN carry the seam on a packaged build, and
 * `'x-claude-host.txt'.endsWith('-claude.txt')` is `false` — the one reader that
 * needed it was the one filtering it out.
 *
 * The union is what the checks read; the two halves are kept separately so an
 * observation can say WHICH file carried the line, which is the difference
 * between "the host wrote nothing" and "the host wrote it where this reader was
 * not looking" — the same distinction the first drive got wrong, one file over.
 */
export function diagnostic(root: string, sessionId: string): DiagnosticRead {
  const dir = join(root, 'logs', 'runtime')
  const child = readDiagnosticFile(dir, sessionId, '-claude.txt')
  const host = readDiagnosticFile(dir, sessionId, '-claude-host.txt')
  return {
    child,
    host,
    file: child.file ?? host.file,
    lines: child.lines + host.lines,
    seam: child.seam + host.seam,
    advertises: child.advertises + host.advertises,
    notAdvertises: child.notAdvertises + host.notAdvertises,
    stillQueued: child.stillQueued + host.stillQueued,
    cancelQueued: child.cancelQueued + host.cancelQueued,
    seamLines: [...child.seamLines, ...host.seamLines],
    receiptLines: [...child.receiptLines, ...host.receiptLines],
  }
}

/** What the recorded receipt lines say — F1.767's reader for the row's own question. */
export interface InterruptReceiptReading {
  /** Receipt lines that carry a `still_queued=[…]` list, which is what the row asks about. */
  parsed: number
  /** Every id any parsed receipt named as still queued; empty is the PASS. */
  stillQueued: string[]
  /** `none` answers — a child on the older empty success, so no content was recorded. */
  noContent: number
  /** `Claude turn interrupt failed: …` lines — the interrupt request itself threw. */
  failed: number
}

/** Parse the host's receipt lines (see {@link RECEIPT}); a line in no known shape counts nowhere. */
export function readInterruptReceipts(lines: readonly string[]): InterruptReceiptReading {
  const reading: InterruptReceiptReading = { parsed: 0, stillQueued: [], noContent: 0, failed: 0 }
  for (const line of lines) {
    if (line.includes(RECEIPT_FAILED)) { reading.failed += 1; continue }
    if (!line.includes(RECEIPT)) continue
    const list = /still_queued=\[([^\]]*)\]/.exec(line)
    if (list) {
      reading.parsed += 1
      reading.stillQueued.push(...list[1]!.split(',').map(id => id.trim()).filter(Boolean))
    } else if (/\): none\b/.test(line)) {
      reading.noContent += 1
    }
  }
  return reading
}

/** The row's verdict: the receipt was recorded with a list, and the list names nothing still queued. */
export function receiptSaysNothingSurvived(reading: InterruptReceiptReading): boolean {
  return reading.parsed > 0 && reading.stillQueued.length === 0
}

/**
 * D1.376's one-read detector, taken AFTER the queued message was submitted.
 *
 * The composer's primary control is `stop` while a turn runs and the composer is
 * EMPTY — which is exactly the state a queued submit leaves it in. So one read
 * of that control plus one read of the host's own `isProcessing` answers, in a
 * single instant, whether the app still believes a turn is in flight after a
 * follow-up was queued behind it.
 *
 * **D1.376 is CLOSED (`b1a840678`) with its premise corrected**, and the
 * correction is what makes this cheap: the cause was the renderer's
 * `handleUserMessage` lowering `isProcessing` on a `queued` follow-up, not
 * `cancelProcessing`'s ordering. So on a FIXED build the expected reading is
 * `type: 'button'` (Stop) with `isProcessing: true`, and the regression's
 * signature is the control flipping to a `submit` send with `isProcessing`
 * dropping — one event, no waiting, no second turn.
 *
 * It is a SEPARATE arm with its own PASS/FAIL rather than a clause folded into
 * the interrupt check, because the two can disagree: a build can lower
 * `isProcessing` in the renderer and still interrupt correctly at the host, and
 * reporting one verdict for both would hide whichever half was right.
 */
interface QueuedSubmitReading {
  /** `button` while the turn runs; a `submit` here is the D1.376 regression. */
  controlType: string | undefined
  controlLabel: string | undefined
  /** The HOST's own view, off `getSessions()` — the renderer cannot fake it. */
  hostIsProcessing: boolean
  /** PASS when both halves still say a turn is in flight. */
  ok: boolean
}

interface ArmReading {
  label: string
  sessionId: string
  toolsBeforeStop: string[]
  queuedControl?: { type: string | undefined; label: string }
  /** D1.376's detector; present on the queued arm only, which is the only arm that can take it. */
  afterQueuedSubmit?: QueuedSubmitReading
  stopControl: unknown
  settledMs: number
  timedOut: boolean
  interruptRows: number
  interruptText: string[]
  toolsAfterStop: number
  before: DiagnosticRead
  after: DiagnosticRead
}

/**
 * One interrupt, driven end to end in a session of its own.
 *
 * `withQueued` is the only difference between the two arms: everything else —
 * the card, the connection's `queue` setting, the prompt, the wait for a real
 * tool call, the click — is identical, which is what makes the pair a
 * discrimination rather than two anecdotes.
 */
async function interruptArm(
  run: CaseRun,
  session: CdpSession,
  root: string,
  slug: string,
  label: string,
  withQueued: boolean,
): Promise<ArmReading> {
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  run.check(`[${label}] ran in a session it created`, key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages}`)
  const bind = await switchRuntime(session, key.sessionId, slug)
  run.check(`[${label}] bound to ${slug}`, bind.ok, bind.ok ? undefined : bind.error)
  await sendPrompt(session, key, 'Reply with the single word ready. Do not use any tool.', 300_000)

  const before = diagnostic(root, key.sessionId)
  run.require(
    `[${label}] THE CONTROL — this session's own diagnostic is readable`,
    before.file !== undefined && before.lines > 0,
    `no readable \`${key.sessionId}-claude.txt\` under ${join(root, 'logs', 'runtime')}. It is written only while `
    + 'the host is in debug mode; without it the seam count below is an unread file rather than a silent host',
  )
  run.require(
    `[${label}] THE CONTROL — the seam line is ABSENT before the Stop`,
    before.seam === 0,
    `this session's diagnostic already carries ${before.seam} \`${SEAM}\` line(s) before anything was interrupted`,
  )

  // F1.562 — the task turn's rows are the ones after this count: a warm-up turn precedes it.
  const beforeTask = (await transcript(session, key)).length
  await submitWithoutWaiting(
    session,
    'Using your shell tool, run these one at a time and report each result: `sleep 20 && echo STEP-1`, then '
    + '`sleep 20 && echo STEP-2`, then `sleep 20 && echo STEP-3`. Do not skip any.',
  )
  await waitUntilProcessing(session, key, 90_000)
  const firstTool = await waitForFirstTool(session, key, 180_000)
  run.require(
    `[${label}] THE CONTROL — a tool was running when Stop was pressed`,
    firstTool.names.length > 0,
    'no tool call started, so the turn was about to end anyway and the interrupt measures nothing',
  )
  const toolsBeforeStop = (await transcript(session, key)).slice(beforeTask).filter(message => message.role === 'tool').length

  let queuedControl: { type: string | undefined; label: string } | undefined
  let afterQueuedSubmit: QueuedSubmitReading | undefined
  if (withQueued) {
    const queuedText = `CDP ${ID} queued message — this one must survive or be cancelled.`
    await submitWithoutWaiting(session, queuedText, async () => {
      const read = await readSubmitControl(session)
      queuedControl = { type: read.type, label: read.label ?? '' }
    })
    run.require(
      `[${label}] THE CONTROL — the second message was QUEUED, not steered into the turn`,
      queuedControl?.label === 'Queue',
      `the composer offered ${JSON.stringify(queuedControl)} with text in it while a turn ran. A STEERED message `
      + 'is folded into the running turn, so it is not one the receipt could list as surviving',
    )

    // D1.376's detector — its OWN arm, read in the instant after the queued
    // submit and before anything else touches the session. The composer is empty
    // again here, so the control reads `stop` on a build that still believes the
    // turn is running, and the host's `isProcessing` is the half the renderer
    // cannot fake. See {@link QueuedSubmitReading}.
    const control = await readSubmitControl(session)
    const hostIsProcessing = await isProcessing(session, key)
    afterQueuedSubmit = {
      controlType: control.type,
      controlLabel: control.label,
      hostIsProcessing,
      ok: control.type === 'button' && hostIsProcessing,
    }
    run.observe(`[${label}] D1.376 — the composer control after the queued submit`, afterQueuedSubmit)
  }

  const stopControl = await readSubmitControl(session)
  const startedAt = Date.now()
  await clickSelector(session, SEND_BUTTON)
  const settled = await waitUntilSettled(session, key, { quietMs: 8_000, timeoutMs: 240_000 })
  const rows = (await transcript(session, key)).slice(beforeTask)
  const interruptText = rows
    .filter(message => message.role === 'info' && /interrupt|stopped/i.test(message.content))
    .map(message => message.content.slice(0, 160))
  const reading: ArmReading = {
    label,
    sessionId: key.sessionId,
    toolsBeforeStop: firstTool.names,
    ...(queuedControl ? { queuedControl } : {}),
    ...(afterQueuedSubmit ? { afterQueuedSubmit } : {}),
    stopControl,
    settledMs: Date.now() - startedAt,
    timedOut: settled.timedOut,
    interruptRows: interruptText.length,
    interruptText,
    toolsAfterStop: rows.filter(message => message.role === 'tool').length - toolsBeforeStop,
    before,
    after: diagnostic(root, key.sessionId),
  }
  run.observe(`[${label}] the interrupt`, {
    ...reading,
    before: { lines: before.lines, seam: before.seam },
    after: { lines: reading.after.lines, seam: reading.after.seam, stillQueued: reading.after.stillQueued },
  })
  return reading
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = configDir()

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the interrupt a claude child receives')
  if (contaminated !== undefined) blocked(contaminated)

  const card = (await listConnections(session)).find(row => runtimeOf(row.providerType) === 'anthropic')
  if (!card) {
    blocked('this profile lists no claude-runtime card, and the row is about claude\'s interrupt receipt')
  }

  // The second message has to be QUEUED, not STEERED. Measured on this card's
  // first drive: with the connection's own `midStreamBehavior` left as it was,
  // the composer offered `Steer` and the message was folded into the running
  // turn — a steered message is delivered, so it is not one the receipt could
  // ever list as surviving. `setMidStreamBehavior` is the app's own save route
  // (the one `AiSettingsPage` calls), and the operator's value goes back in the
  // `finally`.
  const midStream = await setMidStreamBehavior(session, card.slug, 'queue')
  run.observe('the connection\'s mid-stream behaviour for this arm', midStream)
  run.require(
    'THE CONTROL — the card is set to QUEUE for this arm',
    midStream.ok,
    `setMidStreamBehavior(queue) answered ${JSON.stringify(midStream)}. A STEERED message is folded into the `
    + 'running turn, so it could never be one the interrupt receipt lists as surviving, and the arm would measure '
    + 'the wrong delivery',
  )
  try {
    // TWO ARMS, and the second is what makes the first a finding. Arm A presses
    // Stop with a message QUEUED behind the running turn; arm B presses the same
    // Stop, in the same session shape and with the same connection setting, with
    // NOTHING queued. If Stop lands in B and not in A, the queued message is
    // what defeats it, which is D1.81's question in its strongest form.
    const armA = await interruptArm(run, session, root, card.slug, 'queued', true)
    const armB = await interruptArm(run, session, root, card.slug, 'nothing-queued', false)

    run.observe('D1.81 — the two arms side by side', { withQueuedMessage: armA, withNothingQueued: armB })
    run.require(
      'THE CONTROL — Stop works at all on this card, with nothing queued behind it',
      armB.interruptRows > 0 || armB.settledMs < 60_000,
      `arm B pressed the same Stop with an empty queue and the turn ${armB.interruptRows > 0 ? 'was' : 'was NOT'} `
      + `marked interrupted after ${armB.settledMs} ms. Without this arm, "Stop did not stop it" in arm A is `
      + 'equally true of a click that never landed',
    )
    run.check(
      'D1.81 — Stop interrupts the running turn when a message is QUEUED behind it',
      armA.interruptRows > 0,
      `arm A: ${armA.interruptRows} interrupt row(s), settled after ${armA.settledMs} ms, tool calls after the `
      + `Stop: ${armA.toolsAfterStop}; arm B (nothing queued): ${armB.interruptRows} row(s), ${armB.settledMs} ms, `
      + `${armB.toolsAfterStop} tool call(s) after. A turn that runs to completion under Stop is the row's `
      + '"Stop lied" in its strongest form — not a receipt naming a survivor, but the turn itself surviving',
    )
    run.check(
      'D1.81 — the host\'s seam line reaches a readable surface on a packaged build',
      armA.after.seam > 0 || armB.after.seam > 0,
      `neither arm produced a \`${SEAM}\` line in either per-session file (arm A: child ${armA.after.child.seam} `
      + `over ${armA.after.child.lines} lines, host-note ${armA.after.host.seam} over ${armA.after.host.lines}; `
      + `arm B: child ${armB.after.child.seam}/${armB.after.child.lines}, host-note ${armB.after.host.seam}/`
      + `${armB.after.host.lines}). \`noteInterruptSeam\` writes BOTH — \`this.debug(...)\`, which a packaged build `
      + 'does not write, and `appendSessionRuntimeHostNote`, which does — so a zero in both is a host that wrote '
      + 'nothing and not a reader that looked in one place',
    )
    // WHICH file carried it, recorded whether or not the check passed. Until
    // D1.381 this reader could not see the host's file at all, so a seam line
    // landing only there read as an absence — the observation is what stops the
    // next reader re-deriving that.
    run.observe('D1.81 — which file carried the seam line', {
      armA: { childFile: armA.after.child.file, childSeam: armA.after.child.seam, hostFile: armA.after.host.file, hostSeam: armA.after.host.seam },
      armB: { childFile: armB.after.child.file, childSeam: armB.after.child.seam, hostFile: armB.after.host.file, hostSeam: armB.after.host.seam },
    })

    // D1.376 — its OWN check with its OWN verdict, never folded into the
    // interrupt one above: a build can lower `isProcessing` in the renderer and
    // still interrupt correctly at the host, and one verdict for both would hide
    // whichever half was right. The expected reading on a FIXED build (D1.376 is
    // closed at `b1a840678`, premise corrected to `handleUserMessage` lowering
    // `isProcessing` on a `queued` follow-up) is Stop still offered with the
    // host still processing.
    const queuedSubmit = armA.afterQueuedSubmit
    run.check(
      'D1.376 — after a message is QUEUED behind a running turn, the app still says the turn is in flight',
      queuedSubmit?.ok === true,
      queuedSubmit === undefined
        ? 'arm A recorded no reading at all, so the detector did not run — the queued submit never happened'
        : `the composer offered ${JSON.stringify(queuedSubmit.controlType)} (${JSON.stringify(queuedSubmit.controlLabel)}) `
          + `and the host reported isProcessing=${queuedSubmit.hostIsProcessing} in the instant after the queued `
          + 'submit. A `submit` control or a false `isProcessing` here is D1.376 back: the renderer has lowered the '
          + 'turn on a follow-up it only QUEUED, so the next Stop has nothing to stop',
    )
    // F1.767 — the row's own question, read where the host now answers it. This
    // check used to require that NOTHING recorded the receipt (`still_queued` and
    // `cancel_queued` both 0), which stopped being true at D1.361: the host writes
    // the receipt line, and the seam line's capability list spells
    // `interrupt_cancel_queued_v1`, so it FAILED on a build that answers the row.
    const receiptA = readInterruptReceipts(armA.after.receiptLines)
    const receiptB = readInterruptReceipts(armB.after.receiptLines)
    run.observe('D1.81 — the recorded interrupt receipts', {
      armA: { ...receiptA, lines: armA.after.receiptLines },
      armB: { ...receiptB, lines: armB.after.receiptLines },
    })
    run.check(
      'D1.81 — the host records the interrupt receipt, and `still_queued` names nothing (arm A, a message queued)',
      receiptSaysNothingSurvived(receiptA),
      receiptA.parsed === 0
        ? `arm A recorded no \`${STILL_QUEUED}=[…]\` receipt (${receiptA.noContent} \`none\` answer(s), `
          + `${receiptA.failed} failed interrupt(s), ${armA.after.receiptLines.length} receipt line(s) over both files). `
          + 'An unrecorded receipt is not an empty one'
        : `arm A's receipt names ${receiptA.stillQueued.length} message(s) still queued at the child: `
          + `${receiptA.stillQueued.join(', ')} — the row's "Stop lied"`,
    )
    run.observe('D1.81 — what stays unsent on this build', {
      note:
        'the row\'s stated fix — sending `cancel_queued: true` — is declined on purpose (`claude-agent.ts`) while '
        + 'the vendored child advertises `interrupt_cancel_queued_v1`, so the capability is there and unused. '
        + `Arm B's receipt, for comparison: ${JSON.stringify(receiptB)}.`,
    })
  } finally {
    await restoreMidStreamBehavior(session, card.slug, midStream.previous).catch(() => undefined)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
