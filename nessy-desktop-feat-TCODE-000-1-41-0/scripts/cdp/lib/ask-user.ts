/**
 * The two cards a turn can park on, driven from underneath it.
 *
 * Most of this module is the `ask_user` card — the surface an MCP server's
 * question arrives on. `approvePermissionsWhile` at the bottom is the OTHER one,
 * the ordinary tool-permission card, and it is here because any case that makes
 * a model call an MCP tool meets both in the same turn and must answer each on
 * its own surface.
 *
 * ## The `ask_user` card: read it, and answer it like a user
 *
 * An MCP server's `elicitation/create` reaches a user as exactly this surface —
 * `BaseAgent.surfaceElicitationDialog` publishes a permission request of
 * `type: 'ask_user'` carrying the `AskUserPermissionRequest`, and
 * `AskUserRequest.tsx` renders it under `data-tutorial="ask-user-banner"`. It is
 * NOT the tool-permission card (`data-tutorial="permission-banner"` / its Allow
 * button); the two coexist during an MCP turn and answering the wrong one is
 * how a case can approve a tool call and then time out waiting for a question
 * nobody answered.
 *
 * ## Three traps this module encodes, all previously paid for
 *
 * 1. **The invisible measuring copy.** `InputContainer` renders a
 *    `visibility: hidden` copy of the card BEFORE the visible one — it keeps its
 *    box, so a zero-size guard never fires and a click lands at the wrong `y`.
 *    Measured on AGT-3 with a positive control (`lib/viewport.ts` `elementRect`).
 *    Every read here filters on the same visibility predicate.
 * 2. **`innerText` is layout-dependent.** The card is `h-full` inside a pane
 *    that sizes a frame later, so a read taken the instant the selector matches
 *    returns `''` — and a check on empty text reports "the card says nothing"
 *    about a card that says plenty. `textContent` is the fallback whenever
 *    `innerText` comes back blank (`lib/state.ts` `selectorText` records the
 *    same lesson).
 * 3. **The footer Cancel is not an option.** The card renders the server's
 *    options in one grid and always adds a Cancel button in its own footer.
 *    Counting every button in the card would make `declineVisibly`'s
 *    single-`OK` refusal look like a two-option dialog — which is precisely the
 *    thing ELC-2 asserts is single. `options` is scoped to the grid; every
 *    button is reported separately as `allButtons` so a DOM change shows up as a
 *    shape mismatch rather than as a silent miscount.
 */

import type { CdpSession } from './connect.ts'
import { blocked, type CaseRun } from './report.ts'
import { waitFor } from './state.ts'
import { clickAt } from './viewport.ts'

export const ASK_USER_BANNER = '[data-tutorial="ask-user-banner"]'
/** `AskUserRequest.tsx` renders the server's options in one `grid gap-2` div. */
const OPTION_BUTTONS = `${ASK_USER_BANNER} .grid.gap-2 > button`

export interface AskUserCard {
  present: boolean
  /** The question text as rendered, including the URL for a url-mode ask. */
  question: string
  /** The server's own options, in order. Excludes the footer Cancel. */
  options: string[]
  /** Every button inside the card — a shape read, not an option list. */
  allButtons: string[]
  /** The free-text input is offered (a `string` field, not a choice). */
  freeText: boolean
  /** The url-consent panel is on the SAME card (`elicitation.md` § consent). */
  urlConsent: boolean
}

const EMPTY: AskUserCard = {
  present: false, question: '', options: [], allButtons: [], freeText: false, urlConsent: false,
}

/** The visible ask_user card, or `present: false`. */
export async function readAskUserCard(session: CdpSession): Promise<AskUserCard> {
  return session.call<AskUserCard>(`
    const visible = el => {
      const style = window.getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0
    }
    const text = el => {
      const rendered = (el.innerText ?? '').replace(/\\s+/g, ' ').trim()
      return rendered || (el.textContent ?? '').replace(/\\s+/g, ' ').trim()
    }
    const card = Array.from(document.querySelectorAll(${JSON.stringify(ASK_USER_BANNER)})).find(visible)
    if (!card) return ${JSON.stringify(EMPTY)}
    const options = Array.from(card.querySelectorAll('.grid.gap-2 > button')).filter(visible).map(text)
    const allButtons = Array.from(card.querySelectorAll('button')).filter(visible).map(text)
    return {
      present: true,
      question: text(card),
      options,
      allButtons,
      freeText: card.querySelectorAll('input').length > 0,
      urlConsent: card.querySelectorAll('[data-testid="url-consent"]').length > 0,
    }
  `)
}

