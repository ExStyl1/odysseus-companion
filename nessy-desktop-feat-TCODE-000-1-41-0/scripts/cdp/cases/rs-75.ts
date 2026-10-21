/**
 * RS-75 (D1.56) — when one command in a parallel tool batch exits non-zero, does
 * its SIBLING still run and return?
 *
 * ## The row
 *
 * D1.56 is *"whether one failing command in a parallel tool batch cancels its
 * siblings, on any of the three runtimes"*, carried from P6.356. Its rig is
 * *"one turn issuing two Bash calls in one batch, the first exiting non-zero, on
 * each runtime; control = the same batch with both succeeding"*, and its
 * `done_means` is *"the recorded reading says whether the SECOND `tool_result`
 * arrives on each runtime, and any difference is written as a switch verdict."*
 *
 * ## The detector is a marker the SIBLING itself prints
 *
 * The second command is `echo SIBLING-OK`, and the reading is whether that
 * string appears in a tool RESULT in the turn's own added messages. Not whether
 * a second tool call was ISSUED — a call that was issued and then cancelled
 * leaves a row too — and not the model's prose about what it ran, which is the
 * weakest source in this harness. A string only that command can produce, in a
 * result the app itself recorded, is the strongest one available without a
 * loopback capture.
 *
 * The first command is `echo FIRST-RAN && exit 7`: it prints its own marker and
 * then exits non-zero, so a run can tell *the batch never happened* from *the
 * first command failed as asked*.
 *
 * ## The control is the same batch with both succeeding
 *
 * The row names it, and it is not optional: models decline to batch, decline to
 * run a command that looks pointless, and sometimes answer from prose alone. An
 * arm where `SIBLING-OK` is absent is only readable beside an arm on the same
 * runtime, in the same session-less-than-a-minute window, where it is present.
 * Without that, *"the failure cancelled the sibling"* and *"this model does not
 * run echo commands"* are the same reading.
 *
 * ## What this case CANNOT force, and says so per arm
 *
 * It cannot make a model emit two tool calls in ONE message. The prompt asks
 * for a single parallel batch and the case records what actually arrived — the
 * number of tool calls and their statuses — so a reader can see whether the
 * batch it is reasoning about existed. An arm with one tool call is reported as
 * `not-batched` and is NOT scored as a cancellation, which is the failure mode
 * this row would otherwise walk into.
 *
 * ## The permission card, which is a precondition and not the subject
 *
 * Sitting 4 measured that a Bash spelling on a Pi card can raise a card and sit
 * unanswered until the turn's ceiling, presenting as a silent hang. An approver
 * runs underneath every arm for that reason; the count it answered is recorded,
 * so an arm that needed one is visible rather than invisible.
 *
 * ## What it creates
 *
 * One session per runtime family the profile has a card for, inside
 * `NESSY_CONFIG_DIR`. It writes no file, installs nothing and edits no
 * connection; both commands are `echo`.
 */

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, transcript, type SessionKey, type TranscriptMessage } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe, SittingRuntime } from '../lib/sitting.ts'

const ID = 'RS-75'
const TITLE = 'a failing command in a parallel tool batch, and whether its sibling still returns'

/** The sibling's own marker — the only thing that can put this string in a result. */
const SIBLING = 'SIBLING-OK'

/** The first command's marker, so "never ran" and "ran and failed" are different. */
const FIRST = 'FIRST-RAN'

const SUBJECT_PROMPT =
  `Run these two shell commands as a single parallel batch of two tool calls in one message: `
  + `(1) echo ${FIRST} && exit 7   and   (2) echo ${SIBLING}. `
  + 'Run nothing else and do not retry either one. Then reply with the word done.'

