/**
 * RS-38 (plan row C3.371) — the reopen compact-or-keep card's THREE answers,
 * each of which must reach the backend.
 *
 * ## Why this case exists, and why it exists as a case rather than a unit test
 *
 * The card shipped with three green unit tests over a rig that plants
 * `managed.agent`, and on the packaged 1.36.0 build NONE of its three answers
 * reached anything: `respondToPermission` gated its whole body on
 * `if (managed?.agent)`, and this is the one card raised with NO turn in flight
 * — `getSession` → `offerCompactOnReopen`, before the reopened conversation's
 * first message has created an agent. So every answer fell to the method's
 * closing `no agent for session` warn and returned `false`: the pending record
 * was never removed, the host effect never ran, and the resolver never settled.
 * R6b measured it on 2026-09-12 across five sessions, two launches and two click
 * mechanisms; C3.371 (`e071be641`) is the one-guard fix. This case is the live
 * proof, and the row owed one.
 *
 * The unit tests could not see it because the seam that was wrong is the one a
 * rig has to fake. This case fakes nothing about the answer path: a real mouse
 * click on the card's own button, and the BACKEND's own counter as the verdict.
 *
 * ## THE DETECTOR IS `awaitingApprovalCount`, NEVER THE SCREEN
 *
 * Read off `getSessions()`, derived at read time from the live pending map. It is
 * the only instrument that separates the defect from the fix, and R6b's run is
 * why every cheaper one is refused here:
 *
 * | read | what it says on a BROKEN build |
 * | --- | --- |
 * | the banner leaves the screen | it leaves — the renderer removes its own card |
 * | reopening asks nothing a second time | it asks nothing — `reopenCompactOffersInFlight` still holds the key while the await has not returned, so silence means nothing either way |
 * | `awaitingApprovalCount` | **1 → 1**. On a fixed build, 1 → 0 |
 *
 * Two further records are read because they are what the three answers are FOR,
 * and each is written by the product rather than observed on a surface:
 * `reopenCompactChoice` in the session's own persisted meta line, and — for the
 * third answer only — `reopenCompactPromptTokens: 0` in `config.json`, which is
 * `disableReopenCompactPrompt()`'s whole effect.
 *
 * ## The negative control, and it is the one the unit tests already have
 *
 * A FOURTH prepared session is opened, its card is left UNANSWERED, and its
 * count must still be 1 with no choice persisted. Without it, "the count dropped"
 * is equally true of a build where the count drops for any reason at all — and
 * three passing positives over a broken counter is exactly the shape this row
 * was born from.
 *
 * ## THE CLICK: by LABEL, among the VISIBLE copy, with a real mouse event
 *
 * `[data-tutorial="permission-banner"]` matches TWO elements — `InputContainer`
 * renders a `visibility: hidden` measuring copy FIRST and it keeps its box
 * (`lib/ask-user.ts` trap 1) — and a hidden subtree yields empty `innerText`, so
 * the first three buttons read `""` and a selector-based click lands on a dead
 * copy whose card then disappears anyway. R6b paid for that twice. The `as-is`
 * answer also has no `data-tutorial` hook at all: it is the card's Deny button
 * with the product's own `chat.reopenCompact.asIs` label.
 *
 * ## Two passes, because the preconditions are a config write
 *
 * The offer needs an idle conversation over the token threshold, and both halves
 * live in the config dir's own files. A case may not write there (README); the
 * fixture may. So the FIRST run of this case seeds four named sessions with one
 * real turn each and BLOCKS, naming the fixture and the relaunch; the second run
 * finds them rewound and measures. `AGT-8` is the precedent — two sittings with
 * an operator step between them.
 *
 * ## Run the answers in THIS order, and the third one last
 *
 * The third answer turns the dialog off for the whole profile
 * (`reopenCompactPromptTokens = 0`), so any arm after it would meet no card and
 * read as a regression. The case drives summary → as-is → dont-ask → the
 * unanswered control, and the control is opened BEFORE the dont-ask arm for the
 * same reason.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { findCardButton } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import {
  assertElectronApi, ensureSessionName, freshSession, listSessions, selectorCount, selectorText, transcript,
  type SessionKey,
} from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'

const ID = 'RS-38'
const TITLE = 'the reopen compact-or-keep card: all three answers, each measured at the backend rather than on the screen'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'C3.371',
  runtimes: ['claude'],
  credentials:
    'owner: one claude-runtime card, already signed in — the card is the HOST\'s and the compaction it '
    + 'dispatches is each runtime\'s own, so the runtime here is the arm R6b measured rather than a property '
    + 'of the feature. Launch the app with NESSY_CONFIG_DIR pointing at a directory created for the run and '
    + 'export the same value to this process: the third answer WRITES that profile\'s config.json.',
} as const satisfies CaseMeta

const BANNER = '[data-tutorial="permission-banner"]'
/** `chat.reopenCompact.*` — the product's own labels, spelled out rather than imported. */
const ANSWER_LABEL = {
  summary: 'Resume from summary',
  'as-is': 'Resume full session as-is',
  // A typographic apostrophe: `chat.reopenCompact.dontAsk` is "Don’t ask me again".
  'dont-ask': 'Don’t ask me again',
} as const