/**
 * Wait for a card to be on screen AND to carry its options.
 *
 * Two conditions, not one: `selectorCount > 0` and "the element has the content
 * I expect" are different questions, and the gap between them is where three of
 * this harness's false findings fit (README, *Wait for the surface, do not
 * sample it*). A card whose grid has not rendered yet would otherwise be read as
 * a card with no options.
 */
export async function waitForAskUserCard(session: CdpSession, timeoutMs = 120_000): Promise<AskUserCard> {
  return waitFor(
    () => readAskUserCard(session),
    card => card.present && (card.options.length > 0 || card.freeText),
    { timeoutMs, intervalMs: 750, label: 'an ask_user card with its options rendered' },
  )
}

export interface AskUserAnswered {
  card: AskUserCard
  clicked: string
}

/**
 * Click one of the card's own option buttons, by its visible label.
 *
 * A real mouse click through `lib/viewport.ts`, not an in-page `.click()`:
 * measured on the first MCP-W2 run, a synthetic click removed the card from the
 * DOM and left the request UNANSWERED in the backend — "the card is gone but
 * the backend still waits", which is the divergence a case is least able to
 * notice. The point is hit-tested first, because a coordinate click dies
 * silently under an overlay while key events keep working.
 */
export async function answerAskUserOption(
  session: CdpSession,
  label: string | RegExp,
  timeoutMs = 120_000,
): Promise<AskUserAnswered> {
  const card = await waitForAskUserCard(session, timeoutMs)
  const matches = (option: string): boolean =>
    typeof label === 'string' ? option === label : label.test(option)
  const index = card.options.findIndex(matches)
  if (index < 0) {
    throw new Error(
      `ask-user-option-absent: no option matching ${String(label)} on the card. `
      + `Options: ${JSON.stringify(card.options)}; every button: ${JSON.stringify(card.allButtons)}; `
      + `question: ${JSON.stringify(card.question.slice(0, 200))}`,
    )
  }

  const point = await session.call<{ x: number; y: number; covered: string | null }>(`
    const visible = el => {
      const style = window.getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0
    }
    const buttons = Array.from(document.querySelectorAll(${JSON.stringify(OPTION_BUTTONS)})).filter(visible)
    const button = buttons[${index}]
    if (!button) throw new Error('ask-user-option-vanished: index ${index} of ' + buttons.length)
    const rect = button.getBoundingClientRect()
    const x = Math.round(rect.x + rect.width / 2)
    const y = Math.round(rect.y + rect.height / 2)
    const hit = document.elementFromPoint(x, y)
    const covered = !hit ? 'nothing-at-point'
      : (button.contains(hit) || hit.contains(button)) ? null
      : hit.tagName + '.' + String(hit.className).slice(0, 80)
    return { x, y, covered }
  `)
  if (point.covered) {
    throw new Error(
      `ask-user-option-covered: the "${card.options[index]}" button at (${point.x},${point.y}) is under `
      + `${point.covered} — an overlay would eat this click silently`,
    )
  }
  await clickAt(session, { x: point.x, y: point.y }, `ask_user option "${card.options[index]}"`)
  return { card, clicked: card.options[index]! }
}

export interface AskUserWatcher {
  /** Stop watching and return every card this watcher answered, in order. */
  stop: () => Promise<AskUserAnswered[]>
  /** Cards seen so far, including any it could not answer. */
  readonly seen: AskUserCard[]
}