const CONTROL_PROMPT =
  `Run these two shell commands as a single parallel batch of two tool calls in one message: `
  + `(1) echo ${FIRST}   and   (2) echo ${SIBLING}. `
  + 'Run nothing else and do not retry either one. Then reply with the word done.'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.56',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: the gateway cards for the families to be measured. Both commands are `echo`; nothing is written and '
    + 'no key is read.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher in scripts/cdp/README.md.',
    '2. Per runtime family: a fresh session bound to that family\'s card.',
    '3. The SUBJECT turn — two shell commands asked for as one parallel batch, the first exiting non-zero.',
    '4. The CONTROL turn in the same session — the same two commands with the first succeeding.',
    '5. Read whether the sibling\'s own marker appears in a tool RESULT in each turn\'s added messages.',
    '6. Keep a permission approver running underneath: an unanswered card presents as a silent hang, not an error.',
  ],
  expected:
    'The sibling\'s marker present in both arms means a failing call does not cancel its batch. Present only in '
    + 'the control means it does. Absent in both means the runtime did not run the commands at all, which is not '
    + 'a cancellation.',
  detector:
    'the string `SIBLING-OK` in a tool RESULT among the turn\'s added transcript messages — a marker only the '
    + 'second command can produce, in a record the app itself writes. Never the presence of a second tool CALL (a '
    + 'cancelled call leaves a row too) and never the model\'s prose about what it ran.',
  positiveControl:
    'the same two commands with the first succeeding, on the same runtime in the same session. An absent marker '
    + 'is only readable beside an arm where it is present; otherwise "the failure cancelled the sibling" and '
    + '"this model does not run echo commands" are one reading.',
  doneMeans:
    'D1.56 carries a per-runtime verdict on whether the second tool result arrives, with the control recorded, '
    + 'and any difference between the three written as a switch verdict.',
  doNotConflate:
    'An arm that produced ONE tool call was not a batch. It is reported as `not-batched` and must never be scored '
    + 'as a cancellation — the case cannot force a model to emit two calls in one message.',
} as const satisfies SittingRecipe

interface ToolRow {
  readonly tool: string
  readonly status?: string
  readonly resultLength: number
  readonly hasSibling: boolean
  readonly hasFirst: boolean
}

interface ArmReading {
  readonly runtime: SittingRuntime
  readonly arm: 'subject' | 'control'
  readonly toolCalls: ToolRow[]
  readonly siblingReturned: boolean
  readonly firstRan: boolean
  readonly approvals: number
  readonly assistantTail: string
}

