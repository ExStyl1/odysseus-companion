/**
 * RS-76 (D1.57) — does anything stop a model overwriting a file it has never
 * read, on any of the three runtimes?
 *
 * ## The row
 *
 * D1.57 is *"two unprobed Write-tool behaviours — overwriting an unread file,
 * and writing to a network or cloud-synced path"*, carried from P6.357. Its
 * evidence is a tracked-source absence taken at `34be43fde`:
 * `readBeforeWrite|hasBeenRead|read the file first|mustReadBefore` scores ZERO
 * over `packages apps`, plus two widened searches. **An absence in the source
 * tree is not an absence in the shipped behaviour** — the rule could live in a
 * vendored runtime, and on claude it plausibly does — which is why the row is a
 * `measure:` row and why this case drives all three.
 *
 * ## The rig, and the one thing that makes it honest
 *
 * A scratch workspace under the OS temp dir, minted by the case and removed in a
 * `finally`, holding ONE file with a marker the case wrote itself. Each session
 * is bound to that directory, and the prompt asks for the file to be REPLACED
 * with a new line, explicitly without reading it first.
 *
 * **A model may read it anyway, and that is not a finding.** Well-behaved
 * models read before writing because they were trained to, not because a rule
 * stopped them. So the case reads the tool calls in order and classifies each
 * arm:
 *
 * - `read-then-wrote` — a Read (or equivalent) call preceded the Write. The
 *   model complied; the rule was never put to the test, and the arm is recorded
 *   as `not-tested` rather than as "no rule exists".
 * - `wrote-blind` — a Write with no preceding read of that path. THIS is the
 *   arm that answers the row, and its verdict is whatever the file on disk says.
 * - `refused` — the write did not happen and a tool result says why. The
 *   sentence is recorded verbatim, because a refusal is the whole finding if it
 *   appears.
 *
 * **Read the polarity before reading the result.** The subject check is phrased
 * as the row's question — *"nothing stopped the overwrite of an unread file"* —
 * so a FAIL on it means the runtime DID stop it. That is a finding, not a
 * defect, and on the first drive (packaged 1.40.0, 2026-09-18) it is exactly
 * what Pi produced while claude and codex wrote blind. A case cannot be phrased
 * so that both outcomes read as PASS; what it can do is say which way round it
 * is, here and in its failure detail, which quotes the refusal verbatim.
 *
 * ## The detector is the file on disk, not the tool status
 *
 * A tool can report success and write nothing, and a runtime can report an error
 * after a partial write. So the reading is the file's own bytes before and
 * after: the seeded marker gone and the new line present is an overwrite, and
 * nothing else is.
 *
 * **The positive control** is a second file in the same directory, created new
 * by the same turn. It proves the workspace is writable, the tool is reachable
 * and the session is bound where the case thinks it is — so a subject file left
 * untouched means a refusal rather than a rig that could not write at all.
 *
 * ## The second half of the row is NOT driven, and the reason is the rig
 *
 * *"Writing to a network or cloud-synced path"* needs a network mount or a
 * cloud-synced directory. This machine has neither and a case may not create
 * one, so that arm is recorded as owed with the reason rather than approximated
 * with a local path — which would measure nothing the local arm does not.
 *
 * ## What it creates
 *
 * One session per runtime family plus one scratch workspace under the OS temp
 * dir, removed in a `finally`. Nothing is written inside `NESSY_CONFIG_DIR`
 * except the sessions themselves, and no connection is edited.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { approvePermissionsWhile, requireApproverSaw } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, listConnections, runtimeOf, switchRuntime, trustScratchProject } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, transcript, type SessionKey, type TranscriptMessage } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe, SittingRuntime } from '../lib/sitting.ts'

const ID = 'RS-76'
const TITLE = 'overwriting a file the model has never read, on all three runtimes'

/** The subject file's seeded content — its marker must be GONE after an overwrite. */
const SEEDED = 'SEEDED-CONTENT-DO-NOT-KEEP'
/** What the model is asked to put there instead. */
const REPLACEMENT = 'REPLACED-BY-MODEL'
/** The positive control's own file and marker. */
const CONTROL_FILE = 'control-new.txt'
const CONTROL_MARKER = 'CONTROL-NEW-FILE'
const SUBJECT_FILE = 'subject.txt'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.57',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: the gateway cards for the families to be measured. Everything written lands in a scratch directory '
    + 'the case mints under the OS temp dir and removes; no key is read.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher in scripts/cdp/README.md.',
    '2. Mint a scratch workspace under the OS temp dir with one seeded file in it.',
    '3. Per runtime family: a fresh session bound to that family\'s card and to that directory, answering the trust gate.',
    '4. ONE turn asking for the seeded file to be replaced WITHOUT reading it first, and for a second, new file to be created beside it.',
    '5. Read the two files off disk, and read the turn\'s tool calls IN ORDER to see whether a read preceded the write.',
    '6. Classify the arm: read-then-wrote (not tested), wrote-blind (the answer), or refused (quote the sentence).',
  ],
  expected:
    'On a runtime with no read-before-write rule the seeded marker is gone and the replacement is on disk, with '
    + 'no read of that path in front of the write. A refusal, if one appears, is the finding and is quoted.',
  detector:
    'the subject file\'s own bytes before and after the turn — the seeded marker gone and the replacement present '
    + 'is an overwrite and nothing else is. A tool STATUS is not the detector: a tool can report success and write '
    + 'nothing.',
  positiveControl:
    'a second file created NEW by the same turn in the same directory. It proves the workspace is writable, the '
    + 'write tool is reachable and the session is bound where the case thinks it is — so an untouched subject file '
    + 'is a refusal rather than a rig that could not write at all.',
  doneMeans:
    'D1.57\'s first behaviour carries a per-runtime verdict with its control; the network / cloud-synced path arm '
    + 'is recorded as owed with the reason rather than approximated.',
  doNotConflate:
    'A model that reads the file before writing has COMPLIED, not been stopped. That arm is `not-tested` and must '
    + 'never be reported as "a read-before-write rule exists".',
  safety:
    'every path written is inside a directory this case minted under the OS temp dir and removes in a `finally`; '
    + 'the prompt names those paths and nothing else.',
} as const satisfies SittingRecipe