/**
 * Answer ask_user cards for as long as a turn is in flight.
 *
 * A turn parked on an unanswered dialog NEVER ENDS, so a case that awaits its
 * own turn cannot answer the card afterwards and its turn timeout cannot save it
 * either — measured on the first MCP-W2 run, where a Pi turn sat in
 * `toolStatus: "executing"` for ten minutes behind an unanswered card. This runs
 * underneath the turn.
 *
 * `answer` picks the option for each card it meets, by index of appearance, so a
 * multi-dialog flow (URL mode asks twice: open, then confirm) can be driven
 * without racing. Returning `undefined` leaves that card alone.
 *
 * ## Three loop hazards, and what each costs if you get it wrong
 *
 * - **Answering the same card twice.** A click and the card's removal are not
 *   simultaneous, so the next poll can still see a card that has been answered.
 *   Handled by waiting for the card to GO — not by remembering it forever, which
 *   would silently refuse to answer a legitimately repeated question and hang
 *   the turn that asked it.
 * - **A card this watcher does not want.** Recorded once and then skipped, so an
 *   unanswerable dialog cannot fill `seen` with thousands of copies of itself.
 * - **A click that fails.** Un-seen, so the next poll retries it. The
 *   alternative — one attempt per card — turns a transient overlay into a turn
 *   that never ends and a case that reports a product defect for it.
 */
export function answerAskUserWhile(
  session: CdpSession,
  answer: (card: AskUserCard, index: number) => string | RegExp | undefined,
  options: { intervalMs?: number } = {},
): AskUserWatcher {
  const signatureOf = (card: AskUserCard): string => `${card.question}::${card.options.join('|')}`
  const seen: AskUserCard[] = []
  const answered: AskUserAnswered[] = []
  const declined = new Set<string>()
  let running = true
  const loop = (async () => {
    while (running) {
      await Bun.sleep(options.intervalMs ?? 1_000)
      const card = await readAskUserCard(session).catch(() => EMPTY)
      if (!card.present || card.options.length === 0) continue
      const signature = signatureOf(card)
      if (declined.has(signature)) continue
      const wanted = answer(card, seen.length)
      seen.push(card)
      if (wanted === undefined) {
        declined.add(signature)
        continue
      }
      const result = await answerAskUserOption(session, wanted, 30_000).catch(() => undefined)
      if (!result) {
        seen.pop()
        continue
      }
      answered.push(result)
      // Wait for the answered card to leave the screen (or be replaced by a
      // different question) before polling again, so the click that has already
      // landed cannot be delivered a second time.
      await waitFor(
        () => readAskUserCard(session).catch(() => EMPTY),
        current => !current.present || signatureOf(current) !== signature,
        { timeoutMs: 20_000, intervalMs: 500, label: 'the answered ask_user card to clear' },
      ).catch(() => undefined)
    }
  })()
  return {
    seen,
    stop: async () => {
      running = false
      await loop
      return answered
    },
  }
}

// ---------------------------------------------------------------------------
// The OTHER card
// ---------------------------------------------------------------------------

/** `PermissionRequest`'s own Allow button — never the ask_user card's options. */
const PERMISSION_ALLOW = '[data-tutorial="permission-allow-button"]'

/** The tool-permission card. TWO elements match it for ONE card — see below. */
export const PERMISSION_BANNER = '[data-tutorial="permission-banner"]'

export interface CardButtonHit {
  /** Centre of the button's own box in CSS pixels, ready for `clickAt`. */
  x: number
  y: number
  /** The button's text as rendered. */
  text: string
  /** Its position among the VISIBLE buttons — never among all matches. */
  index: number
  /** Every visible button's label, in order: the evidence for a miss. */
  labels: string[]
  /** Whether a label matched, or the fallback picked the last visible button. */
  matched: boolean
}

export interface FindCardButtonOptions {
  /** The card to look inside. Defaults to the tool-permission banner. */
  card?: string
  /**
   * The buttons themselves, when the product gives them their own hook.
   * Overrides `card` entirely — `[data-tutorial="permission-allow-button"]` IS
   * the button, so appending ` button` to it would match nothing.
   */
  buttons?: string
  /** Labels to match, case-insensitively, after trimming. */
  labels: readonly string[]
  /** `exact` (default) or `prefix` — `prefix` matches a label that STARTS with one. */
  match?: 'exact' | 'prefix'
  /** Which match to take when several agree. `last` is the innermost copy. */
  prefer?: 'first' | 'last'
  /** Take the last VISIBLE button when no label matched. Off by default. */
  fallbackToLastVisible?: boolean
}

