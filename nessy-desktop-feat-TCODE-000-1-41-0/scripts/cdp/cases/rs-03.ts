/**
 * RS-03 (row P6.91) — has anything ever persisted a reasoning chain, and does
 * one survive a switch at all?
 *
 * Ledger D3/Pi, marker `absent` from a TEXT read. This case is the input to the
 * owner's D3 re-ask and is **not a licence to build**: G4 (2026-08-20) stands
 * until the owner reopens it. It measures, and it is deliberately capable of
 * refuting its own row.
 *
 * ## Two halves, and the first one is a census the app cannot answer
 *
 * **Half 1 — the corpus.** `isThinking` is persisted (P4.4, `a6d56aabc`;
 * `packages/core/src/types/message.ts`), produced by the Pi event adapter and
 * stored by `SessionManager`. The claim this row exists to re-derive is a
 * counted one — "0 of 5,332" — so the census is a count with a DATE, run over
 * the operator's own `session.jsonl` files under the config dir the app under
 * test uses. `isIntermediate` is the positive control: it rides the same rows
 * through the same writer, so a reader that scores zero for BOTH is a reader
 * that is not parsing the corpus, not a corpus without reasoning.
 *
 * **Half 2 — the crossing.** A Pi conversation whose reasoning is visible, then
 * a switch onto a claude-runtime card, then a question that can only be answered
 * from the earlier reasoning. The CONTROL is an ordinary assistant sentence in
 * the same window, which must cross on every tier: without it, "the reasoning did
 * not arrive" cannot be told from "nothing arrived".
 *
 * ## The tier is read from the server, never assumed
 *
 * `previewRuntimeSwitch` is the server's own pre-switch decision and it returns
 * `historyCarry` plus `historyCarryReason`. The row asks for both a `native` arm
 * and a `text` arm, and only the server decides which a given card gets, so this
 * case PREVIEWS every claude-runtime card on the host and drives whichever tiers
 * it actually finds. An arm it cannot reach is recorded as unreachable, with the
 * reason each card gave — never as a measured negative. Reaching `text` on
 * purpose needs a target whose context window the conversation does not fit
 * (`does-not-fit`), which is an operator setup and is in `manual` below.
 *
 * ## Native mechanism, restated at HEAD
 *
 * Pi's own session entry is `content: string | (TextContent | ImageContent)[]`
 * (`pi-coding-agent/dist/core/session-manager.d.ts`) — there is no reasoning slot
 * in the format at all. That is why this row is a measurement and not a build:
 * a native carry can only carry what the native format holds.
 *
 * ## Nothing this case records is conversation text
 *
 * The census reports counts, file counts and dates. It never prints a line of
 * anyone's transcript, and it reads the operator's own corpus, so that rule is
 * not a nicety.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-03'
const TITLE = 'A reasoning chain is counted in the persisted corpus and asked to survive a Pi to claude switch'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.91',
  runtimes: ['pi', 'claude'],
  credentials: 'owner: a claude-runtime card, already signed in; the census reads the operator corpus and prints no text',
} as const satisfies CaseMeta

/** Do not read an unbounded corpus into memory; a count needs a bounded read. */
const MAX_FILE_BYTES = 32 * 1024 * 1024

interface Census {
  root: string
  files: number
  filesRead: number
  filesSkippedTooLarge: number
  bytes: number
  thinkingRows: number
  intermediateRows: number
  filesWithThinking: number
  filesWithIntermediate: number
  oldestModified?: string
  newestModified?: string
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * Every `session.jsonl` under `<config>/sessions/<workspace>/<session>/`.
 *
 * Two levels, not a recursive walk: the layout is fixed
 * (`workspaces/paths.ts`), and a recursive walk would also read the runtime
 * sidecars, which are a different corpus with different fields.
 */
function sessionLogs(root: string): string[] {
  const sessionsRoot = join(root, 'sessions')
  if (!existsSync(sessionsRoot)) return []
  const found: string[] = []
  for (const workspace of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(sessionsRoot, workspace.name)
    for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(workspaceDir, entry.name, 'session.jsonl')
      if (existsSync(file)) found.push(file)
    }
  }
  return found
}