type Answer = keyof typeof ANSWER_LABEL
/** summary → as-is → dont-ask, and the control between the second and the third. */
const ANSWERS: readonly Answer[] = ['summary', 'as-is', 'dont-ask']
/** The fourth session, opened and deliberately never answered. */
const CONTROL_ARM = 'unanswered'
const ARMS: readonly string[] = [...ANSWERS, CONTROL_ARM]

/** `REOPEN_COMPACT_IDLE_MS` is about an hour; the fixture rewinds well past it. */
const IDLE_FLOOR_MS = 90 * 60 * 1000

/** The session's own persisted meta line — the record `persistSession` writes. */
function persistedMeta(key: SessionKey): Record<string, unknown> | undefined {
  const configDir = process.env.NESSY_CONFIG_DIR
  if (!configDir) return undefined
  const file = join(configDir, 'sessions', key.workspaceId, key.sessionId, 'session.jsonl')
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8').split('\n')[0] ?? '{}') as Record<string, unknown>
  } catch { return undefined }
}

/**
 * POLL for the persisted choice — `persistSession` does not reach disk before
 * `respondToPermission` returns, and reading the file once scored two of the
 * three answers as not persisted on a build that persists all three.
 *
 * Measured on the 1.37.0 release build (RV, 2026-09-12, HEAD `10c12eb65`): the
 * `as-is` and `dont-ask` arms read `reopenCompactChoice=undefined` immediately
 * after `awaitingApprovalCount` hit 0, and both files carried `'as-is'` when the
 * same lines were read again minutes later. The `summary` arm passed the
 * one-shot read only because its `/compact` turn forces a second persist. So a
 * single read of that field measures the flush, not the answer.
 */
async function persistedChoiceWithin(key: SessionKey, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const choice = persistedMeta(key)?.reopenCompactChoice
    if (typeof choice === 'string' || Date.now() >= deadline) {
      return typeof choice === 'string' ? choice : undefined
    }
    await Bun.sleep(1_500)
  }
}

/** `config.json`'s knob — `disableReopenCompactPrompt()` sets it to 0. */
function promptThreshold(): number | undefined {
  const configDir = process.env.NESSY_CONFIG_DIR
  if (!configDir) return undefined
  try {
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as Record<string, unknown>
    return typeof config.reopenCompactPromptTokens === 'number' ? config.reopenCompactPromptTokens : undefined
  } catch { return undefined }
}

/** The backend's own pending-approval count for one session. */
async function awaitingApprovals(session: CdpSession, sessionId: string): Promise<number> {
  return session.call<number>(`
    const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(sessionId)})
    return s && typeof s.awaitingApprovalCount === 'number' ? s.awaitingApprovalCount : -1
  `).catch(() => -1)
}