/**
 * One card button, found BY LABEL among the VISIBLE copy, with its own rect
 * (C3.374 — R6b's PR-R6B-5).
 *
 * Three cases had written this three ways — `rs-13.ts` `denyCard`, `rs-36.ts`
 * `alwaysAllow`, `rs-38.ts` `answerCard` — and each of the three had paid for a
 * different half of the same page. The three readings, each measured on a
 * packaged build in September 2026, are now in ONE place:
 *
 * 1. **TWO elements match the card selector for ONE card.** `InputContainer`
 *    renders a `visibility: hidden` measuring copy FIRST and it keeps its box,
 *    so no zero-size guard fires (trap 1 at the top of this file). Every button
 *    therefore appears twice, a positional index over the unfiltered list means
 *    nothing, and a click at such an index answers nothing: RS-13 reported *"the
 *    card did NOT clear"* on 4 of 6 arms in one run and 3 of 6 in the next for
 *    exactly this reason (RV, 1.37.0, 2026-09-12). So the filter is not a
 *    nicety — it is the difference between a readable arm and an unreadable one.
 * 2. **The label list is not stable within a turn.** Measured 2026-09-12 on one
 *    rig: `["Allow","Always Allow","Deny","Add a note"]` at one moment and
 *    `["Allow","Yes, and switch to auto mode","Always Allow","Deny","Add a
 *    note"]` seconds later, because the auto-mode option renders late. A rect
 *    computed from an index read EARLIER lands on a different button — which is
 *    why the decision and the coordinates are taken in the SAME page evaluation
 *    here and never across two calls.
 * 3. **"the last button" is not the refusing control.** RS-13's old heuristic
 *    clicked *Add a note*, which answers nothing; the turn then sat to its 240 s
 *    ceiling and the card was still up when the NEXT arm ran, so one mis-aimed
 *    click corrupted two arms (R1, 1.36.0, 2026-09-12). The fallback is
 *    therefore OPT-IN and `matched` says which rule produced the hit, so a
 *    caller can report a fallback rather than bank it as an answer.
 *
 * Returns `null` when the card is absent or no rule produced a button; `labels`
 * on a hit is what a caller observes when the click does not do what it hoped.
 */
export async function findCardButton(
  session: CdpSession,
  options: FindCardButtonOptions,
): Promise<CardButtonHit | null> {
  // A page error is "no button", never a throw: every caller is mid-turn and a
  // card that vanished between the count and the read is the ordinary case.
  return session.call<CardButtonHit | null>(cardButtonScript(options)).catch(() => null)
}

/**
 * The page-side body {@link findCardButton} evaluates, as a string.
 *
 * Separated for ONE reason: it is the only way this selection can be tested
 * without an app. `harness.test.ts` runs it against a hand-built DOM carrying a
 * `visibility: hidden` copy in front of the visible one — which is the trap the
 * three cases each paid for — so the filter, the label rule and the opt-in
 * fallback have a positive and a negative arm offline. A helper whose whole
 * value is a predicate no test can reach is a predicate that drifts.
 */
export function cardButtonScript(options: FindCardButtonOptions): string {
  const selector = options.buttons ?? `${options.card ?? PERMISSION_BANNER} button`
  const wanted = options.labels.map(label => label.trim().toLowerCase())
  return `
    const visible = el => {
      const style = window.getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0
    }
    const shown = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(visible)
    const labels = shown.map(b => (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim())
    const wanted = ${JSON.stringify(wanted)}
    const hits = []
    for (let i = 0; i < labels.length; i += 1) {
      const text = labels[i].toLowerCase()
      const hit = ${options.match === 'prefix' ? 'wanted.some(w => text.startsWith(w))' : 'wanted.includes(text)'}
      if (hit) hits.push(i)
    }
    let index = hits.length === 0 ? -1 : ${options.prefer === 'last' ? 'hits[hits.length - 1]' : 'hits[0]'}
    const matched = index >= 0
    if (index < 0 && ${options.fallbackToLastVisible === true} && shown.length > 0) index = shown.length - 1
    if (index < 0) return null
    const rect = shown[index].getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      text: labels[index],
      index,
      labels,
      matched,
    }
  `
}