function census(root: string): Census {
  const files = sessionLogs(root)
  const result: Census = {
    root,
    files: files.length,
    filesRead: 0,
    filesSkippedTooLarge: 0,
    bytes: 0,
    thinkingRows: 0,
    intermediateRows: 0,
    filesWithThinking: 0,
    filesWithIntermediate: 0,
  }
  let oldest = Number.POSITIVE_INFINITY
  let newest = 0
  for (const file of files) {
    let size = 0
    try {
      const stat = statSync(file)
      size = stat.size
      oldest = Math.min(oldest, stat.mtimeMs)
      newest = Math.max(newest, stat.mtimeMs)
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) {
      result.filesSkippedTooLarge += 1
      continue
    }
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    result.filesRead += 1
    result.bytes += size
    // Both JSON spellings, because a writer may or may not put a space after the
    // colon and a count that misses one spelling reads as an absence.
    const thinking = countOccurrences(text, '"isThinking":true') + countOccurrences(text, '"isThinking": true')
    const intermediate = countOccurrences(text, '"isIntermediate":true') + countOccurrences(text, '"isIntermediate": true')
    result.thinkingRows += thinking
    result.intermediateRows += intermediate
    if (thinking > 0) result.filesWithThinking += 1
    if (intermediate > 0) result.filesWithIntermediate += 1
  }
  if (Number.isFinite(oldest)) result.oldestModified = new Date(oldest).toISOString().slice(0, 10)
  if (newest > 0) result.newestModified = new Date(newest).toISOString().slice(0, 10)
  return result
}

interface Preview {
  kind?: string
  hasHistory?: boolean
  historyCarry?: string
  historyCarryReason?: string
  error?: string
}

async function previewSwitch(session: CdpSession, sessionId: string, slug: string): Promise<Preview> {
  return session.call<Preview>(`
    try {
      return await window.electronAPI.sessionCommand(
        ${JSON.stringify(sessionId)},
        { type: 'previewRuntimeSwitch', connectionSlug: ${JSON.stringify(slug)} },
      )
    } catch (e) { return { error: String(e && (e.code || e.message) || e) } }
  `)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // ---- Half 1: the census, with its own positive control --------------------
  const root = configDir()
  const counted = census(root)
  run.observe('census', counted)
  run.observe('census date', new Date().toISOString().slice(0, 10))
  run.check(
    'THE CONTROL — the census reader parses the same rows the corpus claim was made over',
    counted.filesRead > 0 && counted.intermediateRows > 0,
    counted.filesRead === 0
      ? `no session.jsonl under ${join(root, 'sessions')} — point NESSY_CONFIG_DIR at the config dir the app under test uses`
      : counted.intermediateRows === 0
        ? 'zero isIntermediate rows as well, which is a reader that is not parsing this corpus rather than a corpus with no reasoning'
        : undefined,
  )
  run.observe(
    'VERDICT half 1',
    counted.intermediateRows === 0
      ? 'uninterpretable — the control scored zero'
      : counted.thinkingRows === 0
        ? `no persisted reasoning in ${counted.filesRead} session files (control: ${counted.intermediateRows} isIntermediate rows) — the ledger absent stands, re-derived`
        : `${counted.thinkingRows} persisted reasoning rows across ${counted.filesWithThinking} files — the ledger absent is REFUTED and D3 moves to partial`,
  )

  // ---- Half 2: the crossing -------------------------------------------------
  const connections = await listConnections(session)
  const piCards = connections.filter(row => runtimeOf(row.providerType) === 'pi')
  const claudeCards = connections.filter(row => runtimeOf(row.providerType) === 'anthropic')
  run.observe('cards', { pi: piCards.map(r => r.slug), claude: claudeCards.map(r => r.slug) })
  if (piCards.length === 0 || claudeCards.length === 0) {
    blocked(
      'half 2 needs one Pi card and one claude-runtime card on the same host; '
      + `this host lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}. `
      + 'Half 1 above is already recorded and is the half that answers the census question.',
    )
  }

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', key.fresh,
    key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  const onPi = await switchRuntime(session, key.sessionId, piCards[0]!.slug)
  run.observe('switch onto pi', onPi)
  run.require('the session runs on the Pi card',
    (await waitForConnection(session, key.sessionId, piCards[0]!.slug)) === piCards[0]!.slug, piCards[0]!.slug)

  // A question whose ANSWER is short and whose WORKING is long, so the reasoning
  // and the reply are separable afterwards. Phrased positively: it asks for
  // thinking, it forbids nothing.
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
  const control = `NESSY-${stamp}`
  await sendPrompt(
    session,
    key,
    'Think this through step by step before answering, and show your working: '
    + 'a train leaves at 09:14 and the journey takes 3 hours and 47 minutes, with one 12-minute stop. '
    + `When does it arrive? Then, on a separate final line, write exactly: reference ${control}`,
    300_000,
  ).catch(() => undefined)

  // The tier, from the server, for every claude card the host has.
  const previews: { slug: string; preview: Preview }[] = []
  for (const card of claudeCards) {
    previews.push({ slug: card.slug, preview: await previewSwitch(session, key.sessionId, card.slug) })
  }
  run.observe('previewRuntimeSwitch pi -> claude, per card', previews)

  const nativeArm = previews.find(row => row.preview.historyCarry === 'native')
  const textArm = previews.find(row => row.preview.historyCarry === 'text')
  run.observe('arms reachable on this host', {
    native: nativeArm?.slug ?? '(none)',
    text: textArm?.slug ?? '(none — see the manual block)',
  })
  run.check(
    'at least one arm is reachable, so the crossing measures a tier the server chose',
    nativeArm !== undefined || textArm !== undefined,
    previews.map(row => `${row.slug}=${row.preview.historyCarry ?? row.preview.error ?? 'none'}/${row.preview.historyCarryReason ?? '-'}`).join(', '),
  )

  for (const arm of [nativeArm, textArm]) {
    if (!arm) continue
    const tier = arm.preview.historyCarry!
    const moved = await switchRuntime(session, key.sessionId, arm.slug)
    run.observe(`switch pi -> ${arm.slug} (${tier})`, moved)
    if (!moved.ok) {
      run.check(`the ${tier} arm switch was accepted`, false, moved.error ?? '')
      continue
    }
    run.check(`the session reports ${arm.slug}`,
      (await waitForConnection(session, key.sessionId, arm.slug)) === arm.slug, arm.slug)

    const asked = await sendPrompt(
      session,
      key,
      'Answer from our conversation only. First, quote the reference line I asked for earlier, exactly. '
      + 'Second, quote the working you showed for the train question — the intermediate steps themselves, '
      + 'not a fresh calculation.',
      300_000,
    ).catch(() => undefined)
    // F1.503 — THIS turn's rows: over the whole transcript a claude turn that
    // wrote nothing read the Pi reply (which quotes the reference) as its own.
    const answer = asked ? lastAssistantText(asked.added) : ''
    run.observe(`${tier} arm answer`, answer.slice(0, 400))
    // The control first: an ordinary assistant sentence must cross on every tier.
    run.check(
      `THE CONTROL — the ${tier} arm carried an ordinary assistant line across`,
      answer.includes(control),
      answer.includes(control) ? undefined
        : `the reference ${control} did not survive the switch, so nothing about REASONING can be read from this arm`,
    )
    // And the subject. A miss here is the expected result on today's evidence;
    // it is recorded either way, which is the whole point of the row.
    const carriedWorking = /09:14|13:13|13:01|12:|minute/i.test(answer) && answer.length > 80
    run.observe(`${tier} arm reasoning carried`, carriedWorking)
  }
}