async function pollApprovals(
  session: CdpSession, sessionId: string, wanted: (n: number) => boolean, timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = await awaitingApprovals(session, sessionId)
  while (!wanted(last) && Date.now() < deadline) {
    await Bun.sleep(1_500)
    last = await awaitingApprovals(session, sessionId)
  }
  return last
}

/**
 * Open a session the way a user does — click its sidebar row, `getSession`'s own
 * entry point, which is what raises the offer.
 *
 * The row can sit below a 900px viewport on a profile with a dozen sessions, and
 * `clickAt` refuses a point outside it rather than dispatching a click that
 * lands nowhere, so it is scrolled into view first and the list is given a beat
 * to settle (R6b, 2026-09-12: measured at y=1159).
 */
async function openSessionRow(session: CdpSession, sessionId: string): Promise<void> {
  await session.call<null>(`
    const el = document.querySelector('.session-item[data-session-id="${sessionId}"]')
    if (el) el.scrollIntoView({ block: 'center' })
    return null
  `)
  await Bun.sleep(1_200)
  const rect = await session.call<{ x: number; y: number } | null>(`
    const el = document.querySelector('.session-item[data-session-id="${sessionId}"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  `)
  if (!rect) throw new Error(`rs-38: no sidebar row for session ${sessionId}`)
  await clickAt(session, rect, `the sidebar row of ${sessionId}`)
}

interface ClickedAnswer {
  label: string
  index: number
  /** Every VISIBLE button's label at the moment of the click (C3.374). */
  visibleLabels?: string[]
  clicked: boolean
  buttons: string[]
}

/** Click the card's own button carrying `label`, among the VISIBLE copy only. */
async function answerCard(session: CdpSession, label: string): Promise<ClickedAnswer> {
  // C3.374 — the visible-copy scan is `lib/ask-user.ts` symbol `findCardButton`
  // now, shared with `rs-13.ts` and `rs-36.ts`. `visibility`/`rects` are no
  // longer reported per button: the helper returns ONLY visible buttons, so
  // those two fields could not carry any other value, and the labels it returns
  // say more about a miss than either of them did.
  const found = await findCardButton(session, { card: BANNER, labels: [label], match: 'prefix' })
  const buttons = await selectorText(session, `${BANNER} button`)
  if (!found) return { label, index: -1, clicked: false, buttons }
  await clickAt(session, { x: found.x, y: found.y }, `the reopen card's "${label}" button`)
  return { label, index: found.index, visibleLabels: found.labels, clicked: true, buttons }
}