/**
 * D1.347 — what the approver's poll SAW, because its count of zero has three
 * causes and only one of them is "nothing asked".
 *
 * `stop()` answers a number of approvals, and SIT-5f lost three drives of RS-86
 * to the fact that a zero is produced identically by *no card appeared* and *a
 * card appeared and the count cannot see it*. Measured twice on the packaged
 * 1.40.0: a plugin COMMAND hook's permission card sat on screen with its
 * `Allow once` button visible and clickable while all four sessions read
 * `awaitingApprovalCount: 0`, so this loop never clicked and the turn wedged for
 * 180 s and then 300 s — with the control that a hand click at the same moment
 * ran the hook within seconds. D1.346 is the host-side repair for THAT class and
 * it landed in `3725e0fbb`, which does not retire this record: the artefact the
 * sittings drive predates it, and the next uncounted class will read the same.
 * The instrument's job either way is to say it is BLIND rather than to report a
 * zero that reads as a product answer.
 *
 * The same shape as `lib/state.ts`'s `readFailed` (D1.265/D1.287), and the
 * reason it is a RECORD here rather than a `blocked()` is that this loop runs
 * UNDERNEATH a turn nobody is awaiting: a block raised from a detached poll
 * would discard a run over a card that may never have mattered.
 *
 * `counted` is the positive control — without it, a run with zero polls and a
 * run that polled fifty quiet screens are the same three zeros.
 */
export interface PermissionApproverReads {
  /** Polls that completed, whatever they read. */
  polls: number
  /** Polls that read a real number off the session. The positive control. */
  counted: number
  /** Polls whose count read THREW. The count is unknown, never zero. */
  readFailed: number
  /** Polls where `getSessions()` answered without this session in it. */
  sessionUnseen: number
  /** Polls that read 0 while the Allow button this loop clicks was VISIBLE. */
  blind: number
  /** The distinct labels those visible-but-uncounted buttons carried. */
  blindLabels: string[]
  /** Cards this approver actually answered. Mirrors `stop()`'s number. */
  approved: number
}

/**
 * D1.347 — the one sentence that separates a zero from a blindness, or nothing.
 *
 * Its own function so the words are pinned by `harness.test.ts` offline: the
 * loop that produces them needs an app, and a sentence no test can reach is a
 * sentence that drifts into saying the opposite.
 */
export function approverBlindnessNote(reads: PermissionApproverReads): string | undefined {
  const unread = reads.readFailed + reads.sessionUnseen
  if (reads.blind === 0 && unread === 0) return undefined
  const parts: string[] = []
  if (reads.blind > 0) {
    parts.push(
      `${reads.blind} of ${reads.polls} poll(s) read awaitingApprovalCount 0 while a VISIBLE Allow `
      + `button was on screen (${reads.blindLabels.join(', ') || 'no label read'}) — the count did `
      + 'not see that card, so this approver was BLIND, not idle (a command hook\'s card was the '
      + 'measured class; D1.346 repaired that one host-side)',
    )
  }
  if (unread > 0) {
    parts.push(
      `${unread} of ${reads.polls} poll(s) could not READ the count `
      + `(${reads.readFailed} threw, ${reads.sessionUnseen} found no such session) — those polls are `
      + 'unknown, not zero',
    )
  }
  return `approvePermissionsWhile: ${parts.join('; ')}. It approved ${reads.approved}.`
}