/**
 * How an operator reaches the `text` arm on purpose, when no card previews it.
 *
 * The server plans `text` for `does-not-fit` — the conversation is larger than
 * the target model's context window — and that is the only one of the three
 * degrading reasons a person can create deliberately.
 */
export const manual = {
  why: 'P6.91 asks for a text arm as well as a native one, and only the server decides which a card gets',
  runOnlyIf: 'the automated run recorded `text: (none)`',
  steps: [
    'Add or select a claude-runtime card whose default model has a SMALL context window.',
    'In the session this case created, keep the conversation going until previewRuntimeSwitch answers '
      + 'historyCarry=text with historyCarryReason=does-not-fit for that card.',
    'Re-run this case: bun run scripts/cdp/cases/rs-03.ts — it drives whichever arms the server offers.',
  ],
  expected: 'the control reference line crosses on BOTH arms; the reasoning working crosses on neither, '
    + 'because Pi own session format has no reasoning slot to carry',
  detector: 'previewRuntimeSwitch historyCarry / historyCarryReason for the tier, and the model quoting '
    + 'the earlier reference line for the control',
  positiveControl: 'the reference line planted in the Pi turn, which must cross on every tier',
  doneMeans: 'a dated census number and a two-arm result in the row, so the ledger `absent` is re-derived '
    + 'or corrected to `partial`, and G4 written premise is settled by measurement as well as by code',
} as const satisfies SittingRecipe

if (import.meta.main) await main(ID, TITLE, drive)