/** One turn, classified from the tool RESULTS only. */
async function probe(
  session: CdpSession,
  key: SessionKey,
  runtime: SittingRuntime,
  arm: 'subject' | 'control',
  prompt: string,
): Promise<ArmReading> {
  const before = (await transcript(session, key)).length
  const approver = approvePermissionsWhile(session, key.sessionId)
  await sendPrompt(session, key, prompt, 300_000).catch(() => undefined)
  const approvals = await approver.stop()
  const added: TranscriptMessage[] = (await transcript(session, key)).slice(before)
  const toolCalls = added
    .filter(message => typeof message.toolName === 'string' && message.toolName.length > 0)
    .map(message => {
      const result = message.toolResult ?? ''
      return {
        tool: message.toolName ?? '',
        status: message.toolStatus,
        resultLength: result.length,
        hasSibling: result.includes(SIBLING),
        hasFirst: result.includes(FIRST),
      }
    })
  const assistant = added.filter(message => message.role === 'assistant').map(message => message.content).join(' ')
  return {
    runtime,
    arm,
    toolCalls,
    siblingReturned: toolCalls.some(call => call.hasSibling),
    firstRan: toolCalls.some(call => call.hasFirst),
    approvals,
    assistantTail: assistant.replace(/\s+/g, ' ').trim().slice(-120),
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the tool batch this case drives')
  if (contaminated !== undefined) blocked(contaminated)

  const cards = await listConnections(session)
  const families: ReadonlyArray<{ runtime: SittingRuntime; provider: string }> = [
    { runtime: 'pi', provider: 'pi' },
    { runtime: 'claude', provider: 'anthropic' },
    { runtime: 'codex', provider: 'codex-runtime' },
  ]
  const picked = families
    .map(entry => ({ ...entry, card: cards.find(row => runtimeOf(row.providerType) === entry.provider) }))
    .filter((entry): entry is typeof entry & { card: NonNullable<typeof entry.card> } => entry.card !== undefined)
  run.observe('cards', { listed: cards.map(row => `${row.slug}:${row.providerType}`), driving: picked.map(entry => entry.runtime) })
  if (picked.length === 0) blocked('this profile lists no card for any runtime family, so no turn can be driven at all')

  const readings: ArmReading[] = []
  for (const entry of picked) {
    const key = await freshSession(session, `CDP ${ID} ${entry.runtime} ${new Date().toISOString().slice(11, 19)}`)
    run.check(`the ${entry.runtime} arm ran in a session it created`, key.fresh, key.fresh ? undefined : key.reason)
    const bind = await switchRuntime(session, key.sessionId, entry.card.slug)
    run.check(`the ${entry.runtime} arm is bound to ${entry.card.slug}`, bind.ok, bind.ok ? undefined : `switchRuntime refused: ${bind.error}`)

    const subject = await probe(session, key, entry.runtime, 'subject', SUBJECT_PROMPT)
    readings.push(subject)
    run.observe(`${entry.runtime} — SUBJECT (first command exits 7)`, subject)

    const control = await probe(session, key, entry.runtime, 'control', CONTROL_PROMPT)
    readings.push(control)
    run.observe(`${entry.runtime} — CONTROL (both succeed)`, control)
  }

  for (const entry of picked) {
    const subject = readings.find(r => r.runtime === entry.runtime && r.arm === 'subject')
    const control = readings.find(r => r.runtime === entry.runtime && r.arm === 'control')
    if (!subject || !control) continue

    run.require(
      `THE CONTROL (${entry.runtime}) — with both commands succeeding, the sibling's marker DOES come back`,
      control.siblingReturned,
      `the control turn produced ${control.toolCalls.length} tool call(s) and no result carrying ${SIBLING}. `
      + `Statuses: ${JSON.stringify(control.toolCalls.map(c => c.status ?? 'none'))}; the model's own tail was `
      + `${JSON.stringify(control.assistantTail)}. With the control dead, the subject arm below says nothing`,
    )

    const batched = subject.toolCalls.length >= 2
    run.observe(`${entry.runtime} — was the SUBJECT turn a batch at all`, {
      toolCalls: subject.toolCalls.length,
      verdict: batched ? 'batched' : 'not-batched',
      note: batched
        ? 'two or more tool calls in the turn, so the row\'s question has a subject here'
        : 'ONE tool call: this runtime did not issue a batch for this prompt, so an absent sibling marker is not '
          + 'a cancellation and is deliberately not scored as one',
    })

    if (!batched) continue
    run.check(
      `${entry.runtime.toUpperCase()} — a non-zero sibling does NOT cancel the rest of the batch`,
      subject.siblingReturned,
      `the first command's marker ${subject.firstRan ? 'IS' : 'is NOT'} in the results, and ${SIBLING} is not — `
      + `over ${subject.toolCalls.length} tool call(s) with statuses `
      + `${JSON.stringify(subject.toolCalls.map(c => c.status ?? 'none'))}, while the control arm on this same `
      + 'runtime and session did return it. That is the cancellation D1.56 asks about',
    )
  }

  run.observe('verdict', readings.map(r => ({
    runtime: r.runtime,
    arm: r.arm,
    toolCalls: r.toolCalls.length,
    statuses: r.toolCalls.map(c => c.status ?? 'none'),
    firstRan: r.firstRan,
    siblingReturned: r.siblingReturned,
    approvalsAnswered: r.approvals,
  })))
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