/**
 * D1.356 — the claim-side half of D1.347, and the reason it is a BLOCK.
 *
 * {@link approverBlindnessNote} puts the blindness on stderr, where it is one
 * line among a case's hundreds; ten call sites went on banking `stop()`'s zero
 * as *"nothing asked"* while the note beside it said the count could not see.
 * A sentence a reader has to notice is not an instrument. This one refuses.
 *
 * THREE clauses, and the third is deliberately narrower than the other two:
 *
 *  1. **`counted === 0`** — the loop never read the count successfully at all,
 *    so its zero is the absence of a READING and not the absence of a card.
 *    `counted` is this instrument's own positive control (the interface's
 *    docblock says so), and a control at zero is what `null-by-artefact` and
 *    `control-failed` are elsewhere in this harness: not an answer.
 *  2. **`blind > 0`** — a card's Allow button was VISIBLE on the very poll that
 *    read zero, computed from the same {@link FindCardButtonOptions} the click
 *    uses so the two cannot describe different buttons. This is the measured
 *    class (SIT-5f, packaged 1.40.0, twice: a plugin command hook's card sat
 *    unanswered and the turn wedged for 180 s and then 300 s), and it blocks
 *    even when other cards WERE approved — the wedge is about the card nobody
 *    counted, not about the ones that worked.
 *  3. **`readFailed + sessionUnseen > 0` AND `approved === 0`** — part of the
 *    window is unreadable and the case has no positive reading to stand on. It
 *    is narrowed by `approved === 0` on purpose: with approvals recorded the
 *    claim rests on what the loop DID, which no unreadable poll manufactures,
 *    and a guard that discards such a run over one transient throw is a guard
 *    the next operator routes around. The cost of the narrowing is stated
 *    rather than hidden: a card raised and withdrawn entirely inside an
 *    unreadable stretch of a run that also approved something else is not
 *    caught, and nothing here can catch it without knowing when the card was up
 *    — which is exactly what the unreadable poll withheld.
 *
 * Returns the sentence, or `undefined` when the readings can carry a claim.
 */
export function approverClaimBlockReason(reads: PermissionApproverReads): string | undefined {
  if (reads.counted === 0) {
    return 'approvePermissionsWhile never read the permission count ONCE '
      + `(${reads.polls} poll(s): ${reads.readFailed} threw, ${reads.sessionUnseen} found no such `
      + 'session, 0 counted). Its zero is the absence of a reading, not the absence of a card, and '
      + '`counted` is this instrument\'s own positive control. Re-run with the session in the list '
      + '— a turn shorter than one poll interval reads identically.'
  }
  if (reads.blind > 0 || (reads.readFailed + reads.sessionUnseen > 0 && reads.approved === 0)) {
    return `${approverBlindnessNote(reads) ?? 'approvePermissionsWhile could not account for its own polls.'} `
      + 'This case\'s claim rests on that count, so the run is BLOCKED rather than banked (D1.356).'
  }
  return undefined
}

export interface PermissionApprover {
  stop: () => Promise<number>
  /**
   * D1.347 — live, and readable after `stop()`. `stop()` keeps returning the
   * approval COUNT because every one of its call sites is a case file, and the
   * cases are another lane's zone this wave; a caller whose claim depends on the
   * zero meaning "nothing asked" reads this instead, and every caller gets the
   * {@link approverBlindnessNote} line on stderr for free.
   */
  readonly reads: PermissionApproverReads
}

/**
 * Approve ordinary tool-permission cards while a turn is in flight.
 *
 * Every MCP tool call is classified `mcp_mutation` and asks. A case about
 * naming, or about elicitation, is not a case about the permission prompt
 * (AGT-3 owns that), so it takes `bypassPermissions` and keeps this running
 * underneath as a net for anything the mode does not cover.
 *
 * Driven from `Session.awaitingApprovalCount` — derived at read time from the
 * live pending map, so it cannot go stale — and answered with a REAL mouse
 * click. A raw in-page `.click()` is not the same thing: measured on the first
 * MCP-W2 run, one removed both cards from the DOM and left the request
 * unanswered in the backend.
 *
 * **NOT STALE IS NOT THE SAME AS COMPLETE, and the sentence above was read as if
 * it were.** The count is derived live and is still blind to a card class: a
 * plugin COMMAND hook's permission card is on screen, clickable, and counted by
 * nobody (SIT-5f, packaged 1.40.0, twice). So the loop below records
 * {@link PermissionApproverReads} beside the approvals and says on stderr when
 * it polled a zero with the Allow button in front of it — because three drives
 * were spent reading this helper's zero as the product's answer.
 *
 * **It must never touch the ask_user card.** That card is a question, and
 * clicking an arbitrary option on it would answer an MCP server on the user's
 * behalf — which is exactly the thing the elicitation cases are measuring. The
 * selector above is the tool-permission card's own Allow button and matches
 * nothing inside `[data-tutorial="ask-user-banner"]`.
 */