/** A compaction row, however the transcript spells it. */
function compactionRows(messages: Awaited<ReturnType<typeof transcript>>): string[] {
  return messages
    .filter(message => /compact/i.test(`${message.content ?? ''}${message.toolName ?? ''}${message.toolDisplayName ?? ''}`))
    .map(message => `${message.role}:${message.toolName ?? ''}:${(message.content ?? '').slice(0, 120)}`)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const configDir = process.env.NESSY_CONFIG_DIR
  run.observe('config dir reaching THIS process', configDir ?? '(unset)')
  if (!configDir) {
    blocked(
      'NESSY_CONFIG_DIR must reach this process as well as the app: two of the three records this case reads '
      + 'are files in the profile (`sessions/**/session.jsonl`’s `reopenCompactChoice`, and '
      + '`config.json`’s `reopenCompactPromptTokens`), and the third answer is measured by nothing else.',
    )
  }
  run.observe('reopenCompactPromptTokens at the start', promptThreshold() ?? '(absent — the 100 000 default)')

  const connections = await listConnections(session)
  const claudeCard = connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug
  if (!claudeCard) {
    blocked(
      'this case needs one claude-runtime card; the host lists '
      + `${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}.`,
    )
  }
  run.observe('card under test', claudeCard)

  // ---- Which arms are already PREPARED, and which have to be seeded --------
  const rows = await listSessions(session)
  const armSession = new Map<string, SessionKey & { name: string; idleMs: number }>()
  for (const arm of ARMS) {
    // AN ALREADY-ANSWERED SESSION IS NOT A USABLE ARM, and picking one is how a
    // second run of this case reads as a regression. `shouldOfferReopenCompaction`
    // takes `answered: managed.reopenCompactChoice !== undefined`, so a session
    // this case has already answered will never be offered the card again — and
    // the arm would score "no card was raised" over a product that is behaving
    // exactly as designed. The field is not on the wire, so it is read from the
    // session's own persisted meta. A re-run therefore seeds four NEW sessions
    // rather than reusing the answered ones, and nothing has to be deleted.
    const match = rows.find(row => (row.name ?? '').startsWith(`CDP ${ID} ${arm} `)
      && persistedMeta({ workspaceId: row.workspaceId, sessionId: row.id })?.reopenCompactChoice === undefined)
    if (!match) continue
    armSession.set(arm, {
      workspaceId: match.workspaceId,
      sessionId: match.id,
      name: match.name ?? '',
      idleMs: Date.now() - (match.lastMessageAt ?? Date.now()),
    })
  }
  const prepared = ARMS.filter(arm => (armSession.get(arm)?.idleMs ?? 0) > IDLE_FLOOR_MS)
  run.observe('arms found in this profile', [...armSession.entries()]
    .map(([arm, key]) => ({ arm, sessionId: key.sessionId, idleHours: +(key.idleMs / 3_600_000).toFixed(2) })))

  if (prepared.length < ARMS.length) {
    // PASS ONE — seed what is missing, then stop. One real turn per session so
    // the conversation has a real `contextTokens` for the card to quote: the
    // fixture lowers the THRESHOLD and never fakes the size.
    const seeded: string[] = []
    for (const arm of ARMS) {
      if (armSession.has(arm)) continue
      const armName = `CDP ${ID} ${arm} ${new Date().toISOString().slice(11, 19)}`
      const key = await freshSession(session, armName)
      run.check(`${arm}: seeded in a session it created`, key.fresh,
        key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
      // THE NAME IS THE ONLY THING THAT SURVIVES THE RELAUNCH pass two depends
      // on, so a dropped rename is refused HERE rather than met as an empty
      // profile later. Measured on the 1.37.0 release build (RV, 2026-09-12):
      // this lane's own pass one named four sessions and TWO took, and
      // `freshSession`'s rename turned out to be lost about half the time in its
      // own window — which is why that helper now reads the name back, retries
      // once, and reports `nameDropped` instead of hiding it.
      await switchRuntime(session, key.sessionId, claudeCard)
      run.require(`${arm}: the seed session runs on ${claudeCard}`,
        (await waitForConnection(session, key.sessionId, claudeCard)) === claudeCard, claudeCard)
      // THE NAME IS RE-APPLIED AFTER THE SWITCH, not before it, and that ordering
      // is the whole reason pass two can find these sessions at all.
      // `switchRuntime` CLEARS the name (measured twice on this build; see
      // `ensureSessionName`), and the rename issued at creation never reaches disk
      // on its own — so pass one's first attempt here named four sessions, two
      // kept their names, and pass two came back with `arms found: []` for the
      // other two. The name is the only thing that survives the relaunch this
      // case's two passes are separated by, so a name that will not take is
      // refused HERE rather than met as an empty profile later.
      const named = await ensureSessionName(session, key, armName)
      run.check(`${arm}: the seed session kept its name after the runtime switch`, named === undefined, named)
      await sendPrompt(session, key, 'Reply with the single word seeded.', 300_000)
        .catch(error => run.observe(`${arm}: seed turn error`, String(error)))
      seeded.push(`${arm} -> ${key.sessionId}`)
    }
    run.observe('seeded this pass', seeded)
    blocked(
      `pass one of two. ${seeded.length ? `Seeded ${seeded.length} session(s). ` : ''}`
      + 'The offer needs an idle conversation over the token threshold, and BOTH halves are files in the '
      + 'config dir that a case may not write. Now: QUIT the app, run '
      + '`NESSY_CONFIG_DIR=<this profile> bun run scripts/cdp/fixtures/reopen-compact.ts --idle-hours 3 '
      + '--threshold 20000`, RELAUNCH the app against the same profile, and run this case again — a rewind '
      + 'applied under a running app is overwritten by the next persistSession, and the threshold is read '
      + 'from the config the process loaded.',
    )
  }

  // ---- PASS TWO — the three answers, then the unanswered control -----------
  const thresholdBefore = promptThreshold()
  run.check('the fixture lowered the threshold below the seeded conversations',
    thresholdBefore !== undefined && thresholdBefore > 0,
    `reopenCompactPromptTokens=${String(thresholdBefore)} — a 0 turns the dialog OFF for the whole profile, `
    + 'which is what this case’s own third answer does; re-run the fixture to restore it')

  const readings: Array<Record<string, unknown>> = []
  for (const arm of [...ANSWERS.slice(0, 2), CONTROL_ARM, ANSWERS[2]!]) {
    const key = armSession.get(arm)!
    await openSessionRow(session, key.sessionId)
    const before = await pollApprovals(session, key.sessionId, n => n >= 1, 60_000)
    const cardCount = await selectorCount(session, BANNER)
    const cardText = (await selectorText(session, BANNER)).find(text => text.trim().length > 30) ?? ''
    run.check(`${arm}: the reopen card was raised`, before === 1,
      `awaitingApprovalCount=${before} (banner elements=${cardCount}) — without a pending approval there is `
      + 'nothing for an answer to reach, and the arm below would pass vacuously')

    if (arm === CONTROL_ARM) {
      // THE NEGATIVE CONTROL: nothing is clicked. The count must NOT move.
      await Bun.sleep(20_000)
      const after = await awaitingApprovals(session, key.sessionId)
      const meta = persistedMeta(key)
      run.check('THE CONTROL — an UNANSWERED card leaves the approval pending and persists no choice',
        after === 1 && meta?.reopenCompactChoice === undefined,
        `awaitingApprovalCount=${after}, reopenCompactChoice=${String(meta?.reopenCompactChoice)} — if this `
        + 'drops on its own then every answered arm above proves nothing about the answer')
      readings.push({ arm, before, after, choice: meta?.reopenCompactChoice ?? null })
      continue
    }

    const answer = arm as Answer
    const clicked = await answerCard(session, ANSWER_LABEL[answer])
    run.observe(`${arm}: the button clicked`, clicked)
    run.check(`${arm}: the card carries its own "${ANSWER_LABEL[answer]}" button`, clicked.clicked,
      `visible buttons: ${JSON.stringify(clicked.buttons)}`)
    const after = await pollApprovals(session, key.sessionId, n => n === 0, 45_000)
    run.check(`${arm}: THE ANSWER REACHED THE BACKEND — awaitingApprovalCount 1 -> 0`, after === 0,
      `it is ${after}. On the packaged 1.36.0 this stayed 1 while the banner left the screen, which is `
      + 'C3.371 exactly: the card was a dialog with no consequences')
    const expectedChoice = answer === 'summary' ? 'summary' : 'as-is'
    const persistedChoice = await persistedChoiceWithin(key, 30_000)
    run.check(`${arm}: the choice was PERSISTED as "${expectedChoice}"`,
      persistedChoice === expectedChoice,
      `session.jsonl says reopenCompactChoice=${String(persistedChoice)} — "asked once" is this `
      + 'field and nothing else, and it must survive a restart')

    if (answer === 'summary') {
      const rowsSeen = await (async () => {
        const deadline = Date.now() + 180_000
        for (;;) {
          const found = compactionRows(await transcript(session, key))
          if (found.length > 0 || Date.now() > deadline) return found
          await Bun.sleep(5_000)
        }
      })()
      run.observe('summary: compaction rows', rowsSeen.slice(0, 6))
      run.check('summary: the runtime\'s OWN compaction actually ran',
        rowsSeen.length > 0,
        'no compaction row in the transcript three minutes after the answer landed. `offerCompactOnReopen` '
        + 'dispatches a plain `/compact` through `sendMessage`, so the answer reaching the backend and the '
        + 'compaction running are two claims, and this is the second')
    }
    if (answer === 'dont-ask') {
      const threshold = promptThreshold()
      run.observe('dont-ask: reopenCompactPromptTokens afterwards', threshold ?? '(absent)')
      run.check('dont-ask: the dialog was turned off for every future reopen',
        threshold === 0,
        `config.json says reopenCompactPromptTokens=${String(threshold)}, was ${String(thresholdBefore)} — `
        + '`disableReopenCompactPrompt()` writing 0 is the whole of the page’s third answer')
    }
    readings.push({ arm, before, after, choice: persistedChoice ?? null,
      cardText: cardText.slice(0, 240) })
  }
  run.observe('readings', readings)
  run.observe('the profile is now dialog-OFF',
    'the third answer wrote reopenCompactPromptTokens=0. Re-run the fixture with --threshold before any '
    + 'further reopen measurement on this profile, and delete the four CDP RS-38 sessions when done.')
}

export const manual = {
  steps: [
    '1. PACKAGED build, one content panel, a claude-runtime card signed in, and NESSY_CONFIG_DIR pointing at a profile created for the run — exported to the app AND to this process.',
    '2. `bun run scripts/cdp/cases/rs-38.ts` — pass one. It seeds four sessions named `CDP RS-38 <arm> <time>` with one real turn each and BLOCKS.',
    '3. QUIT the app. `NESSY_CONFIG_DIR=<the profile> bun run scripts/cdp/fixtures/reopen-compact.ts --idle-hours 3 --threshold 20000`. RELAUNCH against the same profile.',
    '4. `bun run scripts/cdp/cases/rs-38.ts` again — pass two drives summary, as-is, the unanswered control and dont-ask, in that order.',
    '5. The third answer leaves the profile with `reopenCompactPromptTokens: 0`. Re-run the fixture with `--threshold` before measuring a reopen on that profile again.',
  ],
  expected: 'each of the three answers takes `awaitingApprovalCount` from 1 to 0 and persists `reopenCompactChoice` ("summary" for the first, "as-is" for the other two); the summary answer additionally produces a compaction row; the third answer additionally writes `reopenCompactPromptTokens: 0`; and the unanswered fourth session stays at 1 with no choice persisted.',
  detector: '`Session.awaitingApprovalCount` off `electronAPI.getSessions()` — derived at read time from the live pending map — plus the two records the product writes itself: `reopenCompactChoice` in the session\'s persisted meta line and `reopenCompactPromptTokens` in `config.json`. NOT the banner leaving the screen (the renderer removes its own card either way) and NOT a silent second reopen (`reopenCompactOffersInFlight` holds the key while the await has not returned, so silence means nothing).',
  positiveControl: 'each arm asserts `awaitingApprovalCount === 1` BEFORE it clicks, which is the proof the instrument can see a pending approval at all; and a fourth prepared session is opened and left UNANSWERED, whose count must still be 1 with no choice persisted — without it, "the count dropped" is equally true of a build where it drops for any reason.',
  doneMeans: 'C3.371 is live-proven on a packaged build for all three answers, or the run names which answer still reaches nothing, with its `awaitingApprovalCount` pair.',
  why: 'it drives; the two passes exist because the offer\'s preconditions are a config write a case may not do, not because an arm cannot be automated.',
  safety: 'the fixture refuses any config dir under the user\'s home without --allow-home, and never writes `tokenUsage` — the threshold is lowered through the operator knob the product already reads, so the number the card quotes is the session\'s real one. Nothing here reads or writes the dp credential.',
  doNotRead: 'the banner\'s disappearance, and the silence of a second reopen. Both are true on the broken build and on the fixed one.',
} as const satisfies SittingRecipe

if (import.meta.main) await main(ID, TITLE, drive)