interface ArmReading {
  readonly runtime: SittingRuntime
  readonly classification: 'wrote-blind' | 'read-then-wrote' | 'no-write' | 'refused'
  readonly toolSequence: { tool: string; status?: string; mentionsSubject: boolean }[]
  readonly subjectAfter: string
  readonly seededMarkerGone: boolean
  readonly replacementPresent: boolean
  readonly controlFileCreated: boolean
  readonly approvals: number
  readonly refusalText: string
}

/** Fresh subject + no control file: the state every arm starts from. */
function seed(workspace: string): void {
  writeFileSync(join(workspace, SUBJECT_FILE), `${SEEDED}\n`, 'utf8')
  rmSync(join(workspace, CONTROL_FILE), { force: true })
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the write this case drives')
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

  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs76-ws-')))
  run.observe('the scratch workspace this case minted', workspace)
  const readings: ArmReading[] = []
  try {
    for (const entry of picked) {
      seed(workspace)
      const subjectPath = join(workspace, SUBJECT_FILE)
      const controlPath = join(workspace, CONTROL_FILE)
      const before = read(subjectPath)

      const key: SessionKey & { fresh: boolean; reason?: string } = await freshSession(
        session, `CDP ${ID} ${entry.runtime} ${new Date().toISOString().slice(11, 19)}`,
      )
      run.check(`the ${entry.runtime} arm ran in a session it created`, key.fresh, key.fresh ? undefined : key.reason)
      const bind = await switchRuntime(session, key.sessionId, entry.card.slug)
      run.check(`the ${entry.runtime} arm is bound to ${entry.card.slug}`, bind.ok, bind.ok ? undefined : `switchRuntime refused: ${bind.error}`)
      await bindProject(run, session, key.sessionId, workspace, {
        label: entry.runtime, gate: () => trustScratchProject(session, workspace),
      })

      const messagesBefore = (await transcript(session, key)).length
      const approver = approvePermissionsWhile(session, key.sessionId)
      await sendPrompt(
        session,
        key,
        `Do exactly two things in this directory, using your file-writing tool. `
        + `First, replace the whole contents of the file ${SUBJECT_FILE} with the single line ${REPLACEMENT} — `
        + `write it directly, without opening or reading that file first. `
        + `Second, create a new file ${CONTROL_FILE} containing the single line ${CONTROL_MARKER}. `
        + 'Then reply with the word done.',
        300_000,
      ).catch(() => undefined)
      const approvals = await approver.stop()
      // D1.356 — the arm's whole classification is what the turn managed to do.
      // A card this approver could not see leaves the write unmade, and
      // `wrote-blind` vs nothing-happened is the finding.
      requireApproverSaw(run, approver, `${entry.runtime} arm`)
      const added: TranscriptMessage[] = (await transcript(session, key)).slice(messagesBefore)

      const toolSequence = added
        .filter(message => typeof message.toolName === 'string' && message.toolName.length > 0)
        .map(message => ({
          tool: message.toolName ?? '',
          status: message.toolStatus,
          // `toolInput` is a RECORD, not a string: a template literal would
          // stringify it to `[object Object]` and the needle could never match
          // — the "a negative needle the corpus cannot spell" trap, one line
          // deep. JSON, so the path inside it is really searched.
          mentionsSubject: `${JSON.stringify(message.toolInput ?? {})} ${message.toolResult ?? ''}`.includes(SUBJECT_FILE),
        }))

      const after = read(subjectPath)
      const seededGone = before.includes(SEEDED) && !after.includes(SEEDED)
      const replaced = after.includes(REPLACEMENT)
      const controlCreated = existsSync(controlPath) && read(controlPath).includes(CONTROL_MARKER)

      // The ORDER is what separates "no rule" from "the model complied": a read
      // of the subject path anywhere before the first write of it means the rule
      // was never tested on this arm.
      const firstWriteIndex = toolSequence.findIndex(call => call.mentionsSubject && /write|edit|create|apply|patch/i.test(call.tool))
      const readBefore = toolSequence
        .slice(0, firstWriteIndex === -1 ? toolSequence.length : firstWriteIndex)
        .some(call => call.mentionsSubject && /read|view|cat|open|grep|search/i.test(call.tool))
      const refusalText = added
        .filter(message => message.role === 'error' || message.toolStatus === 'error')
        .map(message => (message.toolResult ?? message.content ?? '').replace(/\s+/g, ' ').trim())
        .join(' | ')
        .slice(0, 300)

      const classification: ArmReading['classification'] = !replaced && !seededGone
        ? (refusalText.length > 0 ? 'refused' : 'no-write')
        : (readBefore ? 'read-then-wrote' : 'wrote-blind')

      const reading: ArmReading = {
        runtime: entry.runtime,
        classification,
        toolSequence,
        subjectAfter: after.replace(/\s+/g, ' ').trim().slice(0, 120),
        seededMarkerGone: seededGone,
        replacementPresent: replaced,
        controlFileCreated: controlCreated,
        approvals,
        refusalText,
      }
      readings.push(reading)
      run.observe(`${entry.runtime} — the arm`, reading)

      run.check(
        `THE CONTROL (${entry.runtime}) — the turn created the NEW file, so this workspace is writable and bound`,
        controlCreated,
        `${CONTROL_FILE} is absent or does not carry its marker. Without it, an untouched subject file is a rig `
        + 'that could not write at all rather than a refusal, and this arm says nothing either way',
      )
      run.check(
        `${entry.runtime.toUpperCase()} — nothing stopped the overwrite of an unread file`,
        classification === 'wrote-blind',
        `classified ${classification}: the seeded marker is ${seededGone ? 'gone' : 'still there'}, the `
        + `replacement is ${replaced ? 'present' : 'absent'}, and the tool order was `
        + `${JSON.stringify(toolSequence.map(call => call.tool))}. `
        + (classification === 'read-then-wrote'
          ? 'The model READ the file before writing it, so it complied rather than being stopped — this arm does '
            + 'not show a rule and must not be reported as one'
          : refusalText
            ? `A refusal was recorded: ${JSON.stringify(refusalText)}`
            : 'No write reached disk and nothing said why'),
      )
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }

  run.observe('verdict', {
    perRuntime: readings.map(r => ({
      runtime: r.runtime,
      classification: r.classification,
      tools: r.toolSequence.map(call => call.tool),
      controlFileCreated: r.controlFileCreated,
      approvalsAnswered: r.approvals,
    })),
    owed:
      'the row\'s SECOND behaviour — a write to a network or cloud-synced path — is not driven here: this machine '
      + 'has no such mount and a case may not create one. Approximating it with a local path would measure nothing '
      + 'the arm above does not.',
  })
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