export function approvePermissionsWhile(
  session: CdpSession,
  sessionId: string,
  options: { intervalMs?: number } = {},
): PermissionApprover {
  const reads: PermissionApproverReads = {
    polls: 0, counted: 0, readFailed: 0, sessionUnseen: 0, blind: 0, blindLabels: [], approved: 0,
  }
  // The button this loop would click, computed ONCE so the blind probe below and
  // the click below it cannot describe different buttons — which is the whole
  // strength of the blind reading: the count said zero about the very button
  // that was on screen.
  const allowButton: FindCardButtonOptions = {
    buttons: PERMISSION_ALLOW, labels: ['allow'], match: 'prefix', fallbackToLastVisible: true,
  }
  let running = true
  const loop = (async () => {
    while (running) {
      await Bun.sleep(options.intervalMs ?? 2_000)
      reads.polls += 1
      // `null` for "the session is not in the list" and for "the field is not a
      // number", so the two unreadable shapes stop arriving as the same 0 the
      // quiet screen produces. `rs-38.ts` and `rs-12.ts` reached for `-1` here
      // for the same reason, each in its own case file.
      const waiting = await session.call<number | null>(`
        const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(sessionId)})
        return s && typeof s.awaitingApprovalCount === 'number' ? s.awaitingApprovalCount : null
      `).catch(() => undefined)
      if (waiting === undefined) { reads.readFailed += 1; continue }
      if (waiting === null) { reads.sessionUnseen += 1; continue }
      reads.counted += 1
      if (waiting < 1) {
        // D1.347 — one extra page read on the poll this loop already runs, and
        // it is the difference between "nothing asked" and "I cannot see what
        // asked". It does NOT click: answering a card the count cannot see would
        // change what ten live cases do, and the count-independent approver is
        // RS-86's `answerHookCardsWhile`. Reporting is this row; counting the
        // card was D1.346's, host-side.
        const unseen = await findCardButton(session, allowButton)
        if (unseen) {
          reads.blind += 1
          if (!reads.blindLabels.includes(unseen.text)) reads.blindLabels.push(unseen.text)
        }
        continue
      }
      // The VISIBLE Allow, addressed by its own rect — never `clickSelector`,
      // which takes the FIRST match and the first match is the `visibility:
      // hidden` measuring copy (trap 1, and C3.374: this loop computed exactly
      // this predicate to COUNT and then clicked without it).
      const hit = await findCardButton(session, allowButton)
      if (!hit) continue
      await clickAt(session, { x: hit.x, y: hit.y }, 'the permission card\'s Allow').catch(() => undefined)
      reads.approved += 1
    }
  })()
  return {
    reads,
    stop: async () => {
      running = false
      await loop
      const note = approverBlindnessNote(reads)
      // stderr, which is where `CaseRun.observe` and `check` already write, so
      // the sentence lands in every existing case's log with no case edit.
      if (note !== undefined) console.error(`  · ${note}`)
      return reads.approved
    },
  }
}


/**
 * D1.356 — observe what the approver saw, and BLOCK when it cannot carry the
 * case's claim. The `requireArtifactCarries` shape, for the same reason: a
 * reading that has to be noticed is a reading that gets missed.
 *
 * Call it at the CLAIM, never inside a `finally` that can run with an error in
 * flight — {@link blocked} throws, and a throw from a `finally` replaces the
 * real failure with a block that names the wrong thing. Every converted site
 * keeps its `await approver.stop()` where it was (the loop must be stopped even
 * when the turn threw, or its clicks land in the NEXT turn's count) and calls
 * this afterwards; `reads` is live and stays readable after `stop()`.
 */
export function requireApproverSaw(run: CaseRun, approver: PermissionApprover, label: string): void {
  run.observe(`${label}: what the approver saw`, approver.reads)
  const reason = approverClaimBlockReason(approver.reads)
  if (reason !== undefined) blocked(`${label} — ${reason}`)
}
